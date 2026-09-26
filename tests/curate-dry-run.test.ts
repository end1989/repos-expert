import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

/**
 * `--dry-run` promises "without doing it" — no model call, nothing spent. That has to hold
 * for every form of `expert curate`, not just `--all`/`--stale`. This runs the *built* CLI
 * with the import-tracing hook and the Claude Agent SDK blocked outright: if a dry run
 * ever reaches for the curator, the import throws instead of calling a model, and the
 * trace shows it. Needs `npm run build` first, like the footprint and tarball tests.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'trace-imports.mjs')).href;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  loaded: string;
  knowledgeDir: string;
}

function runCurate(args: string[]): Run {
  const tmp = makeTempDir('expert-dryrun-');
  const trace = path.join(tmp, 'trace.txt');
  fs.writeFileSync(trace, '');
  const alpha = path.join(tmp, 'repos', 'alpha');
  initGitRepo(alpha);
  commitFile(alpha, 'index.js', 'module.exports = 1;\n');
  const configPath = path.join(tmp, 'expert.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }));

  const res = spawnSync(process.execPath, ['--import', PRELOAD, CLI, 'curate', ...args], {
    cwd: tmp,
    env: {
      ...process.env,
      EXPERT_TRACE_OUT: trace,
      EXPERT_TRACE_BLOCK: 'claude-agent-sdk',
      EXPERT_CONFIG: configPath,
    },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    loaded: fs.readFileSync(trace, 'utf8'),
    knowledgeDir: path.join(tmp, 'knowledge'),
  };
}

function curatorLoads(loaded: string): string[] {
  return loaded
    .split('\n')
    .filter((l) => l.includes('claude-agent-sdk') || l.includes('/dist/curator/') || l.includes('/dist/cli/curate-many.js'));
}

describe('expert curate --dry-run', () => {
  it('for a single repo: says what it would study, spends nothing, never loads the curator', () => {
    const run = runCurate(['alpha', '--dry-run']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('alpha');
    expect(run.stdout).toMatch(/nothing (was )?(spent|studied)/i);
    expect(curatorLoads(run.loaded)).toEqual([]);
    expect(fs.existsSync(path.join(run.knowledgeDir, 'repos', 'alpha'))).toBe(false);
  });

  it('for the portfolio pass: says so, spends nothing, never loads the curator', () => {
    const run = runCurate(['--portfolio', '--dry-run']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/portfolio/i);
    expect(run.stdout).toMatch(/nothing (was )?(spent|studied)/i);
    expect(curatorLoads(run.loaded)).toEqual([]);
    expect(fs.existsSync(path.join(run.knowledgeDir, 'portfolio.md'))).toBe(false);
  });

  it('for a named repo alongside --all or --stale: still a dry run, and names the portfolio pass that would follow', () => {
    // Commander accepts `curate alpha --all`; a real run curates alpha, then the portfolio.
    for (const batchFlag of ['--all', '--stale']) {
      const run = runCurate(['alpha', batchFlag, '--dry-run']);
      expect(run.status, `${batchFlag}: ${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('alpha');
      expect(run.stdout).toMatch(/portfolio/i);
      expect(run.stdout).toMatch(/nothing (was )?(spent|studied)/i);
      expect(curatorLoads(run.loaded), batchFlag).toEqual([]);
      expect(fs.existsSync(path.join(run.knowledgeDir, 'repos', 'alpha')), batchFlag).toBe(false);
    }
  });

  it('for a repo that does not exist: fails, without loading the curator', () => {
    const run = runCurate(['no-such-repo', '--dry-run']);
    expect(run.status).not.toBe(0);
    expect(curatorLoads(run.loaded)).toEqual([]);
  });
});
