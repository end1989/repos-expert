import fs from 'node:fs';
import path from 'node:path';

/** One project the user wants on disk: where to clone from, and what to call it. */
export interface ReposListEntry {
  name: string;
  url: string;
}

export interface ParsedReposList {
  entries: ReposListEntry[];
  /** Lines that could not be used, described well enough to fix by hand. */
  problems: string[];
}

/** The file `expert init` drops beside the projects, so the list is where you look. */
export const REPOS_LIST_FILENAME = 'repos.txt';

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Transports git will accept. This is an allowlist on purpose: `ext::` hands git a
 * shell command to run, so a URL pasted from anywhere must not be able to reach it.
 */
const SCHEME = /^(https?|ssh|git|file):\/\//i;
const SCP_FORM = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(.+)$/;

function isSupportedUrl(url: string): boolean {
  if (url.startsWith('-')) return false; // never let a URL look like a git option
  return SCHEME.test(url) || SCP_FORM.test(url);
}

/** `owner/repo` is what GitHub's own UI shows, and what people paste. */
const GITHUB_SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function expandShorthand(value: string): string {
  const m = GITHUB_SHORTHAND.exec(value);
  return m === null ? value : `https://github.com/${m[1]}/${m[2]!.replace(/\.git$/i, '')}.git`;
}

/**
 * The folder name a clone would land in. Null when the URL has no usable path
 * segment, or when the segment is not a plain name — that check is what keeps a
 * crafted URL from writing outside the repos folder.
 */
export function repoNameFromUrl(url: string): string | null {
  const bare = url.split(/[?#]/)[0]!;
  let repoPath: string;
  const scp = SCP_FORM.exec(bare);
  if (SCHEME.test(bare)) {
    const afterScheme = bare.replace(SCHEME, '');
    const slash = afterScheme.indexOf('/');
    if (slash === -1) return null;
    repoPath = afterScheme.slice(slash + 1);
  } else if (scp !== null) {
    repoPath = scp[1]!;
  } else {
    return null;
  }
  const segment = repoPath.replace(/\/+$/, '').split('/').pop() ?? '';
  const name = segment.replace(/\.git$/i, '');
  if (name.length === 0 || !VALID_NAME.test(name) || name === '.' || name === '..') return null;
  return name;
}

/**
 * Plain text on purpose — it is meant to be opened in Notepad and edited. Blank
 * lines and `#` comments are ignored, so a file of nothing but instructions
 * parses as an empty list.
 */
export function parseReposList(text: string): ParsedReposList {
  const entries: ReposListEntry[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const lineNo = index + 1;

    let name: string | null;
    let url: string;
    const named = /^([^=\s]+)\s*=\s*(.+)$/.exec(line);
    if (named !== null) {
      name = named[1]!;
      url = expandShorthand(named[2]!.trim());
      if (!VALID_NAME.test(name) || name === '.' || name === '..') {
        problems.push(`line ${lineNo}: "${name}" is not a usable folder name (letters, digits, . _ - only)`);
        return;
      }
    } else {
      url = expandShorthand(line);
      name = repoNameFromUrl(url);
    }

    if (!isSupportedUrl(url)) {
      problems.push(`line ${lineNo}: "${url}" is not a git URL I will clone (https, ssh, git, or user@host:path)`);
      return;
    }
    if (name === null) {
      problems.push(`line ${lineNo}: cannot work out a folder name from "${url}" — write it as "name = ${url}"`);
      return;
    }
    const already = seen.get(name);
    if (already !== undefined) {
      problems.push(`line ${lineNo}: "${name}" is already listed as ${already} — keeping the first one`);
      return;
    }
    seen.set(name, url);
    entries.push({ name, url });
  });

  return { entries, problems };
}

/** A missing list is not an error — plenty of people just copy folders in. */
export function readReposList(file: string): ParsedReposList {
  if (!fs.existsSync(file)) return { entries: [], problems: [] };
  return parseReposList(fs.readFileSync(file, 'utf8'));
}

export interface AddResult {
  added: ReposListEntry[];
  alreadyListed: string[];
  problems: string[];
}

/**
 * Appends to the list rather than rewriting it — the file belongs to the user, and
 * their comments and ordering survive. Nothing is written if every line was rejected.
 */
export function addToReposList(file: string, urls: string[]): AddResult {
  const existing = readReposList(file);
  const known = new Set(existing.entries.map((e) => e.name));
  const parsed = parseReposList(urls.join('\n'));

  const added: ReposListEntry[] = [];
  const alreadyListed: string[] = [];
  for (const entry of parsed.entries) {
    if (known.has(entry.name)) {
      alreadyListed.push(entry.name);
      continue;
    }
    known.add(entry.name);
    added.push(entry);
  }

  if (added.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : reposListTemplate();
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';
    body += added.map((e) => (repoNameFromUrl(e.url) === e.name ? e.url : `${e.name} = ${e.url}`)).join('\n');
    fs.writeFileSync(file, `${body}\n`);
  }

  return { added, alreadyListed, problems: parsed.problems };
}

/** Written into a new list file so an empty list still tells you what to do with it. */
export function reposListTemplate(): string {
  return `# Projects for repos-expert to study.
#
# Put one git URL per line, then run:  expert sync
# Each one is cloned into this folder, and from then on \`expert refresh\` keeps it
# up to date.
#
#   https://github.com/acme/billing-api.git
#   git@github.com:acme/checkout-service.git
#   acme/billing-api                    <- GitHub shorthand, same thing
#
# To use a shorter folder name than the URL implies, put the name first:
#
#   billing = https://gitlab.com/acme/some-very-long-repository-name.git
#
# You do not have to list anything. Any folder in here with a .git in it is found
# automatically, so copying or cloning projects in by hand works just as well.
#
# Lines starting with # are ignored. Add yours below.
`;
}
