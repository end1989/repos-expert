import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RemoteRepo } from '../src/git.js';
import { syncRepos, type SyncDeps } from '../src/cli/sync.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

function makeCfg(root: string, extra: Partial<ExpertConfig> = {}): ExpertConfig {
  return {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
    curateConcurrency: 4,
    ...extra,
  };
}

const remote = (name: string, isArchived = false): RemoteRepo => ({
  name,
  url: `https://github.com/u/${name}`,
  defaultBranch: 'main',
  isArchived,
});

describe('syncRepos', () => {
  it('clones missing repos, updates existing ones, skips excluded and archived', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root, { excludeRepos: ['skip-me'] });
    const existing = path.join(cfg.reposDir, 'have-it');
    initGitRepo(existing);
    commitFile(existing, 'a.txt', 'a');

    const calls: string[] = [];
    const deps: SyncDeps = {
      listRemote: async () => [remote('new-one'), remote('have-it'), remote('skip-me'), remote('old', true)],
      clone: async (_url, dest) => {
        calls.push(`clone:${path.basename(dest)}`);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async (dir) => {
        calls.push(`update:${path.basename(dir)}`);
      },
    };

    const res = await syncRepos(cfg, deps);
    expect(calls.sort()).toEqual(['clone:new-one', 'update:have-it']);
    expect(res.synced.sort()).toEqual(['have-it', 'new-one']);
    expect(res.skipped.sort()).toEqual(['old', 'skip-me']);
    expect(res.failed).toEqual([]);
  });

  it('collects per-repo failures and continues the batch', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    const deps: SyncDeps = {
      listRemote: async () => [remote('bad'), remote('good')],
      clone: async (_url, dest) => {
        if (dest.endsWith('bad')) throw new Error('network down');
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async () => {},
    };
    const res = await syncRepos(cfg, deps);
    expect(res.synced).toEqual(['good']);
    expect(res.failed).toEqual([{ name: 'bad', error: 'network down' }]);
  });

  it('with only, syncs just the named repos and fails unknown names', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    const calls: string[] = [];
    const deps: SyncDeps = {
      listRemote: async () => [remote('alpha'), remote('beta')],
      clone: async (_url, dest) => {
        calls.push(`clone:${path.basename(dest)}`);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async () => {},
    };
    const res = await syncRepos(cfg, deps, ['alpha', 'ghost']);
    expect(calls).toEqual(['clone:alpha']);
    expect(res.synced).toEqual(['alpha']);
    expect(res.failed).toEqual([{ name: 'ghost', error: 'not found on GitHub account' }]);
  });
});
