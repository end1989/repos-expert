import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import { DEFAULT_REFRESH_IGNORE } from '../src/config.js';
import { readMeta, writeMeta, type RepoStatus } from '../src/registry.js';
import { partitionStale, isTrivialChange } from '../src/cli/reverify.js';
import { makeTempDir } from './helpers.js';

/**
 * The trivial-change fast path: a stale repo whose changes since curation touch only
 * ignorable paths (docs, CI, lockfiles) is re-verified — its meta records that the code
 * is unchanged through HEAD — instead of costing a model run.
 */

function makeCfg(root: string, refreshIgnore?: string[]): ExpertConfig {
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
    curatorEnv: {},
    refreshIgnore: refreshIgnore ?? DEFAULT_REFRESH_IGNORE,
  };
}

const stale = (name: string): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: 'b'.repeat(40),
  curatedAt: '2026-08-10T00:00:00Z',
  verifiedThrough: null,
  state: 'stale',
});

describe('isTrivialChange', () => {
  it('is true when every changed path is ignorable, and for no changes at all', () => {
    expect(isTrivialChange(['README.md', 'docs/x.md', '.github/workflows/ci.yml'], DEFAULT_REFRESH_IGNORE)).toBe(true);
    expect(isTrivialChange([], DEFAULT_REFRESH_IGNORE)).toBe(true);
  });

  it('is false as soon as one code path is in the diff', () => {
    expect(isTrivialChange(['README.md', 'src/index.ts'], DEFAULT_REFRESH_IGNORE)).toBe(false);
  });

  it('respects a custom list — an empty list disables the fast path', () => {
    expect(isTrivialChange(['README.md'], [])).toBe(false);
    expect(isTrivialChange(['config/settings.yaml'], ['config/**'])).toBe(true);
  });
});

describe('partitionStale', () => {
  it('re-verifies docs-only repos (meta gains verifiedSha) and hands the rest to the curator', async () => {
    const root = makeTempDir('expert-reverify-');
    const cfg = makeCfg(root);
    for (const n of ['docsonly', 'codechange', 'unknownhistory', 'nochange']) {
      writeMeta(cfg.knowledgeDir, n, { sha: 'b'.repeat(40), curatedAt: '2026-08-10T00:00:00Z', model: 'm', docVersion: 1 });
    }
    const changed: Record<string, string[] | null> = {
      docsonly: ['README.md', 'CHANGELOG.md'],
      codechange: ['README.md', 'src/main.py'],
      unknownhistory: null,
      nochange: [],
    };
    const res = await partitionStale(cfg, ['docsonly', 'codechange', 'unknownhistory', 'nochange'].map(stale), {
      changedFiles: async (s) => changed[s.name] ?? null,
    });
    expect(res.reverified).toEqual(['docsonly', 'nochange']);
    expect(res.curate.map((s) => s.name)).toEqual(['codechange', 'unknownhistory']);
    expect(readMeta(cfg.knowledgeDir, 'docsonly')?.verifiedSha).toBe('a'.repeat(40));
    expect(readMeta(cfg.knowledgeDir, 'docsonly')?.sha).toBe('b'.repeat(40)); // the docs are still from b
    expect(readMeta(cfg.knowledgeDir, 'codechange')?.verifiedSha).toBeUndefined();
  });

  it('never re-verifies uncurated repos and leaves fresh ones alone', async () => {
    const root = makeTempDir('expert-reverify-');
    const cfg = makeCfg(root);
    const uncurated: RepoStatus = { ...stale('newone'), curatedSha: null, curatedAt: null, state: 'uncurated' };
    const fresh: RepoStatus = { ...stale('ok'), curatedSha: 'a'.repeat(40), state: 'fresh' };
    const res = await partitionStale(cfg, [uncurated, fresh], { changedFiles: async () => [] });
    expect(res.reverified).toEqual([]);
    expect(res.curate.map((s) => s.name)).toEqual(['newone', 'ok']);
  });
});
