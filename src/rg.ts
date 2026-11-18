import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { rgPath } from '@vscode/ripgrep';
import { pathFilter } from './glob.js';
import { namesGitDir } from './paths.js';

/**
 * The bundled ripgrep, read the way an agent needs it: at most MAX_MATCHES lines, always
 * the same ones for the same query, and a sentence saying what to do when there were more.
 *
 * ripgrep is streamed and stopped as soon as the cap is reached. Collecting its whole
 * output first would hold a broad query across a large folder in memory and, past any
 * buffer limit, turn a search that matched too much into an error.
 *
 * A client's glob is applied here, to the paths ripgrep returns, rather than passed to
 * ripgrep as `-g`: ripgrep's globs override its ignore rules, so `-g '*'` would widen a
 * search into .git, node_modules and every gitignored file. Filtering afterwards means a
 * glob can only ever narrow what a plain search covers.
 */

export const MAX_MATCHES = 100;

/** Long enough for a full scan of a large collection; short enough that a stuck call ends. */
export const SEARCH_TIMEOUT_MS = 30_000;

/** Stderr kept for an error message; ripgrep can print one line per unreadable file. */
const MAX_STDERR = 4096;

export interface ScopeOptions {
  /**
   * Folders under the search root to leave out, as root-relative paths such as `beta` or
   * `repos/beta` — excluded repos, or their docs. Compared without regard to case: on
   * Windows and macOS, "Beta" and "beta" are the same folder. Checked directly, not as a
   * glob, so any number of them costs the same.
   */
  excludeFolders?: readonly string[];
  /**
   * The root holds one folder per repo: match the glob against each path below its first
   * segment too, so `src/**` means "src in any repo".
   */
  globBelowTopLevel?: boolean;
  timeoutMs?: number;
  /** Cancels the search, for a client that gave up on the call. */
  signal?: AbortSignal;
}

export interface SearchOptions extends ScopeOptions {
  /** Only paths matching this glob (or, with a leading `!`, not matching it). */
  glob?: string;
  /** Search for the query exactly as written instead of as a regular expression. */
  literal?: boolean;
}

interface Capped {
  lines: string[];
  truncated: boolean;
  timedOut: boolean;
  /** ripgrep could not read some files, so they were not searched. */
  unreadable: boolean;
}

/** A file ripgrep could not read: one stderr line each, while it searches everything else. */
const UNREADABLE_FILE = /\(os error \d+\)\s*$/m;

/**
 * Why ripgrep refused the request itself, as an error for the caller — or null when stderr
 * only names files it could not read, which it reports one line each, ending
 * "(os error N)", while it goes on searching everything else. Those lines are left out
 * before looking, so a file called unclosed-tag.html cannot pass for a broken query.
 */
export function requestError(stderr: string): string | null {
  const request = stderr
    .split(/\r?\n/)
    .filter((line) => !UNREADABLE_FILE.test(line))
    .join('\n')
    .trim();
  if (/regex parse error/i.test(request)) {
    return `The query is not a valid regular expression. Escape characters such as ( [ { . * + ? |, or pass literal: true to search for the text exactly as written.\n${request}`;
  }
  if (/is not allowed in a regex/i.test(request)) {
    return `ripgrep matches one line at a time, so a query cannot span a line break. Search for one line of the text.\n${request}`;
  }
  if (/exceeds size limit/i.test(request)) {
    return `The query is too large a pattern to compile (ripgrep's size limit). Simplify the repetition in it, or pass literal: true.\n${request}`;
  }
  if (/error parsing glob|unrecognized|invalid value|unclosed/i.test(request)) {
    return `ripgrep failed: ${request}`;
  }
  return null;
}

/** One record of ripgrep's `--null` output. */
export interface RgRecord {
  file: string;
  /** `line:text` for a search; null for a file listing. */
  rest: string | null;
}

/**
 * Reads ripgrep's `--null` output one record at a time. A search record is `path\0line:text`
 * and ends at a newline; a listing record is `path` and ends at a NUL. Linux and macOS allow
 * a newline inside a file name, and in search output that splits the name across records:
 * its tail would read as a path of its own — in another repo, past any exclusion. So a name
 * with a line break is skipped in both modes; it could not be printed one per line anyway.
 */
export function recordReader(mode: 'search' | 'files'): (record: string) => RgRecord | null {
  let insideBrokenName = false;
  return (record) => {
    if (mode === 'files') return /[\r\n]/.test(record) ? null : { file: record, rest: null };
    const nul = record.indexOf('\0');
    if (nul === -1) {
      insideBrokenName = true; // the start of a name that has a newline in it
      return null;
    }
    if (insideBrokenName) {
      insideBrokenName = false; // that name's last part, not a file of its own
      return null;
    }
    const file = record.slice(0, nul);
    return file.includes('\r') ? null : { file, rest: record.slice(nul + 1) };
  };
}

interface RunSpec {
  args: string[];
  cwd: string;
  /** `--null` output: 'search' is `path\0line:text\n`, 'files' is `path\0`. */
  mode: 'search' | 'files';
  keep: (path: string) => boolean;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

function runCapped(spec: RunSpec): Promise<Capped> {
  return new Promise((resolve, reject) => {
    if (spec.signal?.aborted === true) {
      reject(new Error('Search cancelled.'));
      return;
    }
    const child = spawn(rgPath, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines: string[] = [];
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let pending = '';
    let stderr = '';
    const separator = spec.mode === 'search' ? '\n' : '\0';

    const stop = (): void => {
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const read = recordReader(spec.mode);
    const take = (record: string): void => {
      if (truncated || record.length === 0) return;
      const parsed = read(record);
      if (parsed === null) return;
      let file = parsed.file;
      const rest = parsed.rest;
      if (file.startsWith('./')) file = file.slice(2); // a model wants 'src/x.ts', the same on every OS
      if (!spec.keep(file)) return;
      if (lines.length === MAX_MATCHES) {
        truncated = true;
        stop();
        return;
      }
      lines.push(rest === null ? file : `${file}:${rest}`);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      pending += chunk;
      for (let at = pending.indexOf(separator); at !== -1; at = pending.indexOf(separator)) {
        take(pending.slice(0, at).replace(/\r$/, ''));
        pending = pending.slice(at + 1);
        if (truncated) break;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (cancelled) {
        reject(new Error('Search cancelled.'));
        return;
      }
      if (!truncated && !timedOut) take(pending.replace(/\r$/, ''));
      if (truncated || timedOut || code === 0 || code === 1) {
        resolve({ lines, truncated, timedOut, unreadable: UNREADABLE_FILE.test(stderr) });
        return;
      }
      // Exit 2 also covers "matched, but some files could not be read": keep the matches.
      const problem = requestError(stderr);
      if (problem === null) {
        resolve({ lines, truncated, timedOut, unreadable: UNREADABLE_FILE.test(stderr) });
        return;
      }
      reject(new Error(problem));
    });
  });
}

function render(result: Capped, what: string, timeoutMs: number): string {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(
      `… showing the first ${MAX_MATCHES} ${what}, in path order. There are more: narrow with "repo", "glob" or a more specific query. A capped result cannot show that something is absent.`,
    );
  }
  if (result.timedOut) {
    notes.push(
      `… the search was stopped after ${Math.max(1, Math.round(timeoutMs / 1000))} s before it finished, so it may have missed ${what}; narrow it with "repo" or "glob".`,
    );
  }
  if (result.unreadable) {
    notes.push(
      `… some files could not be read (permissions or a lock), so they were not searched.`,
    );
  }
  if (result.lines.length === 0)
    return notes.length === 0 ? 'No matches.' : ['No matches.', ...notes].join('\n');
  return [result.lines.join('\n'), ...notes].join('\n');
}

/**
 * Common flags: path-sorted for determinism, forward slashes, NUL after each path, and never
 * `.git`. ripgrep skips hidden folders, but searches one that an ignore file whitelists — and
 * a studied repository writes its own ignore files. An override glob outranks them all.
 */
const BASE = ['--sort=path', '--path-separator', '/', '--null', '--glob', '!.git'];

function scopeFilter(glob: string | undefined, opts: ScopeOptions): (path: string) => boolean {
  const globMatches = pathFilter(glob, { belowTopLevel: opts.globBelowTopLevel === true });
  // The same judgement read_repo_file makes, in case anything reaches past the override.
  const matches = (p: string): boolean => !namesGitDir(p) && globMatches(p);
  const excluded = new Set(
    (opts.excludeFolders ?? []).map((f) => f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()),
  );
  if (excluded.size === 0) return matches;
  const insideExcluded = (p: string): boolean => {
    const segments = p.toLowerCase().split('/');
    // Every folder above the file: "repos", "repos/beta", … — one set lookup each.
    for (let depth = 1; depth < segments.length; depth++) {
      if (excluded.has(segments.slice(0, depth).join('/'))) return true;
    }
    return false;
  };
  return (p) => !insideExcluded(p) && matches(p);
}

function requireFolder(root: string): void {
  if (!fs.existsSync(root)) throw new Error(`The folder to search does not exist: ${root}`);
}

export async function searchText(
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<string> {
  requireFolder(root);
  const args = [...BASE, '-n', '--no-heading', '-S', '--max-columns', '250'];
  if (opts.literal === true) args.push('-F');
  // The explicit '.' is load-bearing: with no path and a piped stdin, rg reads stdin and
  // waits forever. '--' keeps a query that starts with a dash from being read as a flag.
  args.push('--', query, '.');
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const result = await runCapped({
    args,
    cwd: root,
    mode: 'search',
    keep: scopeFilter(opts.glob, opts),
    timeoutMs,
    signal: opts.signal,
  });
  return render(result, 'matches', timeoutMs);
}

export async function listFiles(
  root: string,
  pattern: string,
  opts: ScopeOptions = {},
): Promise<string> {
  requireFolder(root);
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const result = await runCapped({
    args: [...BASE, '--files', '.'],
    cwd: root,
    mode: 'files',
    keep: scopeFilter(pattern, opts),
    timeoutMs,
    signal: opts.signal,
  });
  return render(result, 'files', timeoutMs);
}
