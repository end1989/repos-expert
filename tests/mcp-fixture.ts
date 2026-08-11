import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExpertConfig } from '../src/config.js';
import { writeMeta } from '../src/registry.js';
import { createServer } from '../src/mcp/server.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

function writeKnowledge(cfg: ExpertConfig, repo: string, docs: Record<string, string>): void {
  const dir = path.join(cfg.knowledgeDir, 'repos', repo);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

export async function makeFixture(): Promise<{ cfg: ExpertConfig; client: Client }> {
  const root = makeTempDir('expert-mcp-');
  const cfg: ExpertConfig = {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
    curateConcurrency: 4,
  };

  // alpha: fresh (meta.sha === HEAD)
  const alpha = path.join(cfg.reposDir, 'alpha');
  initGitRepo(alpha);
  const alphaSha = commitFile(alpha, 'src/hello.ts', 'export const greet = () => "hi";\n');
  writeKnowledge(cfg, 'alpha', {
    'card.md': '# alpha\n\nA tiny greeting library.\n',
    'architecture.md': '# Architecture\n\nSingle module in src/hello.ts.\n',
    'map.md': '# Map\n\n- src/ — the code\n',
    'activity.md': '# Activity\n\nQuiet.\n',
  });
  writeMeta(cfg.knowledgeDir, 'alpha', {
    sha: alphaSha,
    curatedAt: '2026-08-10T00:00:00Z',
    model: 'claude-sonnet-5',
    docVersion: 1,
  });

  // beta: stale (meta.sha differs)
  const beta = path.join(cfg.reposDir, 'beta');
  initGitRepo(beta);
  commitFile(beta, 'main.py', 'print("beta")\n');
  writeKnowledge(cfg, 'beta', {
    'card.md': '# beta\n\nA Python script.\n',
    'architecture.md': '# Architecture\n\nJust main.py.\n',
    'map.md': '# Map\n\n- main.py — everything\n',
    'activity.md': '# Activity\n\nUnknown.\n',
  });
  writeMeta(cfg.knowledgeDir, 'beta', {
    sha: '0000000000000000000000000000000000000000',
    curatedAt: '2026-08-01T00:00:00Z',
    model: 'claude-sonnet-5',
    docVersion: 1,
  });

  // gamma: uncurated
  const gamma = path.join(cfg.reposDir, 'gamma');
  initGitRepo(gamma);
  commitFile(gamma, 'notes.txt', 'todo: everything\n');

  // portfolio docs
  fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.knowledgeDir, 'portfolio.md'), '# Portfolio\n\nalpha, beta, gamma.\n');
  fs.writeFileSync(path.join(cfg.knowledgeDir, 'cross-repo-map.md'), '# Cross-repo\n\nNo links yet.\n');

  const server = createServer(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { cfg, client };
}

export function resultText(res: { content?: unknown }): string {
  const content = res.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}
