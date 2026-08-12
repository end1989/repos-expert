import { describe, it, expect } from 'vitest';
import { setupInstructions, createUnconfiguredServer } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createUnconfiguredServer('no config file found');
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('setupInstructions', () => {
  it('names the command that fixes it', () => {
    expect(setupInstructions('no config file found')).toMatch(/expert init/);
  });

  it('carries the underlying reason, so the cause is not hidden', () => {
    expect(setupInstructions('config was invalid JSON')).toContain('config was invalid JSON');
  });
});

describe('an MCP server with no config', () => {
  it('still connects, rather than exiting and showing the client a dead server', async () => {
    const client = await connect();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('answers every tool call with what to do about it', async () => {
    const client = await connect();
    for (const tool of (await client.listTools()).tools) {
      const res = (await client.callTool({
        name: tool.name,
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      expect(res.content[0]!.text, `tool ${tool.name}`).toMatch(/expert init/);
    }
  });
});
