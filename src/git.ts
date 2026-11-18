import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { findOnPath } from './which.js';

const execFileAsync = promisify(execFile);
const OPTS = { maxBuffer: 10 * 1024 * 1024 };

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

const found = new Map<string, string>();

/**
 * Runs git or gh by its full path. By bare name a program is looked for first in the working
 * folder, on Windows — and git runs inside the repositories being studied, where a committed
 * git.exe would run in its place (see which.ts). Missing from PATH, a program fails as its
 * bare name would have.
 */
async function run(
  program: 'git' | 'gh',
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  let file = found.get(program);
  if (file === undefined) {
    // An .exe or .com, the files Windows starts without a shell.
    const located = findOnPath(program, process.env, ['.exe', '.com']);
    if (located === null) {
      throw Object.assign(new Error(`${program} was not found on PATH`), { code: 'ENOENT' });
    }
    found.set(program, located);
    file = located;
  }
  return execFileAsync(file, args, { ...options, encoding: 'utf8' });
}

/**
 * For commands that reach a remote. Never stop to ask for a password — a scheduled
 * refresh has nobody to answer, and would hang until killed — and give up eventually.
 */
const NETWORK_OPTS = {
  ...OPTS,
  timeout: 30 * 60_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
};

/** How much of the history since the last curation goes into a prompt. */
const RANGE_MAX_COMMITS = 100;
const RANGE_MAX_CHARS = 30_000;

export interface RemoteRepo {
  name: string;
  url: string;
  defaultBranch: string;
  isArchived: boolean;
}

/** What `gh repo list --json name,url,defaultBranchRef,isArchived` prints. */
const GhRepoList = z.array(
  z.object({
    name: z.string(),
    url: z.string(),
    defaultBranchRef: z.object({ name: z.string() }).nullable(),
    isArchived: z.boolean(),
  }),
);

export function parseRepoList(json: string): RemoteRepo[] {
  const parsed = GhRepoList.safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new Error('`gh repo list` printed something other than the expected repository list.');
  return parsed.data.map((i) => ({
    name: i.name,
    url: i.url,
    defaultBranch: i.defaultBranchRef?.name ?? 'main',
    isArchived: i.isArchived,
  }));
}

export async function listGithubRepos(user: string): Promise<RemoteRepo[]> {
  if (!/^[A-Za-z0-9-]+$/.test(user)) {
    throw new Error(`Invalid GitHub username: ${user}`);
  }
  const { stdout } = await run(
    'gh',
    ['repo', 'list', user, '--limit', '1000', '--json', 'name,url,defaultBranchRef,isArchived'],
    NETWORK_OPTS,
  );
  return parseRepoList(stdout);
}

export async function cloneRepo(url: string, dest: string): Promise<void> {
  // '--' already stops git reading the URL as an option. Refusing here too means a caller
  // that skipped the repos.txt allowlist still cannot hand git a flag such as --upload-pack.
  if (url.startsWith('-')) {
    throw new Error(`Refusing to clone ${JSON.stringify(url)}: a URL cannot start with "-".`);
  }
  await run('git', ['clone', '--', url, dest], NETWORK_OPTS);
}

export async function updateMirror(dir: string, defaultBranch: string): Promise<void> {
  if (!/^[\w./-]+$/.test(defaultBranch) || defaultBranch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${defaultBranch}`);
  }
  await run('git', ['fetch', 'origin'], { ...NETWORK_OPTS, cwd: dir });
  await run('git', ['reset', '--hard', `origin/${defaultBranch}`], { ...OPTS, cwd: dir });
}

/**
 * Update a repo the user may also be working in. Fast-forward only: if their branch
 * has diverged, git refuses and we report it, rather than throwing away their commits
 * the way `updateMirror` deliberately does.
 */
export async function pullFastForward(dir: string): Promise<void> {
  await run('git', ['pull', '--ff-only'], { ...NETWORK_OPTS, cwd: dir });
}

export async function revParseHead(dir: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogOneline(dir: string, limit = 30): Promise<string> {
  const validLimit = Math.floor(limit);
  if (validLimit <= 0) {
    throw new Error(`Limit must be a positive integer, got ${limit}`);
  }
  const { stdout } = await run('git', ['log', '--oneline', `-${validLimit}`], {
    ...OPTS,
    cwd: dir,
  });
  return stdout.trim();
}

/**
 * What changed since `fromSha`, for the curator's prompt: at most RANGE_MAX_COMMITS
 * commits, and cut at RANGE_MAX_CHARS with a note saying so.
 */
export async function gitLogRangeStat(dir: string, fromSha: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(fromSha)) {
    throw new Error(`Invalid git SHA: ${fromSha}`);
  }
  const { stdout } = await run(
    'git',
    ['log', '-n', String(RANGE_MAX_COMMITS), '--stat=100,60,20', `${fromSha}..HEAD`, '--'],
    { ...OPTS, cwd: dir },
  );
  const log = stdout.trim();
  return log.length <= RANGE_MAX_CHARS
    ? log
    : `${log.slice(0, RANGE_MAX_CHARS)}\n… (history cut here; read the code for the rest)`;
}

/**
 * Repo-relative paths (forward slashes) touched between `fromSha` and HEAD. Throws
 * when `fromSha` is not in this history — a rewritten branch, say — so the caller
 * treats "unknown" as "changed" rather than guessing.
 *
 * `--no-renames` reports both sides of a move, so source moved under docs/ still shows
 * up as a change to source. `-z` returns names exactly, instead of quoted and escaped.
 */
export async function changedFilesSince(dir: string, fromSha: string): Promise<string[]> {
  if (!/^[0-9a-f]{4,40}$/i.test(fromSha)) {
    throw new Error(`Invalid git SHA: ${fromSha}`);
  }
  const { stdout } = await run(
    'git',
    ['diff', '--name-only', '-z', '--no-renames', fromSha, 'HEAD', '--'],
    {
      ...OPTS,
      cwd: dir,
    },
  );
  return stdout
    .split('\0')
    .map((l) => l.replace(/\\/g, '/'))
    .filter((l) => l.length > 0);
}

export async function listBranches(dir: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '-a'], { ...OPTS, cwd: dir });
  return stdout.trim();
}
