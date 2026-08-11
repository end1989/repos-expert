import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseRepoList, revParseHead, gitLogOneline, listBranches, listGithubRepos, gitLogRangeStat, updateMirror } from '../src/git.js';
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

describe('input validation', () => {
  it('listGithubRepos rejects invalid username', async () => {
    await expect(listGithubRepos('invalid@user')).rejects.toThrow('Invalid GitHub username');
  });

  it('gitLogRangeStat rejects invalid SHA', async () => {
    const dir = path.join(makeTempDir('expert-git-'), 'repo');
    initGitRepo(dir);
    commitFile(dir, 'a.txt', 'hello');
    await expect(gitLogRangeStat(dir, 'invalid_sha')).rejects.toThrow('Invalid git SHA');
  });

  it('updateMirror rejects branch starting with dash', async () => {
    const dir = path.join(makeTempDir('expert-git-'), 'repo');
    initGitRepo(dir);
    await expect(updateMirror(dir, '-main')).rejects.toThrow('Invalid branch name');
  });

  it('gitLogOneline rejects non-positive limit', async () => {
    const dir = path.join(makeTempDir('expert-git-'), 'repo');
    initGitRepo(dir);
    commitFile(dir, 'a.txt', 'hello');
    await expect(gitLogOneline(dir, 0)).rejects.toThrow('Limit must be a positive integer');
    await expect(gitLogOneline(dir, -5)).rejects.toThrow('Limit must be a positive integer');
  });
});
