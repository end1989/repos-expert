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
  const { stdout } = await run(
    'gh',
    ['repo', 'list', user, '--limit', '200', '--json', 'name,url,defaultBranchRef,isArchived'],
    OPTS,
  );
  return parseRepoList(stdout);
}

export async function cloneRepo(url: string, dest: string): Promise<void> {
  await run('git', ['clone', url, dest], OPTS);
}

export async function updateMirror(dir: string, defaultBranch: string): Promise<void> {
  await run('git', ['fetch', 'origin'], { ...OPTS, cwd: dir });
  await run('git', ['reset', '--hard', `origin/${defaultBranch}`], { ...OPTS, cwd: dir });
}

export async function revParseHead(dir: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogOneline(dir: string, limit = 30): Promise<string> {
  const { stdout } = await run('git', ['log', '--oneline', `-${limit}`], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogRangeStat(dir: string, fromSha: string): Promise<string> {
  const { stdout } = await run('git', ['log', `${fromSha}..HEAD`, '--stat'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function listBranches(dir: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '-a'], { ...OPTS, cwd: dir });
  return stdout.trim();
}
