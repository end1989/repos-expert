import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OPTS = { maxBuffer: 10 * 1024 * 1024 };

export interface RemoteRepo {
  name: string;
  url: string;
  defaultBranch: string;
  isArchived: boolean;
}

interface GhRepoJson {
  name: string;
  url: string;
  defaultBranchRef: { name: string } | null;
  isArchived: boolean;
}

export function parseRepoList(json: string): RemoteRepo[] {
  const items = JSON.parse(json) as GhRepoJson[];
  return items.map((i) => ({
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
    ['repo', 'list', user, '--limit', '200', '--json', 'name,url,defaultBranchRef,isArchived'],
    OPTS,
  );
  return parseRepoList(stdout);
}

export async function cloneRepo(url: string, dest: string): Promise<void> {
  await run('git', ['clone', '--', url, dest], OPTS);
}

export async function updateMirror(dir: string, defaultBranch: string): Promise<void> {
  if (!/^[\w.\/-]+$/.test(defaultBranch) || defaultBranch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${defaultBranch}`);
  }
  await run('git', ['fetch', 'origin'], { ...OPTS, cwd: dir });
  await run('git', ['reset', '--hard', `origin/${defaultBranch}`], { ...OPTS, cwd: dir });
}

/**
 * Update a repo the user may also be working in. Fast-forward only: if their branch
 * has diverged, git refuses and we report it, rather than throwing away their commits
 * the way `updateMirror` deliberately does.
 */
export async function pullFastForward(dir: string): Promise<void> {
  await run('git', ['pull', '--ff-only'], { ...OPTS, cwd: dir });
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
  const { stdout } = await run('git', ['log', '--oneline', `-${validLimit}`], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogRangeStat(dir: string, fromSha: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(fromSha)) {
    throw new Error(`Invalid git SHA: ${fromSha}`);
  }
  const { stdout } = await run('git', ['log', `${fromSha}..HEAD`, '--stat', '--'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function listBranches(dir: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '-a'], { ...OPTS, cwd: dir });
  return stdout.trim();
}
