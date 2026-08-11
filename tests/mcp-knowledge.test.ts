import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';

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
});
