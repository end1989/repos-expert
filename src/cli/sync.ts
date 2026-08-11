import fs from 'node:fs';
import path from 'node:path';
import { listGithubRepos, cloneRepo, updateMirror, type RemoteRepo } from '../git.js';
import type { ExpertConfig } from '../config.js';

export interface SyncDeps {
  listRemote(user: string): Promise<RemoteRepo[]>;
  clone(url: string, dest: string): Promise<void>;
  update(dir: string, branch: string): Promise<void>;
}

const realDeps: SyncDeps = {
  listRemote: listGithubRepos,
  clone: cloneRepo,
  update: updateMirror,
};

export interface SyncResult {
  synced: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

export async function syncRepos(
  cfg: ExpertConfig,
  deps: SyncDeps = realDeps,
  only?: string[],
): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [] };
  if (cfg.githubUser === null) {
    throw new Error(
      `GitHub sync is not configured — set "githubUser" in expert.config.json to pull repos from GitHub. ` +
        `Everything else still works on the repos already in ${cfg.reposDir}: curate them, search them, and serve them over MCP.`,
    );
  }
  let remote = await deps.listRemote(cfg.githubUser);
  if (only !== undefined) {
    for (const name of only) {
      if (!remote.some((r) => r.name === name)) {
        result.failed.push({ name, error: 'not found on GitHub account' });
      }
    }
    remote = remote.filter((r) => only.includes(r.name));
  }
  fs.mkdirSync(cfg.reposDir, { recursive: true });
  for (const repo of remote) {
    if (cfg.excludeRepos.includes(repo.name) || (repo.isArchived && !cfg.includeArchived)) {
      result.skipped.push(repo.name);
      continue;
    }
    const dest = path.join(cfg.reposDir, repo.name);
    try {
      if (fs.existsSync(path.join(dest, '.git'))) {
        await deps.update(dest, repo.defaultBranch);
      } else {
        await deps.clone(repo.url, dest);
      }
      result.synced.push(repo.name);
    } catch (err) {
      result.failed.push({ name: repo.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
