import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { globProblem } from './glob.js';
import { REPOS_LIST_FILENAME } from './repos-list.js';
import { readTextFile } from './paths.js';
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
  /** Stop one curator run once its estimated cost passes this many dollars; null for no cap. */
  curateMaxBudgetUsd: number | null;
  /**
   * Environment handed to the curator subprocess, layered over this process's own.
   * Point `ANTHROPIC_BASE_URL` at a local proxy to curate with a local model. Config
   * rather than shell variables, because a scheduled task inherits neither.
   */
  curatorEnv: Record<string, string>;
  /**
   * Globs (repo-relative, forward slashes) whose changes do not make docs stale. When
   * everything that changed since curation matches, `refresh` re-verifies the repo
   * instead of paying for a model run. An empty list turns the fast path off.
   */
  refreshIgnore: string[];
}

/**
 * Paths whose changes say nothing about how the code behaves: prose, CI, licences,
 * lockfiles. The curator's docs describe the code, and a README edit does not move it.
 */
export const DEFAULT_REFRESH_IGNORE: readonly string[] = [
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  'docs/**',
  'doc/**',
  '.github/**',
  // Exact names and NAME.ext only: a bare `LICENSE*` would also pass over a source
  // file such as LICENSE_check.ts and leave its docs stale.
  'LICENSE',
  'LICENSE.*',
  'LICENCE',
  'LICENCE.*',
  'NOTICE',
  'NOTICE.*',
  'CHANGELOG',
  'CHANGELOG.*',
  'CONTRIBUTING',
  'CONTRIBUTING.*',
  'CODE_OF_CONDUCT',
  'CODE_OF_CONDUCT.*',
  'SECURITY',
  'SECURITY.*',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'go.sum',
  'composer.lock',
];

/**
 * Whether `excludeRepos` names this repo. Compared without case: on Windows and macOS
 * "Beta" and "beta" are the same folder, and an exclusion must not depend on spelling.
 */
export function isExcluded(cfg: Pick<ExpertConfig, 'excludeRepos'>, name: string): boolean {
  const folded = name.toLowerCase();
  return cfg.excludeRepos.some((e) => e.toLowerCase() === folded);
}

/** Upper bound on parallel curator agents — each one spawns a CLI subprocess. */
export const MAX_CURATE_CONCURRENCY = 16;

/** Upper bound on the per-repo curator timeout. */
export const MAX_CURATE_TIMEOUT_MINUTES = 120;

/** Upper bound on the per-repo spending cap — a sanity limit, not a suggestion. */
export const MAX_CURATE_BUDGET_USD = 1000;

const DEFAULTS = {
  reposDir: './repos',
  knowledgeDir: './knowledge',
  model: 'claude-sonnet-5',
  curateConcurrency: 2,
  curateTimeoutMinutes: 25,
};

const text = (key: string) => z.string({ error: `"${key}" must be a string` });
const textList = (key: string, error: string) =>
  z.array(z.string({ error }), { error }).describe(key);
const intBetween = (key: string, min: number, max: number) => {
  const error = `"${key}" must be an integer between ${min} and ${max}`;
  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
};

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20) return true;
  return false;
}

/**
 * A path typed into JSON. A single backslash starts an escape there, so "C:\repos" parses
 * — as C:, a carriage return and "epos" — and would point the tool at a folder nobody named.
 */
const pathText = (key: string) =>
  text(key).refine((value) => !hasControlCharacter(value), {
    error: `"${key}" contains a control character: in JSON a backslash starts an escape, so C:\\repos holds a carriage return. Write C:/repos instead`,
  });

/**
 * The config file as written. Every key is optional; defaults are applied afterwards.
 * Unknown keys are refused (see readConfigFile), except "$schema" and keys starting "_".
 */
const ConfigFile = z.object({
  githubUser: text('githubUser').nullish(),
  reposDir: pathText('reposDir').min(1, { error: '"reposDir" must not be empty' }).optional(),
  reposListFile: pathText('reposListFile').nullish(),
  knowledgeDir: pathText('knowledgeDir')
    .min(1, { error: '"knowledgeDir" must not be empty' })
    .optional(),
  model: text('model').min(1, { error: '"model" must not be empty' }).optional(),
  excludeRepos: textList(
    'excludeRepos',
    '"excludeRepos" must be an array of repo names',
  ).optional(),
  includeArchived: z.boolean({ error: '"includeArchived" must be true or false' }).optional(),
  curateConcurrency: intBetween('curateConcurrency', 1, MAX_CURATE_CONCURRENCY).optional(),
  curateTimeoutMinutes: intBetween(
    'curateTimeoutMinutes',
    1,
    MAX_CURATE_TIMEOUT_MINUTES,
  ).optional(),
  curateMaxBudgetUsd: z
    .number({ error: '"curateMaxBudgetUsd" must be a number of dollars, or null for no cap' })
    .positive({ error: '"curateMaxBudgetUsd" must be more than 0' })
    .max(MAX_CURATE_BUDGET_USD, {
      error: `"curateMaxBudgetUsd" must be at most ${MAX_CURATE_BUDGET_USD}`,
    })
    .nullish(),
  curatorEnv: z
    .record(z.string(), z.string({ error: '"curatorEnv" values must be strings' }), {
      error: '"curatorEnv" must be an object of NAME: "value" pairs',
    })
    // Checked here rather than in the record's key schema: zod reports a bad key there
    // only as "Invalid key in record", which cannot say which key.
    .superRefine((env, ctx) => {
      for (const name of Object.keys(env)) {
        if (!isValidEnvKey(name)) {
          ctx.addIssue({
            code: 'custom',
            message: `"curatorEnv" name ${JSON.stringify(name)} is not a valid environment variable`,
          });
        }
      }
    })
    .nullish(),
  refreshIgnore: textList('refreshIgnore', '"refreshIgnore" must be an array of glob strings')
    // Caught here, by name, rather than in the middle of a refresh.
    .superRefine((patterns, ctx) => {
      for (const pattern of patterns) {
        const problem = globProblem(pattern);
        if (problem !== null) {
          ctx.addIssue({
            code: 'custom',
            message: `"refreshIgnore" pattern ${JSON.stringify(pattern)}: ${problem}`,
          });
        }
      }
    })
    .nullish(),
});

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidTimeoutMinutes(value: unknown): value is number {
  return isIntegerBetween(value, 1, MAX_CURATE_TIMEOUT_MINUTES);
}

export function isValidConcurrency(value: unknown): value is number {
  return isIntegerBetween(value, 1, MAX_CURATE_CONCURRENCY);
}

/** Parses a `--concurrency <n>` flag; lives here so the CLI can define the option without loading the curator. */
export function parseConcurrency(value: string): number {
  const n = Number(value.trim() === '' ? NaN : value);
  if (!isValidConcurrency(n)) {
    throw new Error(`--concurrency must be an integer between 1 and ${MAX_CURATE_CONCURRENCY}`);
  }
  return n;
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

/** The config named by `--config` or EXPERT_CONFIG, if any. */
function explicitConfigPath(): string | null {
  const fromEnv = process.env.EXPERT_CONFIG;
  return fromEnv !== undefined && fromEnv.length > 0 ? path.resolve(fromEnv) : null;
}

function configCandidates(): string[] {
  return [path.resolve('expert.config.json'), userConfigPath(), packageRootConfigPath()];
}

/**
 * The config that would be loaded, or null if there is none. Never throws. A config that
 * was named explicitly is the only candidate: if it is missing, the answer is "none",
 * never some other collection's config.
 */
export function findConfigPath(): string | null {
  const explicit = explicitConfigPath();
  if (explicit !== null) return fs.existsSync(explicit) ? explicit : null;
  return configCandidates().find((c) => fs.existsSync(c)) ?? null;
}

function resolveDefaultConfigPath(): string {
  const explicit = explicitConfigPath();
  if (explicit !== null) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(
      `Config not found: ${explicit} (named by --config or EXPERT_CONFIG). Run \`expert init\` to create it.`,
    );
  }
  const candidates = configCandidates();
  const found = candidates.find((c) => fs.existsSync(c));
  if (found !== undefined) return found;
  throw new Error(
    `No config found. Run \`expert init\` to create one, or set EXPERT_CONFIG.\nLooked in:\n${candidates
      .map((c) => `  ${c}`)
      .join('\n')}`,
  );
}

const SETTINGS: readonly string[] = Object.keys(ConfigFile.shape);

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** ` (did you mean "excludeRepos"?)` for a near miss, or nothing. */
function nearestSetting(key: string): string {
  const folded = key.toLowerCase();
  const near =
    SETTINGS.find((s) => s.toLowerCase() === folded) ??
    SETTINGS.map((s) => ({ s, d: editDistance(folded, s.toLowerCase()) }))
      .filter((x) => x.d <= 3)
      .sort((x, y) => x.d - y.d)[0]?.s;
  return near === undefined ? '' : ` (did you mean "${near}"?)`;
}

function readConfigFile(file: string): z.infer<typeof ConfigFile> {
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    throw new Error(
      `${file} is a folder: --config and EXPERT_CONFIG name the config file itself, such as ${path.join(file, 'expert.config.json')}`,
    );
  }
  let source: string;
  try {
    source = readTextFile(file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read ${file}: ${why}`, { cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file} is not valid JSON: ${why}`, { cause: err });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file}: the config must be a JSON object, like {"reposDir": "./repos"}`);
  }
  // A misspelt key would be dropped, and a cap or an exclusion would quietly not apply.
  const unknown = Object.keys(raw).find(
    (key) => !SETTINGS.includes(key) && key !== '$schema' && !key.startsWith('_'),
  );
  if (unknown !== undefined) {
    throw new Error(
      `${file}: unknown setting "${unknown}"${nearestSetting(unknown)}. Settings are listed in SETUP.md; keys starting with "_" are free for comments.`,
    );
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    // One problem at a time, stated in the terms of the file the person has open.
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue?.message ?? 'invalid config'}`);
  }
  return parsed.data;
}

export function loadConfig(configPath?: string): ExpertConfig {
  const resolvedPath = configPath ?? resolveDefaultConfigPath();
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config not found: ${resolvedPath}`);
  }
  const file = readConfigFile(resolvedPath);
  const base = path.dirname(resolvedPath);
  const reposDir = path.resolve(base, file.reposDir ?? DEFAULTS.reposDir);
  return {
    githubUser:
      file.githubUser !== undefined && file.githubUser !== null && file.githubUser.length > 0
        ? file.githubUser
        : null,
    reposDir,
    reposListFile:
      file.reposListFile !== undefined &&
      file.reposListFile !== null &&
      file.reposListFile.length > 0
        ? path.resolve(base, file.reposListFile)
        : path.join(reposDir, REPOS_LIST_FILENAME),
    knowledgeDir: path.resolve(base, file.knowledgeDir ?? DEFAULTS.knowledgeDir),
    model: file.model ?? DEFAULTS.model,
    excludeRepos: file.excludeRepos ?? [],
    includeArchived: file.includeArchived ?? false,
    curateConcurrency: file.curateConcurrency ?? DEFAULTS.curateConcurrency,
    curateTimeoutMinutes: file.curateTimeoutMinutes ?? DEFAULTS.curateTimeoutMinutes,
    curateMaxBudgetUsd: file.curateMaxBudgetUsd ?? null,
    curatorEnv: file.curatorEnv ?? {},
    refreshIgnore: file.refreshIgnore ?? [...DEFAULT_REFRESH_IGNORE],
  };
}
