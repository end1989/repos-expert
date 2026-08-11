import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ExpertConfig } from '../config.js';
import { gitLogOneline, gitLogRangeStat, listBranches } from '../git.js';
import {
  listRepoStatuses,
  writeMeta,
  type RepoStatus,
} from '../registry.js';
import {
  DOC_FILES,
  buildRepoPrompt,
  buildPortfolioPrompt,
  parseCuratedDocs,
  type RepoContext,
} from './prompts.js';

export const DOC_VERSION = 1;
export const CURATE_TIMEOUT_MS = 600_000;

export interface RunOpts {
  cwd: string;
  model: string;
  timeoutMs: number;
}

export type AgentRunner = (prompt: string, opts: RunOpts) => Promise<string>;

export const runClaudeAgent: AgentRunner = async (prompt, opts) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  try {
    const stream = query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        // Required by the installed SDK (sdk.d.ts) to actually apply
        // permissionMode: 'bypassPermissions' — without it the CLI subprocess
        // rejects the permission mode.
        allowDangerouslySkipPermissions: true,
        abortController: abort,
      },
    });
    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') return message.result;
        throw new Error(`Curator agent failed: ${message.subtype}`);
      }
    }
    throw new Error('Curator agent produced no result message');
  } finally {
    clearTimeout(timer);
  }
};

async function onceWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

function readExistingDocs(knowledgeDir: string, name: string): Record<string, string> | undefined {
  const dir = path.join(knowledgeDir, 'repos', name);
  const docs: Record<string, string> = {};
  for (const file of DOC_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) docs[file] = fs.readFileSync(p, 'utf8');
  }
  return Object.keys(docs).length > 0 ? docs : undefined;
}

export async function curateRepo(
  cfg: ExpertConfig,
  status: RepoStatus,
  runner: AgentRunner = runClaudeAgent,
): Promise<void> {
  const ctx: RepoContext = {
    name: status.name,
    gitLog: await gitLogOneline(status.path, 30),
    branches: await listBranches(status.path),
  };
  if (status.curatedSha !== null) {
    ctx.previousDocs = readExistingDocs(cfg.knowledgeDir, status.name);
    ctx.changesSincePrevious = await gitLogRangeStat(status.path, status.curatedSha);
  }
  const prompt = buildRepoPrompt(ctx);
  const docs = await onceWithRetry(async () => {
    const output = await runner(prompt, {
      cwd: status.path,
      model: cfg.model,
      timeoutMs: CURATE_TIMEOUT_MS,
    });
    return parseCuratedDocs(output, DOC_FILES);
  });
  const dir = path.join(cfg.knowledgeDir, 'repos', status.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(dir, file), content + '\n');
  }
  writeMeta(cfg.knowledgeDir, status.name, {
    sha: status.currentSha,
    curatedAt: new Date().toISOString(),
    model: cfg.model,
    docVersion: DOC_VERSION,
  });
}

const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

export async function curatePortfolio(
  cfg: ExpertConfig,
  runner: AgentRunner = runClaudeAgent,
): Promise<void> {
  const statuses = await listRepoStatuses(cfg);
  const curated = statuses.filter((s) => s.curatedSha !== null);
  if (curated.length === 0) {
    throw new Error('No curated repos yet — run `expert curate --all` first.');
  }
  const cards: Record<string, string> = {};
  const manifests: Record<string, string> = {};
  for (const s of curated) {
    cards[s.name] = fs.readFileSync(path.join(cfg.knowledgeDir, 'repos', s.name, 'card.md'), 'utf8');
    for (const mf of MANIFEST_FILES) {
      const p = path.join(s.path, mf);
      if (fs.existsSync(p)) manifests[`${s.name}/${mf}`] = fs.readFileSync(p, 'utf8').slice(0, 4000);
    }
  }
  const prompt = buildPortfolioPrompt({ cards, manifests });
  const docs = await onceWithRetry(async () => {
    const output = await runner(prompt, {
      cwd: cfg.reposDir,
      model: cfg.model,
      timeoutMs: CURATE_TIMEOUT_MS,
    });
    return parseCuratedDocs(output, ['portfolio.md', 'cross-repo-map.md']);
  });
  fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(cfg.knowledgeDir, file), content + '\n');
  }
  const repoShas: Record<string, string> = {};
  for (const s of curated) repoShas[s.name] = s.curatedSha as string;
  fs.writeFileSync(
    path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
    JSON.stringify({ curatedAt: new Date().toISOString(), repos: repoShas }, null, 2),
  );
}
