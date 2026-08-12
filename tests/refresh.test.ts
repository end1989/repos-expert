import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RepoStatus } from '../src/registry.js';
import { runRefresh, refreshLockPath, type RefreshDeps } from '../src/cli/refresh.js';
import { makeTempDir } from './helpers.js';

function makeCfg(root: string): ExpertConfig {
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
  };
}

const status = (name: string, state: RepoStatus['state']): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: state === 'uncurated' ? null : 'b'.repeat(40),
  curatedAt: state === 'uncurated' ? null : '2026-08-10T00:00:00Z',
  state,
});

function makeDeps(overrides: Partial<RefreshDeps> = {}): { deps: RefreshDeps; calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = { sync: [], curate: [], portfolio: [], getStatus: [] };
  const deps: RefreshDeps = {
    sync: async (_cfg, only) => {
      calls.sync.push(only === undefined ? '(all)' : only.join(','));
      return { synced: ['x'], skipped: [], failed: [] };
    },
    curateOne: async (_cfg, s) => {
      calls.curate.push(s.name);
    },
    portfolio: async () => {
      calls.portfolio.push('yes');
    },
    listStatuses: async () => [status('fresh1', 'fresh'), status('stale1', 'stale'), status('new1', 'uncurated')],
    getStatus: async (_cfg, name) => {
      calls.getStatus.push(name);
      if (name === 'ghost') throw new Error('Invalid repo name: ghost');
      return status(name, 'fresh');
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('runRefresh', () => {
  it('still curates the local repos when GitHub sync fails entirely', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({
      sync: async () => {
        throw new Error('GitHub sync is not configured — everything else still works');
      },
    });
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.curate).toEqual(['stale1']);
    expect(calls.portfolio).toEqual(['yes']);
    expect(res.synced).toBe(0);
    expect(res.syncFailed[0]?.name).toBe('github');
    expect(res.portfolioOk).toBe(true);
  });

  it('no-args: curates stale only, reports uncurated, runs portfolio', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.sync).toEqual(['(all)']);
    expect(calls.curate).toEqual(['stale1']);
    expect(res.uncurated).toEqual(['new1']);
    expect(calls.portfolio).toEqual(['yes']);
    expect(res.curated).toBe(1);
    expect(res.curateFailed).toEqual([]);
    expect(res.portfolioOk).toBe(true);
  });

  it('named mode: passes only to sync and curates named repos even when fresh', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, ['alpha', 'beta'], deps);
    expect(calls.sync).toEqual(['alpha,beta']);
    expect(calls.curate).toEqual(['alpha', 'beta']);
    expect(res.uncurated).toEqual([]);
    expect(res.curated).toBe(2);
  });

  it('named mode: unknown name fails but the rest continue and portfolio runs', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, ['ghost', 'alpha'], deps);
    expect(calls.curate).toEqual(['alpha']);
    expect(res.curateFailed).toEqual([{ name: 'ghost', error: 'Invalid repo name: ghost' }]);
    expect(calls.portfolio).toEqual(['yes']);
  });

  it('curate failure is collected, portfolio failure is reported', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps } = makeDeps({
      curateOne: async () => {
        throw new Error('agent exploded');
      },
      portfolio: async () => {
        throw new Error('portfolio exploded');
      },
    });
    const res = await runRefresh(cfg, undefined, deps);
    expect(res.curateFailed).toEqual([{ name: 'stale1', error: 'agent exploded' }]);
    expect(res.portfolioOk).toBe(false);
    expect(res.portfolioError).toBe('portfolio exploded');
  });

  it('refuses to run when the lockfile exists, and names the path', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: '2026-08-11T00:00:00Z' }));
    const { deps, calls } = makeDeps();
    await expect(runRefresh(cfg, undefined, deps)).rejects.toThrow(/Another refresh appears to be running \(started 2026-08-11T00:00:00Z\)\. If that is stale, delete .+\.refresh\.lock and retry\./);
    expect(calls.sync).toEqual([]);
    fs.rmSync(lock);
  });

  it('removes the lock after success and after a thrown stage', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    const { deps } = makeDeps();
    await runRefresh(cfg, undefined, deps);
    expect(fs.existsSync(lock)).toBe(false);
    // Sync failure is deliberately survivable, so use a stage that is not:
    // the lock must still be released when an unexpected error escapes.
    const { deps: badDeps } = makeDeps({
      listStatuses: async () => {
        throw new Error('registry gone');
      },
    });
    await expect(runRefresh(cfg, undefined, badDeps)).rejects.toThrow('registry gone');
    expect(fs.existsSync(lock)).toBe(false);
  });
});
