import fs from 'node:fs';
import path from 'node:path';
import { listGithubRepos, cloneRepo, updateMirror, pullFastForward, type RemoteRepo } from '../git.js';
import { readReposList } from '../repos-list.js';
import type { ExpertConfig } from '../config.js';

export interface SyncDeps {
  listRemote(user: string): Promise<RemoteRepo[]>;
  clone(url: string, dest: string): Promise<void>;
  /** Mirror update for GitHub-managed repos: authoritative remote, local state discarded. */
  update(dir: string, branch: string): Promise<void>;
  /** For listed repos, which may be the user's own working copies — never discards work. */
  pull(dir: string): Promise<void>;
}

const realDeps: SyncDeps = {
  listRemote: listGithubRepos,
  clone: cloneRepo,
  update: updateMirror,
  pull: pullFastForward,
};

export interface SyncResult {
  synced: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

/** A repo to put on disk, and how to bring an existing copy up to date. */
interface Target {
  name: string;
  url: string;
  /** Listed repos may hold local commits; GitHub mirrors are replaced wholesale. */
  refresh: (dir: string) => Promise<void>;
  archived: boolean;
}

export async function syncRepos(
  cfg: ExpertConfig,
  deps: SyncDeps = realDeps,
  only?: string[],
): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [] };

  const list = readReposList(cfg.reposListFile);
  for (const problem of list.problems) {
    result.failed.push({ name: cfg.reposListFile, error: problem });
  }

  const targets: Target[] = list.entries.map((e) => ({
    name: e.name,
    url: e.url,
    refresh: (dir) => deps.pull(dir),
    archived: false,
  }));

  if (cfg.githubUser !== null) {
    const listed = new Set(targets.map((t) => t.name));
    for (const repo of await deps.listRemote(cfg.githubUser)) {
      // An explicit line in the list is the user's decision — it outranks the account.
      if (listed.has(repo.name)) continue;
      targets.push({
        name: repo.name,
        url: repo.url,
        refresh: (dir) => deps.update(dir, repo.defaultBranch),
        archived: repo.isArchived,
      });
    }
  }

  if (targets.length === 0 && result.failed.length === 0) {
    throw new Error(
      `Nothing to sync yet. Add git URLs to ${cfg.reposListFile} (one per line), or set "githubUser" ` +
        `in your config to pull an entire GitHub account.\n` +
        `Everything else still works on whatever is already in ${cfg.reposDir}: curate it, search it, and serve it over MCP.`,
    );
  }

  // GitHub resolves repo names case-insensitively, so a named filter must too.
  // Matching is folded; the canonical name from the source is what reaches any path.
  const wanted = only === undefined ? undefined : new Set(only.map((n) => n.toLowerCase()));
  if (only !== undefined) {
    for (const name of only) {
      if (!targets.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        const sources = [`the repos list (${cfg.reposListFile})`];
        if (cfg.githubUser !== null) sources.push(`the GitHub account "${cfg.githubUser}"`);
        result.failed.push({ name, error: `not found in ${sources.join(' or ')}` });
      }
    }
  }

  fs.mkdirSync(cfg.reposDir, { recursive: true });
  for (const target of targets) {
    if (wanted !== undefined && !wanted.has(target.name.toLowerCase())) continue;
    if (cfg.excludeRepos.includes(target.name) || (target.archived && !cfg.includeArchived)) {
      result.skipped.push(target.name);
      continue;
    }
    const dest = path.join(cfg.reposDir, target.name);
    try {
      if (fs.existsSync(path.join(dest, '.git'))) {
        await target.refresh(dest);
      } else {
        await deps.clone(target.url, dest);
      }
      result.synced.push(target.name);
    } catch (err) {
      result.failed.push({ name: target.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
