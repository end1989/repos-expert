import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../config.js';
import { curatorEnvFrom } from '../provider.js';
import { gitLogOneline, gitLogRangeStat, listBranches } from '../git.js';
import { isInside, resolveReal } from '../paths.js';
import {
  listRepoStatuses,
  writeMeta,
  type CitationReport,
  type RepoStatus,
  type RunStats,
} from '../registry.js';
import { runClaudeAgent, type AgentRun, type AgentRunner, type RunOpts } from './agent.js';
import { checkCitations } from './citations.js';
import { CuratorError, isWorthRetrying } from './errors.js';
import {
  DOC_FILES,
  PORTFOLIO_FILES,
  buildRepoPrompt,
  buildPortfolioPrompt,
  parseCuratedDocs,
  type RepoContext,
} from './prompts.js';

export { runClaudeAgent, type AgentRunner, type RunOpts };

export const DOC_VERSION = 1;

function runOptsFor(cfg: ExpertConfig, cwd: string): RunOpts {
  return {
    cwd,
    model: cfg.model,
    timeoutMs: cfg.curateTimeoutMinutes * 60_000,
    env: curatorEnvFrom(process.env, cfg.curatorEnv),
    ...(cfg.curateMaxBudgetUsd !== null ? { maxBudgetUsd: cfg.curateMaxBudgetUsd } : {}),
  };
}

/**
 * Runs the agent and parses its answer, with one more attempt when the failure might not
 * repeat. Every attempt is a full, paid model run, so a failure that is known to be final
 * — a timeout, a spent budget, a rejected credential — is reported, not retried. What
 * every attempt consumed is counted, whether the run ends in documents or in a failure.
 */
async function runAndParse(
  runner: AgentRunner,
  prompt: string,
  opts: RunOpts,
  expected: readonly string[],
): Promise<{ docs: Record<string, string>; stats: RunStats | undefined }> {
  let spent: RunStats | undefined;
  const attempt = async (): Promise<Record<string, string>> => {
    let run: AgentRun;
    try {
      run = await runner(prompt, opts);
    } catch (err) {
      spent = addStats(spent, err instanceof CuratorError ? err.stats : undefined);
      throw err;
    }
    spent = addStats(spent, run.stats);
    return parseCuratedDocs(run.output, expected);
  };
  try {
    let docs: Record<string, string>;
    try {
      docs = await attempt();
    } catch (err) {
      if (!isWorthRetrying(err)) throw err;
      docs = await attempt();
    }
    return { docs, stats: spent };
  } catch (err) {
    // The failure carries what its attempts spent, so a batch total can include it.
    if (spent === undefined) throw err;
    if (err instanceof CuratorError) {
      err.stats = spent;
      throw err;
    }
    throw new CuratorError('agent', err instanceof Error ? err.message : String(err), {
      cause: err,
      stats: spent,
    });
  }
}

/** Two runs' consumption as one. The session it names is the later run's. */
function addStats(a: RunStats | undefined, b: RunStats | undefined): RunStats | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    sessionId: b.sessionId,
    deniedToolCalls: a.deniedToolCalls + b.deniedToolCalls,
  };
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

/**
 * Studies one repository and writes its documents. The documents are written before
 * meta.json, so an interrupted write never stamps docs as describing a commit they were
 * not finished for. Returns what the run consumed, when the runner measured it.
 */
/** What studying one repository produced, beyond the documents themselves. */
export interface CurationOutcome {
  /** What the run consumed; absent when the runner does not measure (test doubles). */
  stats: RunStats | undefined;
  citations: CitationReport;
}

/** Broken citations kept in meta.json — enough to act on, not a dump. */
const MAX_RECORDED_BROKEN = 20;

export async function curateRepo(
  cfg: ExpertConfig,
  status: RepoStatus,
  runner: AgentRunner = runClaudeAgent,
): Promise<CurationOutcome> {
  const ctx: RepoContext = {
    name: status.name,
    gitLog: await gitLogOneline(status.path, 30),
    branches: await listBranches(status.path),
  };
  if (status.curatedSha !== null) {
    const previous = readExistingDocs(cfg.knowledgeDir, status.name);
    if (previous !== undefined) ctx.previousDocs = previous;
    const since = status.curatedSha;
    // A force-push can take the recorded commit out of history. That must not make the
    // repo impossible to study again: say so, and study it afresh with the old docs as leads.
    ctx.changesSincePrevious = await gitLogRangeStat(status.path, since).catch(
      () =>
        `The commit the previous docs were written at (${since.slice(0, 7)}) is no longer in this repository's history — the branch was rewritten. Study the repository afresh; treat the previous docs as leads to check, not as a baseline.`,
    );
  }
  const { docs, stats } = await runAndParse(
    runner,
    buildRepoPrompt(ctx),
    runOptsFor(cfg, status.path),
    DOC_FILES,
  );
  const citations = checkCitations(status.path, docs);
  const dir = path.join(cfg.knowledgeDir, 'repos', status.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of DOC_FILES) {
    fs.writeFileSync(path.join(dir, file), `${docs[file]}\n`);
  }
  writeMeta(cfg.knowledgeDir, status.name, {
    sha: status.currentSha,
    curatedAt: new Date().toISOString(),
    model: cfg.model,
    docVersion: DOC_VERSION,
    ...(stats !== undefined ? { run: stats } : {}),
    citations: {
      checked: citations.checked,
      broken: citations.broken.slice(0, MAX_RECORDED_BROKEN),
    },
  });
  return { stats, citations };
}

const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

/**
 * The start of a manifest at the top of `repo`, if it has one. The host process reads these,
 * outside the agent's confinement, so a manifest that is a link out of the repository is
 * left unread: like everything the curator reads, it is judged by where it leads.
 */
function readManifest(repo: string, file: string): string | null {
  // The path that was judged is the path that is read, not the link again.
  const real = resolveReal(path.join(repo, file));
  if (!isInside(resolveReal(repo), real)) return null;
  try {
    return fs.readFileSync(real, 'utf8').slice(0, 4000);
  } catch {
    return null; // not there, or not a file
  }
}

export async function curatePortfolio(
  cfg: ExpertConfig,
  runner: AgentRunner = runClaudeAgent,
): Promise<RunStats | undefined> {
  const statuses = await listRepoStatuses(cfg);
  const cards: Record<string, string> = {};
  const manifests: Record<string, string> = {};
  const curated = statuses.filter((s) => {
    if (s.curatedSha === null) return false;
    const cardPath = path.join(cfg.knowledgeDir, 'repos', s.name, 'card.md');
    if (!fs.existsSync(cardPath)) return false;
    cards[s.name] = fs.readFileSync(cardPath, 'utf8');
    for (const mf of MANIFEST_FILES) {
      const manifest = readManifest(s.path, mf);
      if (manifest !== null) manifests[`${s.name}/${mf}`] = manifest;
    }
    return true;
  });
  if (curated.length === 0) {
    throw new Error('No curated repos yet — run `expert curate --all` first.');
  }
  const { docs, stats } = await runAndParse(
    runner,
    buildPortfolioPrompt({ cards, manifests }),
    // The whole repos folder, minus what the config excludes.
    { ...runOptsFor(cfg, cfg.reposDir), excludeRepos: cfg.excludeRepos },
    PORTFOLIO_FILES,
  );
  fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
  for (const file of PORTFOLIO_FILES) {
    fs.writeFileSync(path.join(cfg.knowledgeDir, file), `${docs[file]}\n`);
  }
  const repoShas: Record<string, string> = {};
  for (const s of curated) {
    if (s.curatedSha !== null) repoShas[s.name] = s.curatedSha;
  }
  fs.writeFileSync(
    path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
    JSON.stringify(
      {
        curatedAt: new Date().toISOString(),
        repos: repoShas,
        ...(stats !== undefined ? { run: stats } : {}),
      },
      null,
      2,
    ),
  );
  return stats;
}
