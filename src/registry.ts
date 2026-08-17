import fs from 'node:fs';
import path from 'node:path';
import { revParseHead } from './git.js';
import type { ExpertConfig } from './config.js';

export type RepoState = 'fresh' | 'stale' | 'uncurated';

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
}

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

function metaPath(knowledgeDir: string, name: string): string {
  return path.join(knowledgeDir, 'repos', name, 'meta.json');
}

export function readMeta(knowledgeDir: string, name: string): RepoMeta | null {
  const p = metaPath(knowledgeDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RepoMeta;
  } catch {
    return null;
  }
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

export async function getRepoStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid repo name: ${name}`);
  }
  const repoPath = path.join(cfg.reposDir, name);
  const currentSha = await revParseHead(repoPath);
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

export async function listRepoStatuses(cfg: ExpertConfig): Promise<RepoStatus[]> {
  if (!fs.existsSync(cfg.reposDir)) return [];
  const names = fs
    .readdirSync(cfg.reposDir)
    // excludeRepos means "pretend this isn't here" — not just "don't sync it".
    .filter((n) => !cfg.excludeRepos.includes(n))
    .filter((n) => fs.existsSync(path.join(cfg.reposDir, n, '.git')))
    .sort();
  const out: RepoStatus[] = [];
  for (const name of names) {
    try {
      out.push(await getRepoStatus(cfg, name));
    } catch {
      // Repos with no commits yet have an unborn HEAD — nothing to curate or search.
    }
  }
  return out;
}

export function stalenessBanner(status: RepoStatus): string {
  if (status.state === 'fresh') return '';
  if (status.state === 'uncurated') {
    return `⚠ repo "${status.name}" has no curated docs yet — only live code search is available.\n\n`;
  }
  return `⚠ docs curated at ${status.curatedSha!.slice(0, 7)}, repo now at ${status.currentSha.slice(0, 7)} — trust live search over summaries.\n\n`;
}
