import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './helpers.js';

/**
 * `expert mcp` is a long-lived process an MCP client starts on every launch. It has no
 * business loading the curator or the Claude Agent SDK — those are for `curate` and
 * `refresh` — so the CLI must import them lazily. This runs the *built* CLI with a
 * module-resolution hook and reads back exactly what got loaded. Needs `npm run build`
 * first, like the tarball test.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'trace-imports.mjs')).href;

function traceMcpStartup(): string {
  const tmp = makeTempDir('expert-footprint-');
  const trace = path.join(tmp, 'trace.txt');
  fs.writeFileSync(trace, '');
  const configPath = path.join(tmp, 'expert.config.json');
  fs.mkdirSync(path.join(tmp, 'repos'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }));

  const res = spawnSync(process.execPath, ['--import', PRELOAD, CLI, 'mcp'], {
    cwd: tmp,
    env: { ...process.env, EXPERT_TRACE_OUT: trace, EXPERT_CONFIG: configPath },
    input: '', // stdin closes immediately, so the stdio server exits on EOF
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return fs.readFileSync(trace, 'utf8');
}

describe('what `expert mcp` loads', () => {
  const loaded = traceMcpStartup();

  it('does load the MCP server and its SDK (sanity check that the trace works)', () => {
    expect(loaded).toContain('/dist/mcp/server.js');
    expect(loaded).toContain('@modelcontextprotocol/sdk');
  });

  it('does not load the curator or the Claude Agent SDK', () => {
    const offenders = loaded
      .split('\n')
      .filter((l) => l.includes('claude-agent-sdk') || l.includes('/dist/curator/') || l.includes('/dist/cli/curate-many.js') || l.includes('/dist/cli/refresh.js'));
    expect(offenders, `expert mcp loaded:\n${offenders.join('\n')}`).toEqual([]);
  });
});
