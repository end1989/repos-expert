import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import {
  getRepoStatus,
  listRepoStatuses,
  readMeta,
  writeMeta,
  stalenessBanner,
} from '../src/registry.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

function makeCfg(root: string): ExpertConfig {
  return {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
  };
}

describe('registry', () => {
  let cfg: ExpertConfig;
  let freshSha: string;

  beforeAll(() => {
    const root = makeTempDir('expert-reg-');
    cfg = makeCfg(root);
    // fresh: meta.sha === HEAD
    const fresh = path.join(cfg.reposDir, 'fresh-repo');
    initGitRepo(fresh);
    freshSha = commitFile(fresh, 'a.txt', 'a');
    writeMeta(cfg.knowledgeDir, 'fresh-repo', {
      sha: freshSha,
      curatedAt: '2026-08-10T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: 1,
    });
    // stale: meta.sha differs from HEAD
    const stale = path.join(cfg.reposDir, 'stale-repo');
    initGitRepo(stale);
    commitFile(stale, 'a.txt', 'a');
    writeMeta(cfg.knowledgeDir, 'stale-repo', {
      sha: '0000000000000000000000000000000000000000',
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: 1,
    });
    // uncurated: no meta.json
    const bare = path.join(cfg.reposDir, 'bare-repo');
    initGitRepo(bare);
    commitFile(bare, 'a.txt', 'a');
  });

  it('round-trips meta', () => {
    expect(readMeta(cfg.knowledgeDir, 'fresh-repo')?.sha).toBe(freshSha);
    expect(readMeta(cfg.knowledgeDir, 'nope')).toBeNull();
  });

  it('computes fresh, stale, and uncurated states', async () => {
    expect((await getRepoStatus(cfg, 'fresh-repo')).state).toBe('fresh');
    expect((await getRepoStatus(cfg, 'stale-repo')).state).toBe('stale');
    expect((await getRepoStatus(cfg, 'bare-repo')).state).toBe('uncurated');
  });

  it('rejects path-traversal repo names', async () => {
    await expect(getRepoStatus(cfg, '../escape')).rejects.toThrow(/Invalid repo name/);
  });

  it('lists all mirrored repos sorted by name', async () => {
    const names = (await listRepoStatuses(cfg)).map((s) => s.name);
    expect(names).toEqual(['bare-repo', 'fresh-repo', 'stale-repo']);
  });

  it('builds staleness banners', async () => {
    expect(stalenessBanner(await getRepoStatus(cfg, 'fresh-repo'))).toBe('');
    expect(stalenessBanner(await getRepoStatus(cfg, 'stale-repo'))).toContain(
      'trust live search over summaries',
    );
    expect(stalenessBanner(await getRepoStatus(cfg, 'bare-repo'))).toContain(
      'no curated docs yet',
    );
  });
});
