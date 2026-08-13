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
    reposListFile: path.join(root, 'repos', 'repos.txt'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
    curateConcurrency: 4,
    curateTimeoutMinutes: 25,
    ...extra,
  };
}

function writeList(cfg: ExpertConfig, body: string): void {
  fs.mkdirSync(path.dirname(cfg.reposListFile), { recursive: true });
  fs.writeFileSync(cfg.reposListFile, body);
}

const remote = (name: string, isArchived = false): RemoteRepo => ({
  name,
  url: `https://github.com/u/${name}`,
  defaultBranch: 'main',
  isArchived,
});

const noDeps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
  listRemote: async () => {
    throw new Error('should not be called');
  },
  clone: async () => {},
  update: async () => {},
  pull: async () => {},
  ...over,
});

describe('syncRepos with nothing configured', () => {
  it('names the list file to add URLs to, and says the folder still works', async () => {
    const cfg = { ...makeCfg(makeTempDir('expert-sync-')), githubUser: null };
    await expect(syncRepos(cfg, noDeps())).rejects.toThrow(
      new RegExp(`${path.basename(cfg.reposListFile)}[\\s\\S]*still works`),
    );
  });
});

describe('syncRepos from the repos list', () => {
  it('clones listed projects with no GitHub account involved', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = { ...makeCfg(root), githubUser: null };
    writeList(cfg, ['# mine', 'https://github.com/acme/one.git', 'two = git@github.com:acme/other.git'].join('\n'));

    const cloned: string[] = [];
    const res = await syncRepos(
      cfg,
      noDeps({
        clone: async (url, dest) => {
          cloned.push(`${path.basename(dest)}<-${url}`);
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        },
      }),
    );
    expect(cloned).toEqual([
      'one<-https://github.com/acme/one.git',
      'two<-git@github.com:acme/other.git',
    ]);
    expect(res.synced).toEqual(['one', 'two']);
  });

  it('fast-forwards a listed project already on disk, never discarding local work', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = { ...makeCfg(root), githubUser: null };
    const existing = path.join(cfg.reposDir, 'have-it');
    initGitRepo(existing);
    commitFile(existing, 'a.txt', 'a');
    writeList(cfg, 'https://github.com/acme/have-it.git');

    const calls: string[] = [];
    const res = await syncRepos(
      cfg,
      noDeps({
        update: async () => {
          calls.push('HARD RESET');
        },
        pull: async (dir) => {
          calls.push(`pull:${path.basename(dir)}`);
        },
      }),
    );
    expect(calls).toEqual(['pull:have-it']);
    expect(res.synced).toEqual(['have-it']);
  });

  it('reports unusable lines as failures and clones the rest', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = { ...makeCfg(root), githubUser: null };
    writeList(cfg, ['ext::sh -c evil', 'https://github.com/acme/fine.git'].join('\n'));
    const res = await syncRepos(
      cfg,
      noDeps({
        clone: async (_url, dest) => {
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        },
      }),
    );
    expect(res.synced).toEqual(['fine']);
    expect(res.failed).toEqual([{ name: cfg.reposListFile, error: expect.stringMatching(/line 1/) }]);
  });

  it('lets the list win over a GitHub repo of the same name', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    writeList(cfg, 'https://gitlab.com/acme/shared.git');
    const cloned: string[] = [];
    const res = await syncRepos(
      cfg,
      noDeps({
        listRemote: async () => [remote('shared'), remote('gh-only')],
        clone: async (url, dest) => {
          cloned.push(`${path.basename(dest)}<-${url}`);
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        },
      }),
    );
    expect(cloned).toEqual([
      'shared<-https://gitlab.com/acme/shared.git',
      'gh-only<-https://github.com/u/gh-only',
    ]);
    expect(res.synced).toEqual(['shared', 'gh-only']);
  });

  it('still honors excludeRepos for listed projects', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = { ...makeCfg(root), githubUser: null, excludeRepos: ['nope'] };
    writeList(cfg, ['https://github.com/acme/nope.git', 'https://github.com/acme/yes.git'].join('\n'));
    const res = await syncRepos(
      cfg,
      noDeps({
        clone: async (_url, dest) => {
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        },
      }),
    );
    expect(res.synced).toEqual(['yes']);
    expect(res.skipped).toEqual(['nope']);
  });
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
      pull: async () => {},
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
      pull: async () => {},
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
      pull: async () => {},
    };
    const res = await syncRepos(cfg, deps, ['alpha', 'ghost']);
    expect(calls).toEqual(['clone:alpha']);
    expect(res.synced).toEqual(['alpha']);
    expect(res.failed).toEqual([
      { name: 'ghost', error: expect.stringMatching(/not found in the repos list[\s\S]*GitHub account/) },
    ]);
  });

  it('matches only-names case-insensitively, keeping the canonical name for paths', async () => {
    // GitHub treats repo names case-insensitively, so `--only alpha-repo` must find
    // `Alpha-Repo`. The folder is still created under the canonical name.
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    const calls: string[] = [];
    const deps: SyncDeps = {
      listRemote: async () => [remote('Alpha-Repo'), remote('beta')],
      clone: async (_url, dest) => {
        calls.push(`clone:${path.basename(dest)}`);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async () => {},
      pull: async () => {},
    };
    const res = await syncRepos(cfg, deps, ['alpha-repo']);
    expect(calls).toEqual(['clone:Alpha-Repo']);
    expect(res.synced).toEqual(['Alpha-Repo']);
    expect(res.failed).toEqual([]);
  });
});
