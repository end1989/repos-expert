import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REFRESH_IGNORE, type ExpertConfig } from '../src/config.js';

const created: string[] = [];

/** A fresh temporary folder, removed after the test file finishes (see tests/setup.ts). */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A process that has not let go yet (Windows); the OS cleans its temp folder.
    }
  }
}

/**
 * A complete config rooted in `root`, with the same defaults loadConfig applies. One
 * definition, so a new required config field is added here once instead of being missed
 * in a fixture that then fails only at runtime.
 */
export function testConfig(root: string, overrides: Partial<ExpertConfig> = {}): ExpertConfig {
  return {
    githubUser: null,
    reposDir: path.join(root, 'repos'),
    reposListFile: path.join(root, 'repos', 'repos.txt'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
    curateConcurrency: 2,
    curateTimeoutMinutes: 25,
    curateMaxBudgetUsd: null,
    curatorEnv: {},
    refreshIgnore: [...DEFAULT_REFRESH_IGNORE],
    ...overrides,
  };
}

export function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // Independent of the machine's global git config: no CRLF rewriting (and its warning
  // on every commit), and no signing prompt on a machine that signs by default.
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
}

export function commitFile(dir: string, rel: string, content: string, message = 'commit'): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('add', '.');
  git('commit', '-m', message);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}
