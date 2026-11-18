import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { revParseHead } from './git.js';
import { isExcluded, type ExpertConfig } from './config.js';

export type RepoState = 'fresh' | 'stale' | 'uncurated';

/** What one curator run consumed, as the agent runtime reported it. Stored in meta.json. */
export interface RunStats {
  /** The runtime's own estimate — an order of magnitude, not a bill. */
  costUsd: number;
  turns: number;
  durationMs: number;
  /** Everything the model read: fresh input plus cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  /** Names the saved agent transcript, for looking at what the agent actually did. */
  sessionId: string;
  /** Tool calls refused for reaching outside the repository. Above zero deserves a look. */
  deniedToolCalls: number;
}

export interface BrokenCitation {
  doc: string;
  citation: string;
  reason: string;
}

/** The mechanical check of the docs' file:line citations (see curator/citations.ts). */
export interface CitationReport {
  checked: number;
  broken: BrokenCitation[];
}

export interface RepoMeta {
  sha: string;
  curatedAt: string;
  model: string;
  docVersion: number;
  /**
   * Set by the refresh fast path: the code was unchanged (only ignorable paths moved)
   * from `sha` through this commit, so the docs still hold without a model run.
   */
  verifiedSha?: string;
  /** The run that wrote these docs. Absent for docs written before this was recorded. */
  run?: RunStats;
  /** How many file:line citations in the docs were checked, and which did not resolve. */
  citations?: CitationReport;
}

/** meta.json is read on every MCP call, so a malformed one must read as "not curated", not crash. */
const SHA = z.string().regex(/^[0-9a-f]{4,64}$/i);
const MetaFile = z.object({
  sha: SHA,
  curatedAt: z.string(),
  model: z.string(),
  docVersion: z.number(),
  verifiedSha: SHA.optional(),
  run: z
    .object({
      costUsd: z.number(),
      turns: z.number(),
      durationMs: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      sessionId: z.string(),
      deniedToolCalls: z.number(),
    })
    .optional(),
  citations: z
    .object({
      checked: z.number(),
      broken: z.array(z.object({ doc: z.string(), citation: z.string(), reason: z.string() })),
    })
    .optional(),
});

export interface RepoStatus {
  name: string;
  path: string;
  currentSha: string;
  curatedSha: string | null;
  curatedAt: string | null;
  /** When fresh only by verification: the commit the docs were confirmed to hold through. */
  verifiedThrough: string | null;
  state: RepoState;
}

/** A folder in the repos folder that is not served, and why. */
export interface SkippedRepo {
  name: string;
  reason: string;
}

/** The one rule for a repo name: what may reach a path or a command line. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function metaPath(knowledgeDir: string, name: string): string {
  return path.join(knowledgeDir, 'repos', name, 'meta.json');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function readMeta(knowledgeDir: string, name: string): RepoMeta | null {
  const parsed = MetaFile.safeParse(readJson(metaPath(knowledgeDir, name)));
  if (!parsed.success) return null;
  const { verifiedSha, run, citations, ...required } = parsed.data;
  return {
    ...required,
    ...(verifiedSha !== undefined ? { verifiedSha } : {}),
    ...(run !== undefined ? { run } : {}),
    ...(citations !== undefined ? { citations } : {}),
  };
}

export function writeMeta(knowledgeDir: string, name: string, meta: RepoMeta): void {
  const p = metaPath(knowledgeDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

/** Records that the docs written at meta.sha still hold at `throughSha` (code unchanged). */
export function markVerified(knowledgeDir: string, name: string, throughSha: string): void {
  const meta = readMeta(knowledgeDir, name);
  if (meta === null) return;
  writeMeta(knowledgeDir, name, { ...meta, verifiedSha: throughSha });
}

/** A repo whose HEAD does not resolve yet: `git init` with nothing committed. */
export class NoCommitsError extends Error {
  constructor(name: string) {
    super(
      `Repo "${name}" has no commits yet — there is nothing to read or study until something is committed.`,
    );
    this.name = 'NoCommitsError';
  }
}

export async function getRepoStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  if (!isValidRepoName(name)) {
    throw new Error(`Invalid repo name: ${name}`);
  }
  const repoPath = path.join(cfg.reposDir, name);
  // Checked here, not left to git: inside a folder that is itself a repository, git would
  // happily answer for the enclosing one.
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`"${name}" is not a git repository (no .git in ${repoPath}).`);
  }
  let currentSha: string;
  try {
    currentSha = await revParseHead(repoPath);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (/unknown revision|ambiguous argument 'HEAD'|does not have any commits/i.test(why)) {
      throw new NoCommitsError(name);
    }
    throw err;
  }
  const meta = readMeta(cfg.knowledgeDir, name);
  const verified = meta !== null && meta.sha !== currentSha && meta.verifiedSha === currentSha;
  const state: RepoState =
    meta === null ? 'uncurated' : meta.sha === currentSha || verified ? 'fresh' : 'stale';
  return {
    name,
    path: repoPath,
    currentSha,
    curatedSha: meta?.sha ?? null,
    curatedAt: meta?.curatedAt ?? null,
    verifiedThrough: verified ? currentSha : null,
    state,
  };
}

/** git processes at once while scanning — enough to hide latency, few enough to be polite. */
const SCAN_CONCURRENCY = 8;

/**
 * Every repo in the folder, sorted by name, and every folder that looks like one but
 * cannot be served, with the reason. Nothing disappears without a word.
 */
export async function scanRepos(
  cfg: ExpertConfig,
): Promise<{ statuses: RepoStatus[]; skipped: SkippedRepo[] }> {
  if (!fs.existsSync(cfg.reposDir)) return { statuses: [], skipped: [] };
  const names = fs
    .readdirSync(cfg.reposDir)
    // excludeRepos means "pretend this isn't here" — not just "don't sync it".
    .filter((n) => !isExcluded(cfg, n))
    .filter((n) => fs.existsSync(path.join(cfg.reposDir, n, '.git')))
    .sort();
  const results: ({ status: RepoStatus } | { skipped: SkippedRepo } | undefined)[] = Array.from(
    { length: names.length },
    () => undefined,
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < names.length; i = next++) {
      const name = names[i] ?? '';
      try {
        results[i] = { status: await getRepoStatus(cfg, name) };
      } catch (err) {
        const reason =
          err instanceof NoCommitsError
            ? 'no commits yet'
            : !isValidRepoName(name)
              ? 'folder name has characters a repo name cannot (use letters, digits, . _ -)'
              : ((err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unreadable');
        results[i] = { skipped: { name, reason } };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, names.length) }, () => worker()),
  );
  const statuses: RepoStatus[] = [];
  const skipped: SkippedRepo[] = [];
  for (const r of results) {
    if (r === undefined) continue;
    if ('status' in r) statuses.push(r.status);
    else skipped.push(r.skipped);
  }
  return { statuses, skipped };
}

export async function listRepoStatuses(cfg: ExpertConfig): Promise<RepoStatus[]> {
  return (await scanRepos(cfg)).statuses;
}

/**
 * Which studied repos have docs the portfolio has not seen: re-curated since it was
 * written — at a new commit, or rewritten at the same one — studied for the first time,
 * or gone. Null when there is no portfolio yet. Times are compared as written by this
 * machine's clock; the refresh lock keeps a portfolio pass and a study from overlapping.
 */
export function portfolioDrift(
  knowledgeDir: string,
  statuses: readonly RepoStatus[],
): string[] | null {
  const raw = readJson(path.join(knowledgeDir, 'portfolio-meta.json'));
  const parsed = z
    .object({ curatedAt: z.string().optional(), repos: z.record(z.string(), z.string()) })
    .safeParse(raw);
  if (!parsed.success) return null;
  const recorded = parsed.data.repos;
  const portfolioAt = Date.parse(parsed.data.curatedAt ?? '');
  const changed = new Set<string>();
  const studied = statuses.filter((s) => s.curatedSha !== null);
  for (const s of studied) {
    const meta = readMeta(knowledgeDir, s.name);
    const current = meta?.sha ?? s.curatedSha;
    const docsAt = Date.parse(meta?.curatedAt ?? '');
    const rewrittenSince = docsAt > portfolioAt; // false when either time is unreadable
    if (recorded[s.name] !== current || rewrittenSince) changed.add(s.name);
  }
  const present = new Set(studied.map((s) => s.name));
  for (const name of Object.keys(recorded)) if (!present.has(name)) changed.add(name);
  return [...changed].sort();
}

export function stalenessBanner(status: RepoStatus): string {
  if (status.state === 'fresh') return '';
  if (status.state === 'uncurated' || status.curatedSha === null) {
    return `⚠ repo "${status.name}" has no curated docs yet — only live code search is available.\n\n`;
  }
  return `⚠ docs curated at ${status.curatedSha.slice(0, 7)}, repo now at ${status.currentSha.slice(0, 7)} — trust live search over summaries.\n\n`;
}
