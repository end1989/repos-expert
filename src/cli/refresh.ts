import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExpertConfig } from '../config.js';
import { errorCode, resolveReal } from '../paths.js';
import { listRepoStatuses, getRepoStatus, portfolioDrift, type RepoStatus } from '../registry.js';
import { syncRepos, type SyncResult } from './sync.js';
import type { CurateOne, CurateFailure } from './curate-many.js';
import { partitionStale, type ReverifyDeps } from './reverify.js';

export interface RefreshDeps {
  sync(cfg: ExpertConfig, only?: string[]): Promise<SyncResult>;
  curateOne?: CurateOne;
  portfolio(cfg: ExpertConfig): Promise<unknown>;
  listStatuses(cfg: ExpertConfig): Promise<RepoStatus[]>;
  getStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus>;
  /** Injectable for tests; the real one asks git. */
  changedFiles?: ReverifyDeps['changedFiles'];
}

const realDeps: RefreshDeps = {
  sync: (cfg, only) => syncRepos(cfg, undefined, only),
  // Loaded on use, so a dry run never imports the Agent SDK.
  portfolio: async (cfg) => (await import('../curator/curator.js')).curatePortfolio(cfg),
  listStatuses: listRepoStatuses,
  getStatus: getRepoStatus,
};

export interface RefreshResult {
  synced: number;
  syncFailed: CurateFailure[];
  /** Guidance when there was nothing to sync — not a failure. */
  syncNote: string | null;
  curated: number;
  curateFailed: CurateFailure[];
  uncurated: string[];
  /** Named repos sync deliberately left alone — excluded, or archived without includeArchived. */
  skipped: string[];
  /** Stale only in ignorable paths (docs, CI, lockfiles): re-verified, no model run. */
  reverified: string[];
  portfolioOk: boolean;
  portfolioError: string | null;
  /** Why the portfolio pass did not run, when it did not need to. */
  portfolioSkipped: string | null;
  /** The repos this run would study (all of them, on a dry run). */
  planned: string[];
  /** True when `confirm` said no: nothing was studied and nothing was spent. */
  cancelled: boolean;
}

export interface RefreshOptions {
  /** Work out what would be studied — no sync, no model call, nothing written. */
  dryRun?: boolean;
  /** Asked once the targets are known and before anything is spent; false stops the run. */
  confirm?: (targets: RepoStatus[]) => Promise<boolean>;
}

export function refreshLockPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.refresh.lock');
}

/** Whether a process with this id is running. EPERM means it exists but is not ours. */
function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

interface LockRecord {
  pid?: unknown;
  startedAt?: unknown;
}

function readLock(file: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const sameLock = (a: LockRecord | null, b: LockRecord | null): boolean =>
  a === null ? b === null : b !== null && a.pid === b.pid && a.startedAt === b.startedAt;

/** How long a lock may stay empty — its run between creating and writing it — before it counts as abandoned. */
const UNWRITTEN_LOCK_GRACE_MS = 10_000;

/**
 * A lock is abandoned when its run is gone, or when it is empty and old: the run was killed
 * between creating the file and writing who it is.
 */
function isAbandoned(file: string, held: LockRecord | null): boolean {
  if (held !== null) return !isAlive(held.pid);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > UNWRITTEN_LOCK_GRACE_MS;
  } catch {
    return false; // already gone: nothing to judge
  }
}

/**
 * Creates `file` holding `record` only if it does not exist: the check and the creation are
 * one step. False when it exists. On Windows a file that is still being deleted cannot be
 * created yet (EPERM); that is retried briefly, then counted as taken. A write that fails
 * after the create removes the empty file rather than leave it to look like a lock.
 */
async function createExclusive(file: string, record: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      const code = errorCode(err);
      if (code === 'EEXIST') return false;
      if (code === 'EPERM' && process.platform === 'win32') {
        if (attempt === 5) return false;
        await sleep(20);
        continue;
      }
      throw err;
    }
    try {
      fs.writeFileSync(fd, record);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    return true;
  }
}

async function acquireLock(knowledgeDir: string): Promise<{ file: string; record: LockRecord }> {
  const p = refreshLockPath(knowledgeDir);
  const marker = `${p}.takeover`;
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const ours = { pid: process.pid, startedAt: new Date().toISOString() };
  const record = JSON.stringify(ours);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(p, record)) return { file: p, record: ours };
    if (!fs.existsSync(p)) continue; // released between our attempt and our look
    const held = readLock(p);
    if (!isAbandoned(p, held)) break;
    // Left by a crash or a Ctrl-C: clear it rather than ask someone to find and delete a
    // file. Clearing is itself exclusive — only the run that creates the takeover marker
    // may do it — so two runs that find the same abandoned lock cannot both take it.
    if (!(await createExclusive(marker, record))) break;
    try {
      const now = readLock(p);
      if (sameLock(now, held) && isAbandoned(p, now)) fs.rmSync(p, { force: true });
      if (await createExclusive(p, record)) return { file: p, record: ours };
    } finally {
      fs.rmSync(marker, { force: true });
    }
  }

  const current = readLock(p);
  const startedAt = typeof current?.startedAt === 'string' ? current.startedAt : 'an unknown time';
  const stuck =
    fs.existsSync(marker) && isAbandoned(marker, readLock(marker))
      ? ` A run that was clearing a stale lock stopped part-way: delete ${marker} as well.`
      : '';
  throw new Error(
    `Another refresh appears to be running (started ${startedAt}). If that is stale, delete ${p} and retry.${stuck}`,
  );
}

/**
 * Runs `fn` holding the knowledge folder's lock, so two batches never write the same docs
 * at once. Shared by `refresh` and `curate`.
 */
export async function withRefreshLock<T>(knowledgeDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(knowledgeDir);
  try {
    return await fn();
  } finally {
    // Remove only our own lock — never one a later run has since taken over.
    if (sameLock(readLock(lock.file), lock.record)) fs.rmSync(lock.file, { force: true });
  }
}

export async function runRefresh(
  cfg: ExpertConfig,
  names?: string[],
  deps: RefreshDeps = realDeps,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const dryRun = opts.dryRun === true;
  const body = async (): Promise<RefreshResult> => {
    // A missing or broken GitHub connection must not stop us analysing what is
    // already on disk — it downgrades to a reported failure, not an abort.
    let sync: SyncResult = { synced: [], skipped: [], failed: [] };
    if (!dryRun) {
      try {
        sync = await deps.sync(cfg, names);
      } catch (err) {
        sync = {
          synced: [],
          skipped: [],
          failed: [{ name: 'github', error: err instanceof Error ? err.message : String(err) }],
        };
      }
    }
    const result: RefreshResult = {
      synced: sync.synced.length,
      syncFailed: sync.failed,
      syncNote: sync.nothingToSync ?? null,
      curated: 0,
      curateFailed: [],
      uncurated: [],
      skipped: [],
      reverified: [],
      portfolioOk: false,
      portfolioError: null,
      portfolioSkipped: null,
      planned: [],
      cancelled: false,
    };

    // Sync reports what it deliberately left alone. Curating those anyway would spend
    // money describing a stale mirror and then stamp it as freshly studied.
    const skippedBySync = new Set(sync.skipped.map((n) => n.toLowerCase()));

    const targets: RepoStatus[] = [];
    if (names !== undefined) {
      // One study per folder, however it was named: `alpha alpha`, or on Windows and macOS
      // `alpha ALPHA`, would otherwise pay twice to write the same docs at the same time.
      const studying = new Set<string>();
      for (const name of names) {
        if (skippedBySync.has(name.toLowerCase())) {
          result.skipped.push(name);
          continue;
        }
        try {
          const status = await deps.getStatus(cfg, name);
          const where = resolveReal(status.path);
          const key = process.platform === 'win32' ? where.toLowerCase() : where;
          if (studying.has(key)) continue;
          studying.add(key);
          targets.push(status);
        } catch (err) {
          result.curateFailed.push({
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      const statuses = await deps.listStatuses(cfg);
      const split = await partitionStale(
        cfg,
        statuses.filter((s) => s.state === 'stale'),
        deps.changedFiles !== undefined ? { changedFiles: deps.changedFiles } : undefined,
        dryRun ? 'dry-run' : 'apply',
      );
      targets.push(...split.curate);
      result.reverified = split.reverified;
      result.uncurated = statuses.filter((s) => s.state === 'uncurated').map((s) => s.name);
    }
    result.planned = targets.map((t) => t.name);

    if (dryRun) {
      result.portfolioSkipped = 'dry run';
      return result;
    }
    if (targets.length > 0 && opts.confirm !== undefined && !(await opts.confirm(targets))) {
      result.cancelled = true;
      return result;
    }

    const { curateMany } = await import('./curate-many.js');
    const failures = await curateMany(cfg, targets, deps.curateOne);
    result.curateFailed.push(...failures);
    result.curated = targets.length - failures.length;

    // The portfolio pass is a paid model call. Spend it only when there is something
    // studied, and the portfolio has not already seen the current docs of all of it. Docs
    // rewritten in this run count as unseen even at the same commit: a named re-study of
    // a fresh repo changes what the portfolio summarises without changing any sha.
    const studied = (await deps.listStatuses(cfg)).filter((s) => s.curatedSha !== null);
    const drift = studied.length === 0 ? null : portfolioDrift(cfg.knowledgeDir, studied);
    if (studied.length === 0) {
      result.portfolioOk = true;
      result.portfolioSkipped = 'nothing has been studied yet';
    } else if (result.curated === 0 && drift !== null && drift.length === 0) {
      result.portfolioOk = true;
      result.portfolioSkipped = 'already up to date';
    } else {
      try {
        await deps.portfolio(cfg);
        result.portfolioOk = true;
      } catch (err) {
        result.portfolioError = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  };
  // A dry run changes nothing, so it needs no lock — and can look while a real run works.
  return dryRun ? body() : withRefreshLock(cfg.knowledgeDir, body);
}
