import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RepoStatus } from '../src/registry.js';
import { curateMany } from '../src/cli/curate-many.js';
import { makeTempDir } from './helpers.js';

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

const status = (name: string): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: null,
  curatedAt: null,
  state: 'uncurated',
});

describe('curateMany', () => {
  it('curates each status, collects failures, and continues', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const seen: string[] = [];
    const failures = await curateMany(cfg, [status('a'), status('bad'), status('c')], async (_cfg, s) => {
      seen.push(s.name);
      if (s.name === 'bad') throw new Error('boom');
    });
    expect(seen).toEqual(['a', 'bad', 'c']);
    expect(failures).toEqual([{ name: 'bad', error: 'boom' }]);
  });
});
