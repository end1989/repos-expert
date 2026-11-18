import fs from 'node:fs';
import path from 'node:path';
import {
  listGithubRepos,
  cloneRepo,
  updateMirror,
  pullFastForward,
  type RemoteRepo,
} from '../git.js';
import { readReposList } from '../repos-list.js';
import { errorCode } from '../paths.js';
import { isExcluded, type ExpertConfig } from '../config.js';

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
  /**
   * Set when there was nothing to sync at all — no list entries and no GitHub account.
   * That is a normal way to work (folders copied in by hand), so it is guidance, not a
   * failure.
   */
  nothingToSync?: string;
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
    const user = cfg.githubUser;
    const listed = new Set(targets.map((t) => t.name));
    // A missing or signed-out `gh` costs the account listing, not the repos the list names.
    let remote: RemoteRepo[] = [];
    try {
      remote = await deps.listRemote(user);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      result.failed.push({
        name: 'github',
        error: `could not list the repositories of "${user}" (${why}) — is the GitHub CLI installed and signed in? Check with \`gh auth status\`.`,
      });
    }
    for (const repo of remote) {
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
    result.nothingToSync =
      `Nothing to sync yet. Add git URLs to ${cfg.reposListFile} (one per line), or set "githubUser" ` +
      `in your config to pull an entire GitHub account.\n` +
      `Everything else still works on whatever is already in ${cfg.reposDir}: curate it, search it, and serve it over MCP.`;
    return result;
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
    if (isExcluded(cfg, target.name) || (target.archived && !cfg.includeArchived)) {
      result.skipped.push(target.name);
      continue;
    }
    const dest = path.join(cfg.reposDir, target.name);
    const isClone = !fs.existsSync(path.join(dest, '.git'));
    // Whether this run made the folder. Only that run may remove it: a sync running at the
    // same time can also find the repo missing, and its failed clone must not delete ours.
    let created = false;
    try {
      if (isClone) {
        created = createFolder(dest);
        await deps.clone(target.url, dest);
      } else {
        await target.refresh(dest);
      }
      result.synced.push(target.name);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A clone that died partway leaves a .git with no usable checkout, which the next
      // run would take for a repo and "update". Remove what this run created, never more.
      const leftover = created ? removePartialClone(dest) : null;
      result.failed.push({
        name: target.name,
        error: leftover === null ? error : `${error}. ${leftover}`,
      });
    }
  }
  return result;
}

/**
 * Creates `dir` unless something is already there; true only when this call made it.
 * Creating is the check: two runs that both find the folder missing cannot both create it.
 * git clones into an empty folder as readily as into a new one.
 */
function createFolder(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Removes a clone that failed partway. On Windows a file another program still holds can
 * stop that; then the repo's failure says what to delete by hand, and the batch goes on.
 */
function removePartialClone(dir: string): string | null {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `The partial clone at ${dir} could not be removed (${why}): delete it before the next sync`;
  }
}
