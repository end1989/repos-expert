import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

/**
 * The built CLI, launched the way an MCP client launches it. stdout is the protocol: a
 * single stray line of anything else breaks the client, so every line must be JSON-RPC.
 */
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'cli',
  'index.js',
);

interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: { tools?: { name: string }[]; serverInfo?: { name: string } };
}

/** How long a stdio server may take to exit once its input closes. */
const EXIT_GRACE_MS = 5_000;

function parseOrNothing(line: string): RpcMessage[] {
  try {
    return [JSON.parse(line) as RpcMessage];
  } catch {
    return []; // the per-line assertion in the test names the offending line
  }
}

async function converse(
  configPath: string,
): Promise<{ lines: string[]; messages: RpcMessage[]; stderr: string; exited: boolean }> {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, EXPERT_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-test', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const deadline = Date.now() + 15_000;
  while (!stdout.includes('"id":2') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.stdin.end(); // a well-behaved stdio server exits when its input closes
  const exited =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), EXIT_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    }));
  if (!exited) child.kill(); // fail the test, never hang it

  const lines = stdout.split('\n').filter((l) => l.length > 0);
  return { lines, messages: lines.flatMap(parseOrNothing), stderr, exited };
}

describe('expert mcp over stdio', () => {
  it('speaks nothing but JSON-RPC on stdout and lists its seven tools', async () => {
    const root = makeTempDir('expert-stdio-');
    const repo = path.join(root, 'repos', 'alpha');
    initGitRepo(repo);
    commitFile(repo, 'a.ts', 'export {};\n');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }),
    );

    const { lines, messages, exited } = await converse(configPath);
    for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
    expect(exited, 'the server exits once its input closes').toBe(true);
    expect(messages.every((m) => m.jsonrpc === '2.0')).toBe(true);
    expect(messages.find((m) => m.id === 1)?.result?.serverInfo?.name).toBe('repos-expert');
    expect(messages.find((m) => m.id === 2)?.result?.tools).toHaveLength(7);
  });

  it('still answers in protocol when its config is missing, and explains on stderr', async () => {
    const missing = path.join(makeTempDir('expert-stdio-missing-'), 'nope', 'expert.config.json');
    const { lines, messages, stderr, exited } = await converse(missing);
    for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
    expect(exited, 'the server exits once its input closes').toBe(true);
    expect(messages.find((m) => m.id === 2)?.result?.tools).toHaveLength(7);
    expect(stderr).toMatch(/setup mode/);
  });
});
