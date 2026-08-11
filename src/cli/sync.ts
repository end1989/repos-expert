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

export async function syncRepos(cfg: ExpertConfig, deps: SyncDeps = realDeps): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [] };
  const remote = await deps.listRemote(cfg.githubUser);
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
