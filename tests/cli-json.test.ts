import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

/**
 * `--json` is for scripts and agents: one JSON document on stdout, nothing else, and the
 * same exit code as the human-readable form. Runs the built CLI.
 */
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'cli',
  'index.js',
);

function setup(): string {
  const root = makeTempDir('expert-json-');
  const alpha = path.join(root, 'repos', 'alpha');
  initGitRepo(alpha);
  commitFile(alpha, 'index.js', 'module.exports = 1;\n');
  initGitRepo(path.join(root, 'repos', 'scratch')); // nothing committed
  const configPath = path.join(root, 'expert.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }),
  );
  return configPath;
}

function run(
  configPath: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, EXPERT_CONFIG: configPath },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('--json output', () => {
  it('status: every repo with its state and commits, and every skipped folder with its reason', () => {
    const out = run(setup(), ['status', '--json']);
    expect(out.status, out.stderr).toBe(0);
    const doc = JSON.parse(out.stdout) as {
      repos: { name: string; state: string; currentSha: string }[];
      skipped: { name: string; reason: string }[];
    };
    expect(doc.repos.map((r) => [r.name, r.state])).toEqual([['alpha', 'uncurated']]);
    expect(doc.repos[0]?.currentSha).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.skipped).toEqual([{ name: 'scratch', reason: 'no commits yet' }]);
  });

  it('doctor: the checks as data, with the same exit code as the readable report', () => {
    const configPath = setup();
    const readable = run(configPath, ['doctor']);
    const out = run(configPath, ['doctor', '--json']);
    expect(out.status).toBe(readable.status);
    const doc = JSON.parse(out.stdout) as { checks: { name: string; status: string }[] };
    expect(doc.checks.map((c) => c.name)).toContain('config');
    expect(doc.checks.find((c) => c.name === 'config')?.status).toBe('ok');
  });
});
