import { MAX_CURATE_CONCURRENCY, isValidConcurrency, type ExpertConfig } from '../config.js';
import type { RepoStatus } from '../registry.js';
import { curateRepo } from '../curator/curator.js';

export type CurateOne = (cfg: ExpertConfig, status: RepoStatus) => Promise<void>;

export interface CurateFailure {
  name: string;
  error: string;
}

/** Validates a `--concurrency` argument; throws with the CLI-facing message. */
export function parseConcurrency(value: string): number {
  const n = Number(value.trim() === '' ? NaN : value);
  if (!isValidConcurrency(n)) {
    throw new Error(`--concurrency must be an integer between 1 and ${MAX_CURATE_CONCURRENCY}`);
  }
  return n;
}

/**
 * Curates `statuses` with at most `concurrency` agents in flight, refilling a
 * slot as soon as one finishes. Per-repo failures never stop the batch;
 * they come back in input order regardless of when they happened.
 */
export async function curateMany(
  cfg: ExpertConfig,
  statuses: RepoStatus[],
  curateOne: CurateOne = curateRepo,
  concurrency: number = cfg.curateConcurrency,
): Promise<CurateFailure[]> {
  const total = statuses.length;
  const failures: (CurateFailure | undefined)[] = new Array(total);
  let next = 0;
  let finished = 0;

  async function worker(): Promise<void> {
    for (let i = next++; i < total; i = next++) {
      const status = statuses[i]!;
      try {
        await curateOne(cfg, status);
        finished += 1;
        console.log(`curated ${status.name} (${finished}/${total})`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures[i] = { name: status.name, error };
        finished += 1;
        console.error(`FAILED ${status.name}: ${error} (${finished}/${total})`);
      }
    }
  }

  const workers = Math.min(Math.max(1, concurrency), total);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return failures.filter((f): f is CurateFailure => f !== undefined);
}
