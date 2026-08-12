import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOS_LIST_FILENAME } from './repos-list.js';
import { isValidEnvKey } from './provider.js';

export interface ExpertConfig {
  /** Only needed to pull repos from GitHub; null means "work with whatever is in reposDir". */
  githubUser: string | null;
  reposDir: string;
  /** Editable list of git URLs to clone. Defaults to repos.txt inside reposDir. */
  reposListFile: string;
  knowledgeDir: string;
  model: string;
  excludeRepos: string[];
  includeArchived: boolean;
  /** How many repos a curate batch works on at once. */
  curateConcurrency: number;
  /** How long one curator agent may run before it is aborted. */
  curateTimeoutMinutes: number;
  /**
   * Environment handed to the curator subprocess, layered over this process's own.
   * Point `ANTHROPIC_BASE_URL` at a local proxy to curate with a local model. Config
   * rather than shell variables, because a scheduled task inherits neither.
   */
  curatorEnv: Record<string, string>;
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

/**
 * Per-user config location. This is what makes `npx repos-expert` work: run that
 * way, the package lives in a throwaway cache folder, so config cannot sit
 * beside the code.
 */
export function userConfigPath(): string {
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData.length > 0) {
    return path.join(appData, 'repos-expert', 'expert.config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, 'repos-expert', 'expert.config.json');
  }
  return path.join(os.homedir(), '.config', 'repos-expert', 'expert.config.json');
}

function configCandidates(): string[] {
  const fromEnv = process.env.EXPERT_CONFIG;
  return [
    ...(fromEnv !== undefined && fromEnv.length > 0 ? [path.resolve(fromEnv)] : []),
    path.resolve('expert.config.json'),
    userConfigPath(),
    packageRootConfigPath(),
  ];
}

/** The config that would be loaded, or null if there is none. Never throws. */
export function findConfigPath(): string | null {
  return configCandidates().find((c) => fs.existsSync(c)) ?? null;
}

function resolveDefaultConfigPath(): string {
  const candidates = configCandidates();
  const found = candidates.find((c) => fs.existsSync(c));
  if (found !== undefined) return found;
  throw new Error(
    `No config found. Run \`expert init\` to create one, or set EXPERT_CONFIG.\nLooked in:\n${candidates
      .map((c) => `  ${c}`)
      .join('\n')}`,
  );
}

export function loadConfig(configPath?: string): ExpertConfig {
  const resolvedPath = configPath ?? resolveDefaultConfigPath();
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config not found: ${resolvedPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
  const githubUser =
    typeof raw.githubUser === 'string' && raw.githubUser.length > 0 ? raw.githubUser : null;
  const merged = { ...DEFAULTS, ...raw } as typeof DEFAULTS;
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
  const curatorEnv: Record<string, string> = {};
  if (raw.curatorEnv !== undefined && raw.curatorEnv !== null) {
    if (typeof raw.curatorEnv !== 'object' || Array.isArray(raw.curatorEnv)) {
      throw new Error('expert.config.json: "curatorEnv" must be an object of NAME: "value" pairs');
    }
    for (const [key, value] of Object.entries(raw.curatorEnv as Record<string, unknown>)) {
      if (!isValidEnvKey(key)) {
        throw new Error(`expert.config.json: "curatorEnv" name ${JSON.stringify(key)} is not a valid environment variable`);
      }
      if (typeof value !== 'string') {
        throw new Error(`expert.config.json: "curatorEnv" value for ${key} must be a string`);
      }
      curatorEnv[key] = value;
    }
  }

  const base = path.dirname(resolvedPath);
  const reposDir = path.resolve(base, merged.reposDir);
  return {
    githubUser,
    reposDir,
    reposListFile:
      typeof raw.reposListFile === 'string' && raw.reposListFile.length > 0
        ? path.resolve(base, raw.reposListFile)
        : path.join(reposDir, REPOS_LIST_FILENAME),
    knowledgeDir: path.resolve(base, merged.knowledgeDir),
    model: merged.model,
    excludeRepos: merged.excludeRepos,
    includeArchived: Boolean(merged.includeArchived),
    curateConcurrency: merged.curateConcurrency,
    curateTimeoutMinutes: merged.curateTimeoutMinutes,
    curatorEnv,
  };
}
