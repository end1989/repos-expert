import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { revParseHead } from '../src/git.js';
import { findOnPath } from '../src/which.js';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

const win = process.platform === 'win32';
const exe = (name: string): string => (win ? `${name}.exe` : name);

/** A file a search would take for an executable program. */
function plantProgram(dir: string, name: string, script = '#!/bin/sh\necho planted\n'): string {
  const file = path.join(dir, exe(name));
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('findOnPath', () => {
  it('finds a program in an absolute folder on PATH', () => {
    const bin = makeTempDir('which-bin-');
    const program = plantProgram(bin, 'tool');
    expect(findOnPath('tool', { PATH: bin })).toBe(program);
  });

  it('never looks in the working folder, nor in a relative PATH entry', () => {
    // On Windows a bare program name is looked for in the working folder before PATH, and
    // a relative PATH entry is read against it: either way, a file in the repository the
    // tool is working in would run.
    const here = makeTempDir('which-cwd-');
    plantProgram(here, 'tool');
    fs.mkdirSync(path.join(here, 'bin'));
    plantProgram(path.join(here, 'bin'), 'tool');
    const previous = process.cwd();
    process.chdir(here);
    try {
      const sep = path.delimiter;
      expect(findOnPath('tool', { PATH: `.${sep}bin${sep}${sep}"bin"` })).toBeNull();
    } finally {
      process.chdir(previous);
    }
  });

  it('reads a quoted PATH entry, as Windows writes one with spaces', () => {
    const bin = makeTempDir('which spaced-');
    const program = plantProgram(bin, 'tool');
    expect(findOnPath('tool', { PATH: `"${bin}"` })).toBe(program);
  });

  it('refuses a name that is not a bare program name', () => {
    for (const name of ['../tool', 'bin/tool', 'C:tool', '']) {
      expect(findOnPath(name, { PATH: makeTempDir('which-x-') }), name).toBeNull();
    }
  });
});

describe('git is run by its full path, never from the repository it works in', () => {
  const removed = process.env.NoDefaultCurrentDirectoryInExePath;
  afterEach(() => {
    if (removed === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
    else process.env.NoDefaultCurrentDirectoryInExePath = removed;
  });

  it.runIf(win)('ignores a git.exe committed at the root of a studied repository', async () => {
    const repo = makeTempDir('which-repo-');
    initGitRepo(repo);
    const sha = commitFile(repo, 'README.md', 'hello\n', 'first');
    // Any program will do: whoami prints no commit id.
    fs.copyFileSync(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
      path.join(repo, 'git.exe'),
    );
    // Without this, Windows looks in the working folder first (Claude Code sets it for the
    // commands it runs; a terminal, Task Scheduler or an MCP client may not).
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    expect(await revParseHead(repo)).toBe(sha);
  });

  it.runIf(!win)('ignores a git a relative PATH entry would find in the repository', async () => {
    const repo = makeTempDir('which-repo-');
    initGitRepo(repo);
    const sha = commitFile(repo, 'README.md', 'hello\n', 'first');
    plantProgram(repo, 'git', '#!/bin/sh\necho planted\n');
    const pathBefore = process.env.PATH;
    process.env.PATH = `.${path.delimiter}${pathBefore ?? ''}`;
    try {
      expect(await revParseHead(repo)).toBe(sha);
    } finally {
      process.env.PATH = pathBefore;
    }
  });
});
