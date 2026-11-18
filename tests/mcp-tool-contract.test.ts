import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';

/**
 * What a model sees of each tool is its name, its title, its description and the
 * description of each parameter — nothing else. A parameter without a description is a
 * parameter the model has to guess about.
 */
describe('tool contract', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('gives every tool a human-readable title', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, tool.name).toMatch(/\S/);
    }
  });

  it('describes every parameter of every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: unknown }
      >;
      for (const [name, schema] of Object.entries(props)) {
        expect(typeof schema.description, `${tool.name}.${name}`).toBe('string');
        expect((schema.description as string).length, `${tool.name}.${name}`).toBeGreaterThan(15);
      }
    }
  });

  it('tells the model that search queries are regular expressions', async () => {
    const { tools } = await client.listTools();
    for (const name of ['search_code', 'search_knowledge']) {
      const props: Record<string, { description?: string }> | undefined = tools.find(
        (t) => t.name === name,
      )?.inputSchema.properties;
      expect(props?.query?.description, name).toMatch(/regular expression/i);
    }
  });
});

describe('list_repos structured output', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('declares an output schema, so a client knows the shape before calling', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'list_repos')?.outputSchema as
      { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['repos']);
  });

  it('returns each repo with its state and both commits as data, alongside the text', async () => {
    const res = await client.callTool({ name: 'list_repos', arguments: {} });
    const data = res.structuredContent as {
      repos: { name: string; state: string; currentSha: string; curatedSha: string | null }[];
    };
    expect(data.repos.map((r) => [r.name, r.state])).toEqual([
      ['alpha', 'fresh'],
      ['beta', 'stale'],
      ['gamma', 'uncurated'],
    ]);
    expect(data.repos[0]?.currentSha).toMatch(/^[0-9a-f]{40}$/);
    expect(data.repos[1]?.curatedSha).toBe('0'.repeat(40));
    expect(data.repos[2]?.curatedSha).toBeNull();
    expect(resultText(res)).toContain('beta [stale]');
  });
});

describe('search_code', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('searches for text exactly as written when literal is set', async () => {
    const res = await client.callTool({
      name: 'search_code',
      arguments: { query: 'greet = (', literal: true },
    });
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('alpha/src/hello.ts:1:');
  });

  it('answers an invalid regular expression with an error that says how to fix it', async () => {
    const res = await client.callTool({ name: 'search_code', arguments: { query: 'greet = (' } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/literal: true/);
  });
});
