import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExpertConfig } from '../config.js';
import {
  getRepoStatus,
  listRepoStatuses,
  stalenessBanner,
  type RepoStatus,
} from '../registry.js';

export function text(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: t }] };
}

export async function requireRepo(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  if (!fs.existsSync(path.join(cfg.reposDir, name, '.git'))) {
    throw new Error(`Unknown repo "${name}" — call list_repos to see what exists.`);
  }
  return getRepoStatus(cfg, name);
}

function knowledgeFile(cfg: ExpertConfig, ...segments: string[]): string | null {
  const p = path.join(cfg.knowledgeDir, ...segments);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
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
      return text(parts.join('\n\n---\n\n'));
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
      if (statuses.length === 0) return text('No repos mirrored. Run `expert sync` first.');
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

  return server;
}
