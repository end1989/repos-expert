import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExpertConfig {
  githubUser: string;
  reposDir: string;
  knowledgeDir: string;
  model: string;
  excludeRepos: string[];
  includeArchived: boolean;
  /** How many repos a curate batch works on at once. */
  curateConcurrency: number;
  /** How long one curator agent may run before it is aborted. */
  curateTimeoutMinutes: number;
}

/** Upper bound on parallel curator agents — each one spawns a CLI subprocess. */
export const MAX_CURATE_CONCURRENCY = 16;

/** Upper bound on the per-repo curator timeout. */
export const MAX_CURATE_TIMEOUT_MINUTES = 120;

const DEFAULTS = {
  reposDir: './repos',
  knowledgeDir: './knowledge',
  model: 'claude-sonnet-5',
  excludeRepos: [] as string[],
  includeArchived: false,
  curateConcurrency: 4,
  curateTimeoutMinutes: 25,
};

export function isValidTimeoutMinutes(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_CURATE_TIMEOUT_MINUTES
  );
}

export function isValidConcurrency(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CURATE_CONCURRENCY;
}

function packageRootConfigPath(): string {
  // config.js sits at dist/config.js in the build and src/config.ts in dev —
  // '..' lands on the package root in both cases.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'expert.config.json');
}

function resolveDefaultConfigPath(): string {
  const cwdCandidate = path.resolve('expert.config.json');
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  const packageCandidate = packageRootConfigPath();
  if (fs.existsSync(packageCandidate)) return packageCandidate;
  throw new Error(
    `Config not found: tried ${cwdCandidate} and ${packageCandidate}`,
  );
}

export function loadConfig(configPath?: string): ExpertConfig {
  const resolvedPath = configPath ?? resolveDefaultConfigPath();
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config not found: ${resolvedPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
  if (typeof raw.githubUser !== 'string' || raw.githubUser.length === 0) {
    throw new Error('expert.config.json: "githubUser" (string) is required');
  }
  const merged = { ...DEFAULTS, ...raw } as typeof DEFAULTS & { githubUser: string };
  if (!isValidConcurrency(merged.curateConcurrency)) {
    throw new Error(
      `expert.config.json: "curateConcurrency" must be an integer between 1 and ${MAX_CURATE_CONCURRENCY}`,
    );
  }
  if (!isValidTimeoutMinutes(merged.curateTimeoutMinutes)) {
    throw new Error(
      `expert.config.json: "curateTimeoutMinutes" must be an integer between 1 and ${MAX_CURATE_TIMEOUT_MINUTES}`,
    );
  }
  const base = path.dirname(resolvedPath);
  return {
    githubUser: merged.githubUser,
    reposDir: path.resolve(base, merged.reposDir),
    knowledgeDir: path.resolve(base, merged.knowledgeDir),
    model: merged.model,
    excludeRepos: merged.excludeRepos,
    includeArchived: Boolean(merged.includeArchived),
    curateConcurrency: merged.curateConcurrency,
    curateTimeoutMinutes: merged.curateTimeoutMinutes,
  };
}
