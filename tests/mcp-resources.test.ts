import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture } from './mcp-fixture.js';

/**
 * The same knowledge the tools serve, exposed as MCP resources so clients that attach
 * context (Claude Desktop's "+" menu, VS Code) can pick a doc without a tool call.
 * The list stays linear in the number of repos: portfolio, cross-repo map, and one
 * `card` per repo; the other docs are reachable through the template and completion.
 */

function textOf(res: { contents: Array<{ text?: string }> }): string {
  return res.contents.map((c) => c.text ?? '').join('\n');
}

describe('MCP resources', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('lists the portfolio, the cross-repo map, and one card per repo — nothing else', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(
      [
        'expert://cross-repo-map',
        'expert://portfolio',
        'expert://repos/alpha/card',
        'expert://repos/beta/card',
        'expert://repos/gamma/card',
      ].sort(),
    );
    for (const r of resources) expect(r.mimeType).toBe('text/markdown');
  });

  it('exposes the per-repo docs as a template', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('expert://repos/{repo}/{doc}');
  });

  it('reads the portfolio and cross-repo map', async () => {
    expect(textOf(await client.readResource({ uri: 'expert://portfolio' }))).toContain('alpha, beta, gamma');
    expect(textOf(await client.readResource({ uri: 'expert://cross-repo-map' }))).toContain('No links yet');
  });

  it('reads a repo doc with the same provenance footer the tool adds', async () => {
    const text = textOf(await client.readResource({ uri: 'expert://repos/alpha/architecture' }));
    expect(text).toContain('Single module in src/hello.ts');
    expect(text).toMatch(/Summary written at [0-9a-f]{7}/);
    expect(text).toContain('"alpha"');
  });

  it('carries the staleness banner when the repo has moved on', async () => {
    const text = textOf(await client.readResource({ uri: 'expert://repos/beta/card' }));
    expect(text).toContain('⚠');
    expect(text).toContain('A Python script');
  });

  it('explains instead of erroring when a doc is not curated yet', async () => {
    const text = textOf(await client.readResource({ uri: 'expert://repos/gamma/card' }));
    expect(text).toMatch(/No curated card\.md for "gamma"/);
    expect(text).toContain('expert curate gamma');
  });

  it('refuses an unknown repo and an unknown doc name', async () => {
    await expect(client.readResource({ uri: 'expert://repos/nope/card' })).rejects.toThrow(/Unknown repo/);
    await expect(client.readResource({ uri: 'expert://repos/alpha/secrets' })).rejects.toThrow(/doc must be one of/);
    await expect(client.readResource({ uri: 'expert://repos/../card' })).rejects.toThrow();
  });

  it('completes repo names and doc names for the template', async () => {
    const repos = await client.complete({
      ref: { type: 'ref/resource', uri: 'expert://repos/{repo}/{doc}' },
      argument: { name: 'repo', value: 'al' },
    });
    expect(repos.completion.values).toEqual(['alpha']);
    const docs = await client.complete({
      ref: { type: 'ref/resource', uri: 'expert://repos/{repo}/{doc}' },
      argument: { name: 'doc', value: 'a' },
    });
    expect(docs.completion.values.sort()).toEqual(['activity', 'architecture']);
  });
});
