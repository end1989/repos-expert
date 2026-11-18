import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import { writeMeta, type RepoStatus } from '../src/registry.js';
import { runRefresh, refreshLockPath, type RefreshDeps } from '../src/cli/refresh.js';
import { makeTempDir, testConfig } from './helpers.js';

function makeCfg(root: string): ExpertConfig {
  return testConfig(root, { githubUser: 'u', curateConcurrency: 4 });
}

const status = (name: string, state: RepoStatus['state']): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: state === 'uncurated' ? null : 'b'.repeat(40),
  curatedAt: state === 'uncurated' ? null : '2026-08-10T00:00:00Z',
  verifiedThrough: null,
  state,
});

function makeDeps(overrides: Partial<RefreshDeps> = {}): {
  deps: RefreshDeps;
  calls: Record<'sync' | 'curate' | 'portfolio' | 'getStatus', string[]>;
} {
  const calls = {
    sync: [] as string[],
    curate: [] as string[],
    portfolio: [] as string[],
    getStatus: [] as string[],
  };
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
    listStatuses: async () => [
      status('fresh1', 'fresh'),
      status('stale1', 'stale'),
      status('new1', 'uncurated'),
    ],
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

  it('named mode: a repo named twice is studied once', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, ['fresh1', 'fresh1'], deps);
    expect(calls.curate).toEqual(['fresh1']);
    expect(res.curated).toBe(1);
  });

  it('named mode: a repo sync deliberately skipped is not curated from its stale mirror', async () => {
    // excludeRepos / archived-without-includeArchived means sync left the folder
    // untouched. Curating it anyway would spend money describing a stale copy and
    // report it as freshly studied.
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({
      sync: async () => ({ synced: [], skipped: ['Archived-One'], failed: [] }),
    });
    const res = await runRefresh(cfg, ['archived-one', 'alpha'], deps);
    expect(calls.curate).toEqual(['alpha']);
    expect(res.skipped).toEqual(['archived-one']);
    expect(res.curated).toBe(1);
    expect(res.curateFailed).toEqual([]);
    expect(calls.portfolio).toEqual(['yes']);
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

  it('refuses to run while another live process holds the lock, and names the path', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: '2026-08-11T00:00:00Z' }));
    const { deps, calls } = makeDeps();
    await expect(runRefresh(cfg, undefined, deps)).rejects.toThrow(
      /Another refresh appears to be running \(started 2026-08-11T00:00:00Z\)\. If that is stale, delete .+\.refresh\.lock and retry\./,
    );
    expect(calls.sync).toEqual([]);
    fs.rmSync(lock);
  });

  it('takes over a lock left behind by a process that no longer exists', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '']).pid; // ran and exited
    fs.writeFileSync(lock, JSON.stringify({ pid: gone, startedAt: '2026-08-11T00:00:00Z' }));
    const { deps, calls } = makeDeps();
    await runRefresh(cfg, undefined, deps);
    expect(calls.sync).toEqual(['(all)']);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('treats a folder with nothing to sync as normal, not as a failed sync', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps } = makeDeps({
      sync: async () => ({
        synced: [],
        skipped: [],
        failed: [],
        nothingToSync: 'Nothing to sync yet.',
      }),
    });
    const res = await runRefresh(cfg, undefined, deps);
    expect(res.syncFailed).toEqual([]);
  });

  it('does not pay for a portfolio pass when the portfolio already reflects every studied repo', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    for (const name of ['fresh1', 'stale1']) {
      writeMeta(cfg.knowledgeDir, name, {
        sha: 'b'.repeat(40),
        curatedAt: 'x',
        model: 'm',
        docVersion: 1,
      });
    }
    fs.writeFileSync(
      path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
      JSON.stringify({ curatedAt: 'x', repos: { fresh1: 'b'.repeat(40), stale1: 'b'.repeat(40) } }),
    );
    // stale1 changed only in its README, so it is re-verified, not studied: nothing new to see.
    const { deps, calls } = makeDeps({ changedFiles: async () => ['README.md'] });
    const res = await runRefresh(cfg, undefined, deps);
    expect(res.curated).toBe(0);
    expect(calls.portfolio).toEqual([]);
    expect(res.portfolioOk).toBe(true);
    expect(res.portfolioSkipped).toMatch(/up to date/);
  });

  it('pays for the portfolio on a later run when docs were rewritten after it was written', async () => {
    // `refresh fresh1` re-studied fresh1 at the same commit, then its portfolio pass failed:
    // portfolio-meta still names fresh1 at that commit, but has never seen these docs.
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const sha = 'b'.repeat(40);
    writeMeta(cfg.knowledgeDir, 'fresh1', {
      sha,
      curatedAt: '2026-08-02T00:00:00.000Z',
      model: 'm',
      docVersion: 1,
    });
    fs.writeFileSync(
      path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
      JSON.stringify({ curatedAt: '2026-08-01T00:00:00.000Z', repos: { fresh1: sha } }),
    );
    const { deps, calls } = makeDeps({ listStatuses: async () => [status('fresh1', 'fresh')] });
    const res = await runRefresh(cfg, undefined, deps);
    expect(res.curated).toBe(0);
    expect(calls.portfolio).toEqual(['yes']);
  });

  it('pays for a portfolio pass whenever this run rewrote some docs, even at the same commit', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    writeMeta(cfg.knowledgeDir, 'fresh1', {
      sha: 'b'.repeat(40),
      curatedAt: 'x',
      model: 'm',
      docVersion: 1,
    });
    fs.writeFileSync(
      path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
      JSON.stringify({ curatedAt: 'x', repos: { fresh1: 'b'.repeat(40) } }),
    );
    const { deps, calls } = makeDeps({
      listStatuses: async () => [status('fresh1', 'fresh')],
    });
    const res = await runRefresh(cfg, ['fresh1'], deps);
    expect(calls.curate).toEqual(['fresh1']);
    expect(res.curated).toBe(1);
    expect(calls.portfolio).toEqual(['yes']);
  });

  it('takes over an empty lock left by a run killed before it wrote one, once it is old', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    fs.writeFileSync(lock, '');
    // Just written, it may be a run between creating the file and writing to it.
    await expect(runRefresh(cfg, undefined, makeDeps().deps)).rejects.toThrow(
      /appears to be running/,
    );
    const aMinuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, aMinuteAgo, aMinuteAgo);
    const { deps, calls } = makeDeps();
    await runRefresh(cfg, undefined, deps);
    expect(calls.sync).toEqual(['(all)']);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not clear a dead lock that another run is already taking over', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const dead = JSON.stringify({ pid: gone, startedAt: '2026-08-11T00:00:00Z' });
    fs.writeFileSync(lock, dead);
    const takingOver = JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() });
    fs.writeFileSync(`${lock}.takeover`, takingOver);
    const { deps, calls } = makeDeps();
    await expect(runRefresh(cfg, undefined, deps)).rejects.toThrow(/appears to be running/);
    expect(calls.sync).toEqual([]);
    expect(fs.readFileSync(lock, 'utf8')).toBe(dead); // left for the run that is taking it over
  });

  it('names the leftover marker when a takeover itself was interrupted', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lock, JSON.stringify({ pid: gone, startedAt: '2026-08-11T00:00:00Z' }));
    fs.writeFileSync(`${lock}.takeover`, JSON.stringify({ pid: gone, startedAt: 'x' }));
    await expect(runRefresh(cfg, undefined, makeDeps().deps)).rejects.toThrow(
      /refresh\.lock\.takeover/,
    );
  });

  it('leaves the lock in place when another run has taken it over in the meantime', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    const other = JSON.stringify({ pid: process.ppid, startedAt: '2026-08-11T00:00:00Z' });
    const { deps } = makeDeps({
      curateOne: async () => {
        fs.writeFileSync(lock, other); // as if a second run had judged ours dead and taken over
      },
    });
    await runRefresh(cfg, undefined, deps);
    expect(fs.readFileSync(lock, 'utf8')).toBe(other);
    fs.rmSync(lock);
  });

  it('skips the portfolio pass, as a note and not a failure, when nothing has been studied yet', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({ listStatuses: async () => [status('new1', 'uncurated')] });
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.portfolio).toEqual([]);
    expect(res.portfolioOk).toBe(true);
    expect(res.portfolioSkipped).toMatch(/nothing has been studied/);
  });

  it('plans without syncing, studying or spending on a dry run', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({ changedFiles: async () => ['src/main.py'] });
    const res = await runRefresh(cfg, undefined, deps, { dryRun: true });
    expect(calls.sync).toEqual([]);
    expect(calls.curate).toEqual([]);
    expect(calls.portfolio).toEqual([]);
    expect(res.planned).toEqual(['stale1']);
    expect(res.portfolioSkipped).toMatch(/dry run/);
  });

  it('asks before spending, and stops cleanly when the answer is no', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({ changedFiles: async () => ['src/main.py'] });
    const asked: string[][] = [];
    const res = await runRefresh(cfg, undefined, deps, {
      confirm: async (targets) => {
        asked.push(targets.map((t) => t.name));
        return false;
      },
    });
    expect(asked).toEqual([['stale1']]);
    expect(calls.curate).toEqual([]);
    expect(calls.portfolio).toEqual([]);
    expect(res.cancelled).toBe(true);
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

describe('runRefresh — trivial-change fast path', () => {
  it('re-verifies a stale repo whose only changes are docs, without calling the curator', async () => {
    const root = makeTempDir('expert-rf-');
    const cfg = makeCfg(root);
    fs.mkdirSync(path.join(cfg.knowledgeDir, 'repos', 'stale1'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg.knowledgeDir, 'repos', 'stale1', 'meta.json'),
      JSON.stringify({ sha: 'b'.repeat(40), curatedAt: 'x', model: 'm', docVersion: 1 }),
    );
    const { deps, calls } = makeDeps({ changedFiles: async () => ['README.md', 'docs/guide.md'] });
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.curate).toEqual([]);
    expect(res.reverified).toEqual(['stale1']);
    expect(res.curated).toBe(0);
    const meta = JSON.parse(
      fs.readFileSync(path.join(cfg.knowledgeDir, 'repos', 'stale1', 'meta.json'), 'utf8'),
    );
    expect(meta.verifiedSha).toBe('a'.repeat(40));
    expect(calls.portfolio).toEqual(['yes']);
  });

  it('still curates when code changed, and when the history cannot be read', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({ changedFiles: async () => ['src/main.py'] });
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.curate).toEqual(['stale1']);
    expect(res.reverified).toEqual([]);

    const cfg2 = makeCfg(makeTempDir('expert-rf-'));
    const second = makeDeps({ changedFiles: async () => null });
    await runRefresh(cfg2, undefined, second.deps);
    expect(second.calls.curate).toEqual(['stale1']);
  });

  it('named repos are always curated — the fast path is for the automatic sweep only', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps({
      changedFiles: async () => ['README.md'],
      getStatus: async (_cfg, name) => status(name, 'stale'),
    });
    const res = await runRefresh(cfg, ['stale1'], deps);
    expect(calls.curate).toEqual(['stale1']);
    expect(res.reverified).toEqual([]);
  });
});
