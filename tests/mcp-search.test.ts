import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';

describe('MCP search and read tools', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('search_code searches all repos, or one repo with a banner when stale', async () => {
    const all = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'greet' } }),
    );
    expect(all).toContain('hello.ts');

    const one = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'beta', repo: 'beta' } }),
    );
    expect(one).toContain('main.py');
    expect(one).toContain('trust live search over summaries');
  });

  it('search_knowledge searches the curated docs', async () => {
    const out = resultText(
      await client.callTool({ name: 'search_knowledge', arguments: { query: 'greeting library' } }),
    );
    expect(out).toContain('card.md');
  });

  it('find_files globs within one repo', async () => {
    const out = resultText(
      await client.callTool({ name: 'find_files', arguments: { pattern: '*.ts', repo: 'alpha' } }),
    );
    expect(out).toContain('hello.ts');
    expect(out).not.toContain('main.py');
  });

  it('read_repo_file returns content and honors line ranges', async () => {
    const out = resultText(
      await client.callTool({
        name: 'read_repo_file',
        arguments: { repo: 'alpha', path: 'src/hello.ts' },
      }),
    );
    expect(out).toContain('export const greet');
  });

  it('read_repo_file blocks path traversal', async () => {
    const res = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'alpha', path: '../beta/main.py' },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('escapes');
  });

  it('search_code errors on unknown repo', async () => {
    const res = await client.callTool({
      name: 'search_code',
      arguments: { query: 'x', repo: 'nope' },
    });
    expect(res.isError).toBe(true);
  });
});
