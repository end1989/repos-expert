import fs from 'node:fs';
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
    cfg.githubUser === null
      ? 'GitHub is not configured, and is not required.'
      : `Or run \`expert sync\` to pull them from the GitHub account "${cfg.githubUser}".`,
  ].join('\n');
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

export function createServer(cfg: ExpertConfig): McpServer {
  const server = new McpServer({ name: 'repos-expert', version: '0.1.0' });

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
      description: 'List every mirrored repo with curation state and a one-line summary.',
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
        'Curated knowledge docs for one repo: card (default), architecture, map, or activity.',
      inputSchema: {
        repo: z.string(),
        doc: z.enum(['card', 'architecture', 'map', 'activity']).optional(),
      },
    },
    async ({ repo, doc }) => {
      const status = await requireRepo(cfg, repo);
      const file = `${doc ?? 'card'}.md`;
      const content = knowledgeFile(cfg, 'repos', repo, file);
      if (content === null) {
        return text(`No curated ${file} for "${repo}" yet — run \`expert curate ${repo}\`.`);
      }
      return text(stalenessBanner(status) + content);
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
        'Live ripgrep over the repo mirrors. Searches all repos unless "repo" is given. "glob" filters file names (e.g. *.ts).',
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
      description: 'List files matching a glob pattern, in one repo or all mirrors.',
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
        'Read one file from a repo mirror (max 2,000 lines / 200 KB). Lines are 1-based inclusive.',
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
