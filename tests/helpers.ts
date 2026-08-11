import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
}

export function commitFile(
  dir: string,
  rel: string,
  content: string,
  message = 'commit',
): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('add', '.');
  git('commit', '-m', message);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}
