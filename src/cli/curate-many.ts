import type { ExpertConfig } from '../config.js';
import type { RepoStatus } from '../registry.js';
import { curateRepo } from '../curator/curator.js';

export type CurateOne = (cfg: ExpertConfig, status: RepoStatus) => Promise<void>;

export interface CurateFailure {
  name: string;
  error: string;
}

export async function curateMany(
  cfg: ExpertConfig,
  statuses: RepoStatus[],
  curateOne: CurateOne = curateRepo,
): Promise<CurateFailure[]> {
  const failures: CurateFailure[] = [];
  for (const status of statuses) {
    try {
      await curateOne(cfg, status);
      console.log(`curated ${status.name}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ name: status.name, error });
      console.error(`FAILED ${status.name}: ${error}`);
    }
  }
  return failures;
}
