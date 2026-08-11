import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseRepoList, revParseHead, gitLogOneline, listBranches } from '../src/git.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

describe('parseRepoList', () => {
  it('maps gh JSON to RemoteRepo, defaulting branch to main when null', () => {
    const json = JSON.stringify([
      {
        name: 'alpha',
        url: 'https://github.com/u/alpha',
        defaultBranchRef: { name: 'master' },
        isArchived: false,
      },
      { name: 'empty', url: 'https://github.com/u/empty', defaultBranchRef: null, isArchived: true },
    ]);
    const repos = parseRepoList(json);
    expect(repos).toEqual([
      { name: 'alpha', url: 'https://github.com/u/alpha', defaultBranch: 'master', isArchived: false },
      { name: 'empty', url: 'https://github.com/u/empty', defaultBranch: 'main', isArchived: true },
    ]);
  });
});

describe('git inspection helpers', () => {
  it('reads HEAD, log, and branches from a real repo', async () => {
    const dir = path.join(makeTempDir('expert-git-'), 'repo');
    initGitRepo(dir);
    const sha = commitFile(dir, 'a.txt', 'hello', 'first commit');
    expect(await revParseHead(dir)).toBe(sha);
    expect(await gitLogOneline(dir)).toContain('first commit');
    expect(await listBranches(dir)).toContain('main');
  });
});
