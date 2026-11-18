import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { VERSION } from '../version.js';

/**
 * The MCP server over Streamable HTTP, for clients that only speak HTTP — Copilot
 * Studio / M365, or a remote client through a tunnel. Design choices, all deliberate:
 *
 * - **Loopback by default.** `--host 0.0.0.0` is allowed, and loudly warned about.
 * - **A bearer token is always required.** There is no unauthenticated mode, not even
 *   on loopback: a browser tab can reach 127.0.0.1 too. If none is given, one is
 *   generated and printed to stderr once.
 * - **Stateless.** One McpServer and one transport per request; the tools are read-only
 *   and per-request construction is cheap. No sessions to leak or expire, and so nothing
 *   to stream: only POST is served.
 * - **DNS-rebinding protection on loopback.** The Host header must name a loopback host
 *   and this port; on a non-loopback bind the caller has chosen to be reachable and the
 *   token is the control.
 * - **No cross-site browser requests.** A request carrying an Origin header must come
 *   from a page served on this machine, as the MCP transport spec requires servers to
 *   check.
 * - **Nothing a client sends can crash the process.** Every request is handled inside one
 *   catch; a request target that does not parse is a 400, not an exception.
 * - **No express.** Node's http is enough; the SDK transport does the protocol.
 */

export interface HttpOptions {
  host: string;
  /** 0 picks a free port; the chosen one is on the handle. */
  port: number;
  token: string;
  /** Path the MCP endpoint answers on. Default /mcp. */
  path?: string;
}

export interface HttpHandle {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:7411/mcp */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 32 URL-safe characters (192 bits) — long enough that guessing is not a plan. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** `Authorization: Bearer <token>`, compared in constant time. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || token.length === 0) return false;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (m === null) return false;
  const given = Buffer.from(m[1] ?? '', 'utf8');
  const want = Buffer.from(token, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

/** The path part of a request target, or null when it does not parse. The host is irrelevant here. */
function requestPath(target: string | undefined): string | null {
  try {
    return new URL(target ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a Host header names this loopback server: a loopback host, and this port when
 * it gives one. Anything else on a loopback bind is a DNS-rebinding attempt.
 */
export function isOwnLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (hostHeader === undefined) return false;
  let url: URL;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  return isLoopback(url.hostname) && (url.port === '' || Number(url.port) === port);
}

/** Whether an Origin header belongs to a page served from this machine. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" an opaque origin sends
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname);
}

/**
 * Starts listening. `makeServer` is called once per request — pass a closure over the
 * config (or the setup-mode server when there is none).
 */
export async function startHttp(
  makeServer: () => McpServer,
  opts: HttpOptions,
): Promise<HttpHandle> {
  const mcpPath = opts.path ?? '/mcp';
  const loopback = isLoopback(opts.host);
  let boundPort = opts.port;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = requestPath(req.url);
    if (pathname === null) {
      json(res, 400, rpcError(-32600, 'Bad request: the request target is not a valid path.'));
      return;
    }
    if (pathname === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true, name: 'repos-expert', version: VERSION, mcp: mcpPath });
      return;
    }
    if (pathname !== mcpPath) {
      json(
        res,
        404,
        rpcError(-32601, `Not found. The MCP endpoint is ${mcpPath}; /health says who this is.`),
      );
      return;
    }
    if (loopback && !isOwnLoopbackHost(req.headers.host, boundPort)) {
      json(
        res,
        403,
        rpcError(
          -32000,
          'Forbidden: this server only answers requests addressed to its loopback address.',
        ),
      );
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      json(res, 403, rpcError(-32000, 'Forbidden: cross-site requests are not accepted.'));
      return;
    }
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      json(
        res,
        401,
        rpcError(
          -32001,
          'Unauthorized: this server needs "Authorization: Bearer <token>" — the token was printed when it started.',
        ),
        {
          'www-authenticate': 'Bearer realm="repos-expert"',
        },
      );
      return;
    }
    if (req.method !== 'POST') {
      json(
        res,
        405,
        rpcError(-32000, 'Method not allowed: this stateless server answers POST only.'),
        { allow: 'POST' },
      );
      return;
    }

    const mcp = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // stderr only; never a stack trace to the client.
      console.error(`repos-expert http: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 500, rpcError(-32603, 'Internal error'));
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The HTTP server did not report a TCP address.');
  boundPort = address.port;
  const hostForUrl =
    opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host;

  return {
    url: `http://${hostForUrl}:${boundPort}${mcpPath}`,
    host: opts.host,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
