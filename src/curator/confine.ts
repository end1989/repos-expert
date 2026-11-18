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

/**
 * The pieces a Grep glob reaches ripgrep as. The runtime splits it on whitespace, keeps a
 * word holding both `{` and `}` whole, splits every other word on commas, and passes each
 * piece as its own `--glob`. The glob is also read whole, by whitespace alone, and by
 * whitespace and every comma, so a runtime that split it another way would meet a refusal
 * too. A piece starting with `!` only excludes, so it cannot bring anything back.
 */
function grepGlobPieces(glob: string): string[] {
  const words = glob.split(/\s+/);
  const asTheRuntimeSplitsIt = words.flatMap((word) =>
    word.includes('{') && word.includes('}') ? [word] : word.split(','),
  );
  const readings = [glob, ...words, ...glob.split(/[\s,]+/), ...asTheRuntimeSplitsIt];
  return [...new Set(readings)].filter((piece) => piece.length > 0 && !piece.startsWith('!'));
}

/**
 * Why a Grep glob could bring .git back into the search, or null. The runtime passes ripgrep
 * `--glob !.git` and then the caller's pieces, and in ripgrep the later glob wins: a piece
 * that matches a folder named .git, at any depth, lets the search into it — `*`, `{.git,x}`,
 * and `vendor/**`, which opens vendor/lib/.git. A backslash is an escape to ripgrep (`.gi\t`
 * is `.git`) but a folder separator to this matcher, so a glob holding one is refused rather
 * than misjudged; so is a piece this matcher cannot read.
 */
function grepGlobProblem(given: string): string | null {
  // As written: the runtime hands a Grep glob to ripgrep without trimming or expanding it.
  if (given.includes('\\')) {
    return `the pattern "${given}" contains "\\", which ripgrep reads as an escape, not a folder separator: write folders with "/"`;
  }
  for (const piece of grepGlobPieces(given)) {
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
 * A glob can leave the repository on its own: `../**`, or an absolute pattern. Any `..`
 * segment is refused outright; an absolute pattern is judged by its fixed leading part.
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
  if (segments.includes('..')) return outside;
  // A leading drive ("C:") is not a stream name; every other segment is checked.
  const tail = /^[A-Za-z]:$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  if (namesGitDir(tail.join('/'))) {
    return `the pattern "${given}" reaches into .git, which is not part of the source`;
  }
  if (tool === 'Grep') {
    const problem = grepGlobProblem(given);
    if (problem !== null) return problem;
  }
  if (!path.isAbsolute(glob)) return null;
  const fixed: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    fixed.push(segment);
  }
  let base = fixed.join(path.sep) || path.sep;
  // "C:" alone is the current folder on drive C; the pattern meant the drive's root.
  if (/^[A-Za-z]:$/.test(base)) base += path.sep;
  const lexical = path.resolve(repoRoot, base);
  if (!isInside(path.resolve(repoRoot), lexical) && !isInside(realRoot, lexical)) return outside;
  const real = resolveReal(lexical);
  if (!isInside(realRoot, real)) return outside;
  if (excluded.size > 0) {
    const repo = (path.relative(realRoot, real).split(path.sep)[0] ?? '').toLowerCase();
    if (repo === '' || excluded.has(repo)) {
      return `the pattern "${given}" covers a repository that is excluded from study`;
    }
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
