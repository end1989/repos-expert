import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { isDriveRelative, isInside, namesGitDir, resolveReal } from '../paths.js';
import { couldMatchFolder, globProblem as unreadableGlob, matchesGlob } from '../glob.js';

/**
 * The curator's reach, enforced in code rather than requested in the prompt.
 *
 * The agent reads repositories nobody has vetted, so anything a file tells it to do
 * has to be assumed hostile. Restricting it to Read, Glob and Grep stops it from
 * changing anything; this module stops those three from being pointed somewhere
 * else on the machine — an SSH key or a cloud credential read "for context" would
 * otherwise end up quoted in a document that gets served and committed.
 */

/** The only tools the curator has. Everything else is refused, whatever the session offers. */
export const CURATOR_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export type CuratorTool = (typeof CURATOR_TOOLS)[number];

export type ToolDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: ToolDecision = { allowed: true };
const deny = (reason: string): ToolDecision => ({ allowed: false, reason });

function isCuratorTool(name: string): name is CuratorTool {
  return (CURATOR_TOOLS as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Longer than any real path: past this a path is a mistake, or an attempt to stall the hook. */
const MAX_PATH_LENGTH = 4096;

/**
 * The path the agent runtime will actually use. For Grep and Glob it trims what it was sent
 * and expands `~` after this hook has seen the input (Read's file_path arrives already
 * expanded), and on Windows it reads a Git Bash drive path `/c/x` as `C:\x`. Judging the
 * input as sent would judge a different path from the one that gets searched.
 */
function asRuntimeWillUse(p: string): string {
  const trimmed = p.trim();
  if (process.platform === 'win32') {
    const bash = /^\/([A-Za-z])(\/.*)?$/.exec(trimmed);
    if (bash !== null) {
      const drive = (bash[1] ?? '').toUpperCase();
      return `${drive}:${(bash[2] ?? '/').replace(/\//g, '\\')}`;
    }
  }
  return trimmed;
}

/** `~` and `~/…` are the runtime's to expand, into the home folder; `~archive` is a name. */
function isHomeRelative(p: string): boolean {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\');
}

/**
 * A network path, `\\host\share` or `//host/share`. Resolving one makes Windows connect to that host and
 * offer it the user's NTLM credentials, so it is refused before anything resolves it.
 */
function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Where a path really is, once judged allowed; or why it is not. */
type Located = { real: string } | { problem: string };

/**
 * Judges one path and, if it is allowed, says where it really is. `excluded` names repos in
 * the folder (the portfolio pass studies a folder of repos) that must stay out of reach.
 */
function locate(
  repoRoot: string,
  realRoot: string,
  given: string,
  excluded: ReadonlySet<string>,
): Located {
  if (given.length > MAX_PATH_LENGTH) return { problem: 'the path is longer than any real path' };
  const outside = { problem: `"${given}" is outside the repository being studied` };
  const p = asRuntimeWillUse(given);
  if (isHomeRelative(p) || isDriveRelative(p) || isNetworkPath(p)) return outside;
  // Contained as written before anything is resolved: nothing outside is ever touched.
  const lexical = path.resolve(repoRoot, p);
  if (!isInside(path.resolve(repoRoot), lexical) && !isInside(realRoot, lexical)) return outside;
  const real = resolveReal(lexical);
  if (!isInside(realRoot, real)) return outside;
  // Judged as written and where it lands, so a link or a short name cannot reach .git either.
  // Always on repo-relative paths: a drive letter's colon is not a stream.
  if (
    namesGitDir(path.relative(path.resolve(repoRoot), lexical)) ||
    namesGitDir(path.relative(realRoot, real))
  ) {
    return { problem: `"${given}" is inside .git, which is not part of the source` };
  }
  const repo = (path.relative(realRoot, real).split(path.sep)[0] ?? '').toLowerCase();
  if (excluded.has(repo)) {
    return { problem: `"${given}" is in a repository that is excluded from study` };
  }
  return { real };
}

/** Characters that open a wildcard; a `]` or `}` alone is an ordinary character. */
const GLOB_MAGIC = /[*?[{]/;

/** Paths inside a .git folder, as a glob would be tested against them. */
const GIT_PROBES = ['.git', '.git/config', 'sub/.git/config'];

/** A piece starting with `!` only excludes, so it cannot bring anything back. */
const includes = (piece: string): boolean => piece.length > 0 && !piece.startsWith('!');

/**
 * The pieces a Grep glob reaches ripgrep as: the runtime splits it on whitespace, keeps a
 * word holding both `{` and `}` whole, splits every other word on commas, and passes each
 * piece as its own `--glob`.
 */
function piecesForRipgrep(glob: string): string[] {
  return glob
    .split(/\s+/)
    .flatMap((word) => (word.includes('{') && word.includes('}') ? [word] : word.split(',')))
    .filter(includes);
}

/**
 * Every way of reading a Grep glob: the pieces above, and the glob whole, by whitespace
 * alone, and by whitespace and every comma — so a runtime that split it another way would
 * meet a refusal too.
 */
function everyReading(glob: string): string[] {
  const readings = [glob, ...glob.split(/\s+/), ...glob.split(/[\s,]+/), ...piecesForRipgrep(glob)];
  return [...new Set(readings)].filter(includes);
}

/**
 * Whether a piece uses syntax that ripgrep and this check could read differently. The
 * runtime's ripgrep (14.1) drops a `}` that closes nothing, so `.gi}t` is `.git`; a [class]
 * holding `/` is one character to ripgrep (`[.-/]git` is `.git`) but is split at the slash
 * here, and one holding `,`, `{` or `}` is split or grouped differently; after a negation,
 * ripgrep reads the first `]` as a member (`[!]]` is "not ]", so `.gi[!]]` is `.git`) where
 * this matcher closes the class; versions disagree on an unclosed `{` or `[`. No glob anyone
 * means needs any of it. (Nested groups are left to the matcher, which refuses them with its
 * own reason.)
 */
function readsAmbiguously(piece: string): boolean {
  let depth = 0;
  for (let i = 0; i < piece.length; i++) {
    const c = piece[i];
    if (c === '[') {
      if (['!]', '^]'].includes(piece.slice(i + 1, i + 3))) return true;
      const end = piece.indexOf(']', i + 2);
      if (end === -1 || /[/\\,{}[]/.test(piece.slice(i + 1, end))) return true;
      i = end;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      if (depth === 0) return true;
      depth--;
    }
  }
  return depth > 0;
}

/**
 * Why a Grep glob could bring .git back into the search, or null. The runtime passes ripgrep
 * `--glob !.git` and then the caller's pieces, and in ripgrep the later glob wins: a piece
 * that matches a folder named .git, at any depth, lets the search into it — `*`, `{.git,x}`,
 * and `vendor/**`, which opens vendor/lib/.git. A backslash is an escape to ripgrep (`.gi\t`
 * is `.git`) but a folder separator to this matcher, so a glob holding one is refused rather
 * than misjudged; so is a piece this matcher cannot read, or could read differently.
 */
function grepGlobProblem(given: string): string | null {
  // As written: the runtime hands a Grep glob to ripgrep without trimming or expanding it.
  if (given.includes('\\')) {
    return `the pattern "${given}" contains "\\", which ripgrep reads as an escape, not a folder separator: write folders with "/"`;
  }
  if (piecesForRipgrep(given).some(readsAmbiguously)) {
    return `the pattern "${given}" has a } that closes nothing, an unclosed { or [, a [...] holding / , { or }, or one opening with !] or ^], which ripgrep and this check could read differently`;
  }
  for (const piece of everyReading(given)) {
    const unreadable = unreadableGlob(piece);
    if (unreadable !== null) return `the pattern "${given}" cannot be checked: ${unreadable}`;
    if (
      // A leading drive's colon is not a stream name, as in globProblem.
      namesGitDir(piece.replace(/^[A-Za-z]:(?=\/|$)/, '')) ||
      couldMatchFolder(piece, '.git') ||
      GIT_PROBES.some((probe) => matchesGlob(piece, probe))
    ) {
      return `the pattern "${given}" could let the search into a .git folder, which is not part of the source. To search a whole folder, give it as the path`;
    }
  }
  return null;
}

/**
 * The folder the runtime lists for an absolute pattern, or null for a relative one, which
 * only filters what lies under the search folder. The runtime cuts the pattern at the last
 * separator in front of its first wildcard, or takes the pattern's own folder when it has
 * none, and trims what it cut: so "<repo>/.. /*" lists the repository's parent.
 */
function absoluteGlobFolder(pattern: string): string | null {
  if (!path.isAbsolute(pattern)) return null;
  const wildcard = pattern.search(GLOB_MAGIC);
  if (wildcard === -1) return path.dirname(pattern);
  const cut = Math.max(pattern.lastIndexOf('/', wildcard), pattern.lastIndexOf('\\', wildcard));
  const folder = cut <= 0 ? path.parse(pattern).root : pattern.slice(0, cut);
  // "C:" alone is the current folder on drive C; the pattern meant the drive's root.
  return /^[A-Za-z]:$/.test(folder) ? `${folder}${path.sep}` : folder;
}

/**
 * A glob can leave the repository on its own: `../**`, or an absolute pattern. Any `..`
 * segment is refused outright; an absolute pattern is judged by the folder the runtime lists,
 * exactly as a `path` would be.
 */
function globProblem(
  repoRoot: string,
  realRoot: string,
  given: string,
  tool: CuratorTool,
  excluded: ReadonlySet<string>,
): string | null {
  if (given.length > MAX_PATH_LENGTH) return 'the pattern is longer than any real path';
  const glob = asRuntimeWillUse(given);
  const segments = glob.split(/[\\/]/);
  const outside = `the pattern "${given}" reaches outside the repository being studied`;
  if (isHomeRelative(glob) || isDriveRelative(glob) || isNetworkPath(glob)) return outside;
  // `..`, also with trailing spaces or dots, which the runtime trims or Windows drops.
  if (segments.some((segment) => /^\.\.[\s.]*$/u.test(segment))) return outside;
  // A leading drive ("C:") is not a stream name; every other segment is checked.
  const tail = /^[A-Za-z]:$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  if (namesGitDir(tail.join('/'))) {
    return `the pattern "${given}" reaches into .git, which is not part of the source`;
  }
  if (tool === 'Grep') {
    const problem = grepGlobProblem(given);
    if (problem !== null) return problem;
  }
  const folder = absoluteGlobFolder(glob);
  if (folder === null) return null;
  const located = locate(repoRoot, realRoot, folder, excluded);
  if ('problem' in located) return `the pattern "${given}" lists a folder: ${located.problem}`;
  if (excluded.size > 0 && path.relative(realRoot, located.real) === '') {
    return `the pattern "${given}" covers a repository that is excluded from study`;
  }
  return null;
}

/**
 * Decides one tool call. Fails closed: an unknown tool, a missing path or a field of the
 * wrong type is refused rather than interpreted.
 */
export function checkToolCall(
  repoRoot: string,
  toolName: string,
  input: unknown,
  excludedRepos: readonly string[] = [],
): ToolDecision {
  if (!isCuratorTool(toolName)) {
    return deny(
      `${toolName} is not available: this agent can only use ${CURATOR_TOOLS.join(', ')}`,
    );
  }
  if (!isRecord(input)) return deny(`${toolName} was called without arguments`);
  const realRoot = resolveReal(repoRoot);
  const excluded = new Set(excludedRepos.map((name) => name.toLowerCase()));

  if (toolName === 'Read') {
    const file = input.file_path;
    if (typeof file !== 'string' || file.length === 0) return deny('Read needs a file_path');
    const located = locate(repoRoot, realRoot, file, excluded);
    return 'problem' in located ? deny(located.problem) : ALLOW;
  }

  // Glob and Grep default to the working directory, which is the repository.
  let searchRoot = realRoot;
  const dir = input.path;
  if (dir !== undefined) {
    if (typeof dir !== 'string') return deny(`${toolName} was given a path that is not a string`);
    const located = locate(repoRoot, realRoot, dir, excluded);
    if ('problem' in located) return deny(located.problem);
    searchRoot = located.real;
  }
  // A search of the whole folder would cover the excluded repos too.
  if (excluded.size > 0 && path.relative(realRoot, searchRoot) === '') {
    return deny(
      'some repositories in this folder are excluded from study: search one repository at a time, with a path inside it',
    );
  }
  const glob = toolName === 'Glob' ? input.pattern : input.glob;
  if (typeof glob === 'string') {
    const problem = globProblem(repoRoot, realRoot, glob, toolName, excluded);
    if (problem !== null) return deny(problem);
  }
  return ALLOW;
}

/**
 * The PreToolUse hook that applies `checkToolCall` to every call the agent makes. A hook
 * runs whatever the permission mode says, so this holds even if a later change to the
 * session options were to loosen them.
 */
export function confineToRepo(
  repoRoot: string,
  onDenied?: () => void,
  excludedRepos: readonly string[] = [],
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = checkToolCall(repoRoot, input.tool_name, input.tool_input, excludedRepos);
    if (decision.allowed) return {};
    onDenied?.();
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${decision.reason}. Stay inside the repository you were asked to study.`,
      },
    };
  };
}
