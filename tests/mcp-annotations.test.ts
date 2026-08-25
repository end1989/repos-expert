import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUnconfiguredServer } from '../src/mcp/server.js';
import { makeFixture } from './mcp-fixture.js';

/**
 * Every tool on this server reads; not one of them writes. Hosts use the four
 * annotation hints to decide whether to warn someone before a call, and a directory
 * that ingests the server rejects tools where any of the four is missing or
 * non-boolean. So the contract is all four, explicitly, on every tool — not "the
 * interesting ones where it seemed worth saying".
 */
const EXPECTED = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const HINTS = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

async function unconfiguredClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createUnconfiguredServer('no config file found');
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('tool annotations', () => {
  it('declares all four hints, as booleans, on every tool', async () => {
    const { client } = await makeFixture();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(7);
    for (const tool of tools) {
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(tool.annotations, `tool ${tool.name}`).toMatchObject(EXPECTED);
    }
  });

  it('declares the same hints when unconfigured, so the tool list keeps its shape', async () => {
    const client = await unconfiguredClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(7);
    for (const tool of tools) {
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(tool.annotations, `tool ${tool.name}`).toMatchObject(EXPECTED);
    }
  });
});
