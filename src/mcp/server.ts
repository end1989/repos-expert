import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ExpertConfig } from '../config.js';
import {
  getRepoStatus,
  listRepoStatuses,
  readMeta,
  stalenessBanner,
  type RepoStatus,
} from '../registry.js';
import { searchText, listFiles } from '../rg.js';
import { resolveWithin, readFileCapped } from './guards.js';

export function text(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: t }] };
}

export async function requireRepo(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Unknown repo "${name}" — call list_repos to see what exists.`);
  }
  if (!fs.existsSync(path.join(cfg.reposDir, name, '.git'))) {
    throw new Error(`Unknown repo "${name}" — call list_repos to see what exists.`);
  }
  return getRepoStatus(cfg, name);
}

function knowledgeFile(cfg: ExpertConfig, ...segments: string[]): string | null {
  const p = path.join(cfg.knowledgeDir, ...segments);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function portfolioStalenessBanner(cfg: ExpertConfig, statuses: RepoStatus[]): string {
  let recorded: Record<string, string> | undefined;
  try {
    const raw = fs.readFileSync(path.join(cfg.knowledgeDir, 'portfolio-meta.json'), 'utf8');
    recorded = (JSON.parse(raw) as { repos?: Record<string, string> }).repos;
  } catch {
    return '';
  }
  if (recorded === undefined) return '';
  const changed: string[] = [];
  for (const s of statuses) {
    if (s.curatedSha === null) continue;
    const currentSha = readMeta(cfg.knowledgeDir, s.name)?.sha;
    const recordedSha = recorded[s.name];
    if (recordedSha === undefined || recordedSha !== currentSha) {
      changed.push(s.name);
    }
  }
  if (changed.length === 0) return '';
  return `⚠ portfolio docs are out of date (re-curated since: ${changed.join(', ')}) — run \`expert curate --portfolio\`.\n\n`;
}

/**
 * Every tool degrades to "here is what I can still do" rather than an error:
 * an empty folder is a setup step, not a broken install.
 */
export function noReposHint(cfg: ExpertConfig): string {
  const dirExists = fs.existsSync(cfg.reposDir);
  return [
    dirExists
      ? `No git repositories found in ${cfg.reposDir}.`
      : `The repos folder does not exist yet: ${cfg.reposDir}.`,
    'Put repo folders there (clone or copy them in) and they are analyzable immediately —',
    'code search and file reading need nothing else. Run `expert curate --stale` to add written docs.',
    `To have them cloned instead, list git URLs in ${cfg.reposListFile} and run \`expert sync\`.`,
    cfg.githubUser === null
      ? 'A GitHub account is not configured, and is not required.'
      : `\`expert sync\` also pulls everything from the GitHub account "${cfg.githubUser}".`,
  ].join('\n');
}

/** Reminds the client, at the point of use, that this was written — and is checkable. */
export function provenanceFooter(status: RepoStatus): string {
  const written =
    status.curatedSha === null ? 'not yet written' : `written at ${status.curatedSha.slice(0, 7)}`;
  return `\n\n---\nSummary ${written}; the repo is at ${status.currentSha.slice(0, 7)}. Read the source with search_code / read_repo_file on "${status.name}" to confirm anything specific.`;
}

function cardSummary(cfg: ExpertConfig, name: string): string {
  const card = knowledgeFile(cfg, 'repos', name, 'card.md');
  if (card === null) return '(uncurated)';
  const line = card
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return (line ?? '(empty card)').slice(0, 120);
}

// Read the real version rather than a literal that silently drifts from package.json.
const { version: SERVER_VERSION } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

/**
 * Sent to the client once at connect. The knowledge docs are a model's written
 * summary, not ground truth, and the client is holding tools that can check them —
 * saying so is what keeps a stale sentence from becoming a confident wrong answer.
 */
export const SERVER_INSTRUCTIONS = `This server answers questions about a collection of code repositories.

Two kinds of information, and they are not equally authoritative:

1. Written knowledge (portfolio_overview, list_repos, get_repo_knowledge,
   search_knowledge). Documents an AI agent wrote after reading each repository:
   purpose, architecture, directory map, recent activity, and interfaces. They carry
   understanding you cannot get from grep — why a project exists, how repos relate —
   but they are a snapshot, written at a specific commit, and code moves on.

2. The actual source code (search_code, find_files, read_repo_file). Always current,
   always literal.

Use the documents to orient and to answer conceptual and cross-repo questions. Then:

- The repositories are open to you. If something in a document looks wrong, contradicts
  itself, or does not match what the user is describing, go read the code and settle it.
  You do not need permission, and you do not need to ask first.
- Verify what matters, not everything. Re-checking every sentence wastes the point of
  having summaries. Do check before stating something the user will act on: an exact
  endpoint, a function signature, a file path, whether a feature actually exists.
- A ⚠ banner means the documents are older than the code. Treat those claims as leads to
  confirm, not as facts.
- interfaces.md is the verified contract surface (routes, commands, exports, env vars,
  data models). It separates what the code implements from what is only described in
  documentation — respect that distinction when you quote it.
- If the documents and the code disagree, the code wins. Say so plainly to the user, and
  mention that re-running \`expert refresh <repo>\` will bring the documents back in line.`;

/**
 * What every tool says when there is no usable config. An MCP client that cannot
 * start a server shows a red light and a stack trace in a log nobody opens; a server
 * that starts and explains itself is repairable by the person holding the chat window.
 */
export function setupInstructions(reason: string): string {
  return [
    'repos-expert is installed but not set up yet, so there is nothing to search.',
    '',
    `Reason: ${reason}`,
    '',
    'To fix it, in a terminal:',
    '  expert init          # asks where your projects are, writes the config',
    '  expert add <url>     # add a project (or copy folders into that directory)',
    '  expert refresh <name>  # study one, so there is something to answer from',
    '',
    'Tell the user this — they have to run it; you cannot. Nothing else here will work',
    'until they do, so do not retry these tools in the meantime.',
  ].join('\n');
}

/**
 * A server that answers honestly instead of failing to start. Deliberately exposes
 * the same tool names as the real one so the client's tool list does not change shape
 * between "set up" and "not set up".
 */
export function createUnconfiguredServer(reason: string): McpServer {
  const server = new McpServer(
    { name: 'repos-expert', version: SERVER_VERSION },
    { instructions: setupInstructions(reason) },
  );
  const message = setupInstructions(reason);
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      { description: 'Unavailable until repos-expert is set up — call it to see how.', inputSchema: {} },
      async () => text(message),
    );
  }
  return server;
}

/** Every tool this server exposes; the unconfigured server mirrors the list. */
const TOOL_NAMES = [
  'portfolio_overview',
  'list_repos',
  'get_repo_knowledge',
  'search_knowledge',
  'search_code',
  'find_files',
  'read_repo_file',
] as const;

export function createServer(cfg: ExpertConfig): McpServer {
  const server = new McpServer(
    { name: 'repos-expert', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'portfolio_overview',
    {
      description:
        'The whole portfolio: what repos exist, how they fit together, and which docs are stale.',
      inputSchema: {},
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      if (statuses.length === 0) return text(noReposHint(cfg));
      const stale = statuses.filter((s) => s.state === 'stale').map((s) => s.name);
      const uncurated = statuses.filter((s) => s.state === 'uncurated').map((s) => s.name);
      const parts: string[] = [];
      parts.push(
        knowledgeFile(cfg, 'portfolio.md') ??
          '(portfolio.md not yet curated — run `expert curate --portfolio`)',
      );
      parts.push(
        knowledgeFile(cfg, 'cross-repo-map.md') ??
          '(cross-repo-map.md not yet curated — run `expert curate --portfolio`)',
      );
      parts.push(
        [
          `Repos: ${statuses.length}`,
          `stale: ${stale.length > 0 ? stale.join(', ') : 'none'}`,
          `uncurated: ${uncurated.length > 0 ? uncurated.join(', ') : 'none'}`,
        ].join('\n'),
      );
      return text(portfolioStalenessBanner(cfg, statuses) + parts.join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'list_repos',
    {
      description: 'List every repo available, with a one-line summary and whether its docs are current.',
      inputSchema: {},
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      if (statuses.length === 0) return text(noReposHint(cfg));
      const lines = statuses.map((s) => `${s.name} [${s.state}] — ${cardSummary(cfg, s.name)}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_repo_knowledge',
    {
      description:
        'Curated knowledge docs for one repo. "interfaces" is the verified contract surface — routes, CLI commands, exports, env vars, data models, outbound calls — and is usually the fastest answer to "what does this expose?".',
      inputSchema: {
        repo: z.string(),
        doc: z.enum(['card', 'architecture', 'map', 'activity', 'interfaces']).optional(),
      },
    },
    async ({ repo, doc }) => {
      const status = await requireRepo(cfg, repo);
      const file = `${doc ?? 'card'}.md`;
      const content = knowledgeFile(cfg, 'repos', repo, file);
      if (content === null) {
        return text(
          `No curated ${file} for "${repo}" yet — run \`expert curate ${repo}\`. ` +
            `You can still read the code directly with search_code, find_files, and read_repo_file.`,
        );
      }
      return text(stalenessBanner(status) + content + provenanceFooter(status));
    },
  );

  server.registerTool(
    'search_knowledge',
    {
      description: 'Full-text search across all curated knowledge docs.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => text(await searchText(cfg.knowledgeDir, query)),
  );

  server.registerTool(
    'search_code',
    {
      description:
        'Search the real source code of the repos, right now. Searches all repos unless "repo" is given. "glob" filters file names (e.g. *.ts).',
      inputSchema: { query: z.string(), repo: z.string().optional(), glob: z.string().optional() },
    },
    async ({ query, repo, glob }) => {
      if (repo === undefined) return text(await searchText(cfg.reposDir, query, glob));
      const status = await requireRepo(cfg, repo);
      return text(stalenessBanner(status) + (await searchText(status.path, query, glob)));
    },
  );

  server.registerTool(
    'find_files',
    {
      description: 'List files matching a glob pattern, in one repo or across all of them.',
      inputSchema: { pattern: z.string(), repo: z.string().optional() },
    },
    async ({ pattern, repo }) => {
      const root = repo === undefined ? cfg.reposDir : (await requireRepo(cfg, repo)).path;
      return text(await listFiles(root, pattern));
    },
  );

  server.registerTool(
    'read_repo_file',
    {
      description:
        'Read one file from a repo (max 2,000 lines / 200 KB). Lines are 1-based inclusive.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
    },
    async ({ repo, path: relPath, startLine, endLine }) => {
      const status = await requireRepo(cfg, repo);
      const abs = resolveWithin(status.path, relPath);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found in "${repo}": ${relPath}`);
      }
      return text(stalenessBanner(status) + readFileCapped(abs, startLine, endLine));
    },
  );

  return server;
}

export async function startMcp(cfg: ExpertConfig): Promise<void> {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}

/**
 * The entry point an MCP client actually launches. Loading the config is allowed to
 * fail: a client cannot act on a process that exited, but it can relay a sentence
 * telling the user which command to run.
 */
export async function startMcpOrExplain(loadCfg: () => ExpertConfig): Promise<void> {
  let server: McpServer;
  try {
    server = createServer(loadCfg());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // stderr only — stdout is the protocol.
    console.error(`repos-expert: starting in setup mode. ${reason}`);
    server = createUnconfiguredServer(reason);
  }
  await server.connect(new StdioServerTransport());
}
