import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import { getRepoStatus, readMeta, writeMeta } from '../src/registry.js';
import { curateRepo, curatePortfolio, DOC_VERSION } from '../src/curator/curator.js';
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

const fourDocs = [
  '===FILE: card.md===\n# card body',
  '===FILE: architecture.md===\n# arch body',
  '===FILE: map.md===\n# map body',
  '===FILE: activity.md===\n# activity body',
].join('\n');

describe('curateRepo', () => {
  it('writes all four docs and stamps meta with HEAD sha', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const sha = commitFile(repo, 'a.ts', 'x', 'init');
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return fourDocs;
    });
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    expect(fs.readFileSync(path.join(dir, 'card.md'), 'utf8')).toContain('card body');
    expect(fs.readFileSync(path.join(dir, 'activity.md'), 'utf8')).toContain('activity body');
    const meta = readMeta(cfg.knowledgeDir, 'alpha');
    expect(meta?.sha).toBe(sha);
    expect(meta?.docVersion).toBe(DOC_VERSION);
    expect(prompts[0]).toContain('"alpha"');
    expect(prompts[0]).not.toContain('Previous docs');
  });

  it('passes previous docs and change log in incremental mode', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const firstSha = commitFile(repo, 'a.ts', 'x', 'init');
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'OLD CARD CONTENT');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha: firstSha,
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    commitFile(repo, 'b.ts', 'y', 'second commit');
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return fourDocs;
    });
    expect(prompts[0]).toContain('OLD CARD CONTENT');
    expect(prompts[0]).toContain('second commit');
  });

  it('retries once, then leaves the repo uncurated on repeated failure', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    commitFile(repo, 'a.ts', 'x');
    let attempts = 0;
    await expect(
      curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
        attempts += 1;
        throw new Error('agent exploded');
      }),
    ).rejects.toThrow('agent exploded');
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).toBeNull();
  });

  it('succeeds when the retry succeeds', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    commitFile(repo, 'a.ts', 'x');
    let attempts = 0;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return fourDocs;
    });
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).not.toBeNull();
  });
});

describe('curatePortfolio', () => {
  it('writes portfolio docs from cards and manifests and stamps portfolio-meta', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const sha = commitFile(repo, 'package.json', '{"name":"alpha-pkg"}');
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'alpha does things');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha,
      curatedAt: '2026-08-10T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    const prompts: string[] = [];
    await curatePortfolio(cfg, async (prompt) => {
      prompts.push(prompt);
      return '===FILE: portfolio.md===\nthe portfolio\n===FILE: cross-repo-map.md===\nthe map';
    });
    expect(prompts[0]).toContain('alpha does things');
    expect(prompts[0]).toContain('alpha-pkg');
    expect(fs.readFileSync(path.join(cfg.knowledgeDir, 'portfolio.md'), 'utf8')).toContain(
      'the portfolio',
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(cfg.knowledgeDir, 'portfolio-meta.json'), 'utf8'),
    );
    expect(meta.repos.alpha).toBe(sha);
  });

  it('throws when no repos are curated yet', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    fs.mkdirSync(cfg.reposDir, { recursive: true });
    await expect(curatePortfolio(cfg, async () => '')).rejects.toThrow(/curate --all/);
  });
});
