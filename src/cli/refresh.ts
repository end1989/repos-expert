import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../config.js';
import { listRepoStatuses, getRepoStatus, type RepoStatus } from '../registry.js';
import { curatePortfolio } from '../curator/curator.js';
import { syncRepos, type SyncResult } from './sync.js';

import { curateMany, type CurateOne, type CurateFailure } from './curate-many.js';

export interface RefreshDeps {
  sync(cfg: ExpertConfig, only?: string[]): Promise<SyncResult>;
  curateOne?: CurateOne;
  portfolio(cfg: ExpertConfig): Promise<void>;
  listStatuses(cfg: ExpertConfig): Promise<RepoStatus[]>;
  getStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus>;
}

const realDeps: RefreshDeps = {
  sync: (cfg, only) => syncRepos(cfg, undefined, only),
  portfolio: (cfg) => curatePortfolio(cfg),
  listStatuses: listRepoStatuses,
  getStatus: getRepoStatus,
};

export interface RefreshResult {
  synced: number;
  syncFailed: CurateFailure[];
  curated: number;
  curateFailed: CurateFailure[];
  uncurated: string[];
  /** Named repos sync deliberately left alone — excluded, or archived without includeArchived. */
  skipped: string[];
  portfolioOk: boolean;
  portfolioError: string | null;
}

export function refreshLockPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.refresh.lock');
}

function acquireLock(knowledgeDir: string): string {
  const p = refreshLockPath(knowledgeDir);
  fs.mkdirSync(knowledgeDir, { recursive: true });
  try {
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let startedAt = 'an unknown time';
    try {
      startedAt = (JSON.parse(fs.readFileSync(p, 'utf8')) as { startedAt?: string }).startedAt ?? startedAt;
    } catch {
      // corrupted lock — the generic message still names the path
    }
    throw new Error(
      `Another refresh appears to be running (started ${startedAt}). If that is stale, delete ${p} and retry.`,
    );
  }
  return p;
}

export async function runRefresh(
  cfg: ExpertConfig,
  names?: string[],
  deps: RefreshDeps = realDeps,
): Promise<RefreshResult> {
  const lock = acquireLock(cfg.knowledgeDir);
  try {
    // A missing or broken GitHub connection must not stop us analysing what is
    // already on disk — it downgrades to a reported failure, not an abort.
    let sync: SyncResult;
    try {
      sync = await deps.sync(cfg, names);
    } catch (err) {
      sync = {
        synced: [],
        skipped: [],
        failed: [{ name: 'github', error: err instanceof Error ? err.message : String(err) }],
      };
    }
    const result: RefreshResult = {
      synced: sync.synced.length,
      syncFailed: sync.failed,
      curated: 0,
      curateFailed: [],
      uncurated: [],
      skipped: [],
      portfolioOk: false,
      portfolioError: null,
    };

    // Sync reports what it deliberately left alone. Curating those anyway would spend
    // money describing a stale mirror and then stamp it as freshly studied.
    const skippedBySync = new Set(sync.skipped.map((n) => n.toLowerCase()));

    const targets: RepoStatus[] = [];
    if (names !== undefined) {
      for (const name of names) {
        if (skippedBySync.has(name.toLowerCase())) {
          result.skipped.push(name);
          continue;
        }
        try {
          targets.push(await deps.getStatus(cfg, name));
        } catch (err) {
          result.curateFailed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      const statuses = await deps.listStatuses(cfg);
      targets.push(...statuses.filter((s) => s.state === 'stale'));
      result.uncurated = statuses.filter((s) => s.state === 'uncurated').map((s) => s.name);
    }

    const failures = await curateMany(cfg, targets, deps.curateOne);
    result.curateFailed.push(...failures);
    result.curated = targets.length - failures.length;

    try {
      await deps.portfolio(cfg);
      result.portfolioOk = true;
    } catch (err) {
      result.portfolioError = err instanceof Error ? err.message : String(err);
    }
    return result;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
