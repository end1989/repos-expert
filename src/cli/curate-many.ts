import type { ExpertConfig } from '../config.js';
import type { CitationReport, RepoStatus, RunStats } from '../registry.js';
import { describeCitations, describeRun } from './messages.js';

/** What curating one repo reports back: its cost when measured, and its citation check. */
export interface CurateResult {
  stats: RunStats | undefined;
  citations: CitationReport;
}

/** Curates one repo. Test doubles may resolve to nothing. */
export type CurateOne = (cfg: ExpertConfig, status: RepoStatus) => Promise<CurateResult | void>;

/**
 * The real curator, loaded on first use: the Agent SDK is only imported by a run that is
 * about to spend, never by a dry run or a status check that merely passes through here.
 */
const curateRepo: CurateOne = async (cfg, status) =>
  (await import('../curator/curator.js')).curateRepo(cfg, status);

export interface CurateFailure {
  name: string;
  error: string;
}

/** Validates a `--concurrency` argument; throws with the CLI-facing message. */
export { parseConcurrency } from '../config.js';
export { describeRun } from './messages.js';

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
  const failures: (CurateFailure | undefined)[] = Array.from({ length: total }, () => undefined);
  let next = 0;
  let finished = 0;
  let spentUsd = 0;
  let measuredRuns = 0;

  async function worker(): Promise<void> {
    for (let i = next++; i < total; i = next++) {
      const status = statuses[i]!;
      try {
        const result = await curateOne(cfg, status);
        finished += 1;
        const stats = result?.stats;
        if (stats !== undefined) {
          spentUsd += stats.costUsd;
          measuredRuns += 1;
        }
        const notes = [
          stats !== undefined ? describeRun(stats) : '',
          result !== undefined ? describeCitations(result.citations) : '',
        ].filter((n) => n.length > 0);
        console.log(
          `curated ${status.name} (${finished}/${total})${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}`,
        );
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
  if (measuredRuns > 0) {
    console.log(
      `Spent about $${spentUsd.toFixed(2)} on ${measuredRuns} ${measuredRuns === 1 ? 'run' : 'runs'} (the agent runtime’s estimate, not a bill).`,
    );
  }
  return failures.filter((f): f is CurateFailure => f !== undefined);
}
