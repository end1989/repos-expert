import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeFixture } from './mcp-fixture.js';
import { createServer } from '../src/mcp/server.js';
import { startHttp, isLoopback, tokenMatches, generateToken, type HttpHandle } from '../src/mcp/http.js';

/**
 * `expert mcp --http`: the same server over Streamable HTTP, for clients that only
 * speak HTTP (Copilot Studio / M365, remote setups through a tunnel). Loopback by
 * default, bearer token always required, stateless — one server per request.
 */

async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP over HTTP', () => {
  let handle: HttpHandle;
  const token = 'test-token-not-secret';

  beforeAll(async () => {
    const { cfg } = await makeFixture();
    handle = await startHttp(() => createServer(cfg), { host: '127.0.0.1', port: 0, token });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('listens on the loopback address and reports its URL', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(handle.port).toBeGreaterThan(0);
  });

  it('serves the same tools as stdio to a client that presents the token', async () => {
    const client = await connect(handle.url, token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['find_files', 'get_repo_knowledge', 'list_repos', 'portfolio_overview', 'read_repo_file', 'search_code', 'search_knowledge'],
    );
    const res = await client.callTool({ name: 'list_repos', arguments: {} });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    expect(text).toContain('alpha');
    await client.close();
  });

  it('serves resources too', async () => {
    const client = await connect(handle.url, token);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('expert://portfolio');
    await client.close();
  });

  it('refuses a client with no token, and one with the wrong token', async () => {
    await expect(connect(handle.url)).rejects.toThrow();
    await expect(connect(handle.url, 'wrong')).rejects.toThrow();
  });

  it('answers 401 with a JSON-RPC error body and a WWW-Authenticate header', async () => {
    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/token/i);
  });

  it('exposes an unauthenticated /health that says who it is', async () => {
    const res = await fetch(handle.url.replace(/\/mcp$/, '/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('repos-expert');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('404s anything else, without a stack trace', async () => {
    const res = await fetch(handle.url.replace(/\/mcp$/, '/nope'));
    expect(res.status).toBe(404);
  });

  it('rejects a foreign Host header on a loopback bind (DNS rebinding)', async () => {
    // fetch() overwrites Host from the URL, so use a raw request that really sends it.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            host: 'evil.example.com',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
    expect(status).toBe(403);
  });
});

describe('http helpers', () => {
  it('knows loopback from everything else', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5']) expect(isLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) expect(isLoopback(h)).toBe(false);
  });

  it('matches bearer tokens exactly, tolerating the header casing and nothing else', () => {
    expect(tokenMatches('Bearer abc', 'abc')).toBe(true);
    expect(tokenMatches('bearer abc', 'abc')).toBe(true);
    expect(tokenMatches('Bearer abcd', 'abc')).toBe(false);
    expect(tokenMatches('Bearer ab', 'abc')).toBe(false);
    expect(tokenMatches('abc', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(tokenMatches('Bearer ', '')).toBe(false);
  });

  it('generates URL-safe tokens that are long enough to matter', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(generateToken()).not.toBe(t);
  });
});
