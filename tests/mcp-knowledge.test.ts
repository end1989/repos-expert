import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';
import { SERVER_INSTRUCTIONS, provenanceFooter } from '../src/mcp/server.js';

describe('telling the client how much to trust the docs', () => {
  it('grants permission to go read the code, and says the code wins', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/repositories are open to you/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not need permission/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/the code wins/i);
  });

  it('warns against re-verifying everything, which would defeat the summaries', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Verify what matters, not everything/i);
  });

  it('footer names both commits and the repo to check against', () => {
    const footer = provenanceFooter({
      name: 'alpha',
      path: '/repos/alpha',
      currentSha: 'b'.repeat(40),
      curatedSha: 'a'.repeat(40),
      curatedAt: '2026-08-11T00:00:00Z',
      state: 'stale',
    });
    expect(footer).toContain('written at aaaaaaa');
    expect(footer).toContain('repo is at bbbbbbb');
    expect(footer).toContain('"alpha"');
  });
});

describe('MCP knowledge tools', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('portfolio_overview returns portfolio docs and a staleness summary', async () => {
    const res = await client.callTool({ name: 'portfolio_overview', arguments: {} });
    const text = resultText(res);
    expect(text).toContain('alpha, beta, gamma');
    expect(text).toContain('No links yet');
    expect(text).toContain('stale: beta');
    expect(text).toContain('uncurated: gamma');
  });

  it('list_repos shows every repo with state and one-line summary', async () => {
    const text = resultText(await client.callTool({ name: 'list_repos', arguments: {} }));
    expect(text).toContain('alpha [fresh] — A tiny greeting library.');
    expect(text).toContain('beta [stale]');
    expect(text).toContain('gamma [uncurated]');
  });

  it('get_repo_knowledge returns card by default and honors doc param', async () => {
    const card = resultText(
      await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'alpha' } }),
    );
    expect(card).toContain('greeting library');
    expect(card).not.toContain('⚠');
    const arch = resultText(
      await client.callTool({
        name: 'get_repo_knowledge',
        arguments: { repo: 'alpha', doc: 'architecture' },
      }),
    );
    expect(arch).toContain('src/hello.ts');
  });

  it('prefixes stale repo docs with the staleness banner', async () => {
    const text = resultText(
      await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'beta' } }),
    );
    expect(text).toContain('trust live search over summaries');
    expect(text).toContain('A Python script');
  });

  it('errors on unknown repos', async () => {
    const res = await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'nope' } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown repo');
  });

  it('rejects path-traversal repo names', async () => {
    const res = await client.callTool({
      name: 'get_repo_knowledge',
      arguments: { repo: '../escape' },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown repo');
  });

  it('portfolio_overview flags stale portfolio docs when a recorded repo sha no longer matches', async () => {
    const { cfg, client: freshClient } = await makeFixture();
    fs.writeFileSync(
      path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
      JSON.stringify({
        curatedAt: '2026-08-01T00:00:00Z',
        repos: { alpha: 'deadbeef'.repeat(5) },
      }),
    );
    const text = resultText(
      await freshClient.callTool({ name: 'portfolio_overview', arguments: {} }),
    );
    expect(text).toContain('portfolio docs are out of date');
    expect(text).toContain('alpha');
  });
});
