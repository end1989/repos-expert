import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloneRepo, pullFastForward, revParseHead, updateMirror } from '../src/git.js';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

/**
 * The git operations behind `sync`, run for real against a local origin — the sync tests
 * use fakes, so this is where "never discards your work" and "a mirror tracks the remote"
 * are actually checked.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function origin(): { url: string; work: string } {
  const root = makeTempDir('expert-origin-');
  const work = path.join(root, 'work');
  initGitRepo(work);
  commitFile(work, 'README.md', 'v1\n', 'first');
  const bare = path.join(root, 'origin.git');
  git(root, 'clone', '--bare', work, bare);
  git(work, 'remote', 'add', 'origin', bare);
  return { url: pathToFileURL(bare).href, work };
}

function cloneInto(): string {
  return path.join(makeTempDir('expert-clone-'), 'repo');
}

describe('git sync operations, for real', () => {
  it('clones a repository from a URL', async () => {
    const { url } = origin();
    const dest = cloneInto();
    await cloneRepo(url, dest);
    expect(fs.readFileSync(path.join(dest, 'README.md'), 'utf8')).toBe('v1\n');
  });

  it('clones into the empty folder sync creates first to claim the name', async () => {
    const { url } = origin();
    const dest = cloneInto();
    fs.mkdirSync(dest);
    await cloneRepo(url, dest);
    expect(fs.readFileSync(path.join(dest, 'README.md'), 'utf8')).toBe('v1\n');
  });

  it('refuses a URL that starts with a dash before git ever sees it', async () => {
    const dest = cloneInto();
    await expect(cloneRepo('--upload-pack=touch pwned', dest)).rejects.toThrow(
      /cannot start with "-"/,
    );
  });

  it('fast-forwards a working copy to new upstream commits', async () => {
    const { url, work } = origin();
    const dest = cloneInto();
    await cloneRepo(url, dest);
    initLocalIdentity(dest);
    const upstream = commitFile(work, 'README.md', 'v2\n', 'second');
    git(work, 'push', 'origin', 'HEAD:main');
    await pullFastForward(dest);
    expect(await revParseHead(dest)).toBe(upstream);
  });

  it('refuses to pull over local commits that have diverged, keeping them', async () => {
    const { url, work } = origin();
    const dest = cloneInto();
    await cloneRepo(url, dest);
    initLocalIdentity(dest);
    const mine = commitFile(dest, 'mine.txt', 'local work\n', 'my local commit');
    commitFile(work, 'theirs.txt', 'upstream\n', 'their commit');
    git(work, 'push', 'origin', 'HEAD:main');
    await expect(pullFastForward(dest)).rejects.toThrow();
    expect(await revParseHead(dest)).toBe(mine);
  });

  it('makes a mirror match the remote exactly, discarding local changes', async () => {
    const { url, work } = origin();
    const dest = cloneInto();
    await cloneRepo(url, dest);
    initLocalIdentity(dest);
    commitFile(dest, 'stray.txt', 'local only\n', 'stray');
    const upstream = commitFile(work, 'README.md', 'v3\n', 'third');
    git(work, 'push', 'origin', 'HEAD:main');
    await updateMirror(dest, 'main');
    expect(await revParseHead(dest)).toBe(upstream);
    expect(fs.existsSync(path.join(dest, 'stray.txt'))).toBe(false);
  });
});

function initLocalIdentity(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}
