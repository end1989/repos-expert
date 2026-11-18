import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import { getRepoStatus, readMeta, writeMeta } from '../src/registry.js';
import { curateRepo, curatePortfolio, DOC_VERSION } from '../src/curator/curator.js';
import type { AgentRun, RunStats } from '../src/curator/agent.js';
import { CuratorError } from '../src/curator/errors.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

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
    curateMaxBudgetUsd: null,
    curatorEnv: {},
    refreshIgnore: [],
  };
}

const allDocs = [
  '===FILE: card.md===\n# card body',
  '===FILE: architecture.md===\n# arch body',
  '===FILE: map.md===\n# map body',
  '===FILE: activity.md===\n# activity body',
  '===FILE: interfaces.md===\n# interfaces body',
].join('\n');

const done = (output: string, stats?: RunStats): AgentRun =>
  stats === undefined ? { output } : { output, stats };

const RUN: RunStats = {
  costUsd: 0.84,
  turns: 41,
  durationMs: 174_000,
  inputTokens: 512_000,
  outputTokens: 9_800,
  sessionId: 'session-xyz',
  deniedToolCalls: 0,
};

/** A link to a file needs a privilege on Windows that a link to a folder (junction) does not. */
const fileLinksWork = ((): boolean => {
  const dir = makeTempDir('expert-cur-link-');
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  }
})();

function repoWithOneCommit(cfg: ExpertConfig, name = 'alpha'): string {
  const repo = path.join(cfg.reposDir, name);
  initGitRepo(repo);
  return commitFile(repo, 'a.ts', 'x', 'init');
}

describe('curateRepo', () => {
  it('writes all five docs and stamps meta with HEAD sha', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    const sha = repoWithOneCommit(cfg);
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return done(allDocs);
    });
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    expect(fs.readFileSync(path.join(dir, 'card.md'), 'utf8')).toContain('card body');
    expect(fs.readFileSync(path.join(dir, 'interfaces.md'), 'utf8')).toContain('interfaces body');
    const meta = readMeta(cfg.knowledgeDir, 'alpha');
    expect(meta?.sha).toBe(sha);
    expect(meta?.docVersion).toBe(DOC_VERSION);
    expect(prompts[0]).toContain('"alpha"');
    expect(prompts[0]).not.toContain('Previous docs');
  });

  it('gives the runner the timeout from config, not a fixed constant', async () => {
    const cfg = { ...makeCfg(makeTempDir('expert-cur-')), curateTimeoutMinutes: 25 };
    repoWithOneCommit(cfg);
    let seen = 0;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (_p, opts) => {
      seen = opts.timeoutMs;
      return done(allDocs);
    });
    expect(seen).toBe(25 * 60_000);
  });

  it('passes the spending cap from config to the runner, and none when unset', async () => {
    const seen: (number | undefined)[] = [];
    for (const cap of [3.5, null]) {
      const cfg = { ...makeCfg(makeTempDir('expert-cur-')), curateMaxBudgetUsd: cap };
      repoWithOneCommit(cfg);
      await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (_p, opts) => {
        seen.push(opts.maxBudgetUsd);
        return done(allDocs);
      });
    }
    expect(seen).toEqual([3.5, undefined]);
  });

  it('passes previous docs and change log in incremental mode', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    const firstSha = repoWithOneCommit(cfg);
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'OLD CARD CONTENT');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha: firstSha,
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    commitFile(path.join(cfg.reposDir, 'alpha'), 'b.ts', 'y', 'second commit');
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return done(allDocs);
    });
    expect(prompts[0]).toContain('OLD CARD CONTENT');
    expect(prompts[0]).toContain('second commit');
  });

  it('still studies a repo whose recorded commit was rewritten out of history, and says so', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'OLD CARD CONTENT');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha: 'deadbeef'.repeat(5), // well-formed, but not a commit in this repository
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return done(allDocs);
    });
    expect(prompts[0]).toContain('no longer in this repository');
    expect(prompts[0]).toContain('OLD CARD CONTENT');
    expect(readMeta(cfg.knowledgeDir, 'alpha')?.sha).not.toBe('deadbeef'.repeat(5));
  });

  it('retries once, then leaves the repo uncurated on repeated failure', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
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
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    let attempts = 0;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return done(allDocs);
    });
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).not.toBeNull();
  });

  it('retries once when the agent finishes without producing the documents', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    let attempts = 0;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
      attempts += 1;
      return done(attempts === 1 ? 'I ran out of room before writing the documents.' : allDocs);
    });
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).not.toBeNull();
  });

  it.each([
    ['timeout', 'Timed out after 25 min'],
    ['budget', 'Stopped at the spending cap'],
    ['auth', 'The API key it tried to use was rejected'],
  ] as const)('does not pay for a second run after a %s failure', async (kind, message) => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    let attempts = 0;
    await expect(
      curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
        attempts += 1;
        throw new CuratorError(kind, message);
      }),
    ).rejects.toMatchObject({ kind });
    expect(attempts).toBe(1);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).toBeNull();
  });

  it('records what the run cost beside the commit it describes, and returns it', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    const stats: RunStats = {
      costUsd: 0.84,
      turns: 41,
      durationMs: 174_000,
      inputTokens: 512_000,
      outputTokens: 9_800,
      sessionId: 'session-xyz',
      deniedToolCalls: 1,
    };
    const returned = await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () =>
      done(allDocs, stats),
    );
    expect(returned.stats).toEqual(stats);
    expect(readMeta(cfg.knowledgeDir, 'alpha')?.run).toEqual(stats);
  });

  it.each([
    [
      'answered with something other than the documents',
      () => done('I ran out of room.', { ...RUN, costUsd: 0.5, turns: 30, sessionId: 'first' }),
    ],
    [
      'failed after spending',
      () => {
        throw new CuratorError('agent', 'Curator agent failed (error_during_execution)', {
          stats: { ...RUN, costUsd: 0.5, turns: 30, sessionId: 'first' },
        });
      },
    ],
  ] as const)(
    'counts what the first attempt cost when it %s and the retry succeeded',
    async (_, firstAttempt) => {
      const cfg = makeCfg(makeTempDir('expert-cur-'));
      repoWithOneCommit(cfg);
      let attempts = 0;
      const returned = await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
        attempts += 1;
        return attempts === 1
          ? firstAttempt()
          : done(allDocs, { ...RUN, costUsd: 0.25, turns: 11, sessionId: 'second' });
      });
      expect(returned.stats).toMatchObject({ costUsd: 0.75, turns: 41, sessionId: 'second' });
      expect(readMeta(cfg.knowledgeDir, 'alpha')?.run).toMatchObject({ costUsd: 0.75 });
    },
  );

  it('says what a failure cost, counting both attempts', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    await expect(
      curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
        throw new CuratorError('agent', 'Curator agent failed (error_during_execution)', {
          stats: { ...RUN, costUsd: 0.5 },
        });
      }),
    ).rejects.toMatchObject({ kind: 'agent', stats: { costUsd: 1 } });
  });

  it('checks every file:line the docs cite against the repo, and records what did not resolve', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg); // a.ts, one line
    const cited = allDocs.replace(
      '# interfaces body',
      ['# interfaces body', '- main export: a.ts:1', '- router: src/routes.ts:12'].join('\n'),
    );
    const returned = await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () =>
      done(cited),
    );
    const expected = {
      checked: 2,
      broken: [{ doc: 'interfaces.md', citation: 'src/routes.ts:12', reason: 'no such file' }],
    };
    expect(returned.citations).toEqual(expected);
    expect(readMeta(cfg.knowledgeDir, 'alpha')?.citations).toEqual(expected);
  });

  it('ignores unexpected marker names from model output and writes only the allowlisted docs', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    repoWithOneCommit(cfg);
    const maliciousOutput = `${allDocs}\n===FILE: ../evil.md===\npwned`;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => done(maliciousOutput));
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    expect(fs.readFileSync(path.join(dir, 'card.md'), 'utf8')).toContain('card body');
    expect(fs.readFileSync(path.join(dir, 'architecture.md'), 'utf8')).toContain('arch body');
    expect(fs.readFileSync(path.join(dir, 'map.md'), 'utf8')).toContain('map body');
    expect(fs.readFileSync(path.join(dir, 'activity.md'), 'utf8')).toContain('activity body');
    expect(fs.existsSync(path.join(cfg.knowledgeDir, 'repos', 'evil.md'))).toBe(false);
    expect(fs.existsSync(path.join(cfg.knowledgeDir, 'evil.md'))).toBe(false);
  });
});

describe('curatePortfolio', () => {
  function curatedAlpha(cfg: ExpertConfig): string {
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
    return sha;
  }

  it('runs the portfolio agent over the repos folder with the excluded repos fenced off', async () => {
    const cfg = { ...makeCfg(makeTempDir('expert-cur-')), excludeRepos: ['private-client'] };
    curatedAlpha(cfg);
    const seen: { cwd: string; excludeRepos: readonly string[] | undefined }[] = [];
    await curatePortfolio(cfg, async (_prompt, opts) => {
      seen.push({ cwd: opts.cwd, excludeRepos: opts.excludeRepos });
      return done('===FILE: portfolio.md===\np\n===FILE: cross-repo-map.md===\nm');
    });
    expect(seen).toEqual([{ cwd: cfg.reposDir, excludeRepos: ['private-client'] }]);
  });

  it('writes portfolio docs from cards and manifests and stamps portfolio-meta', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    const sha = curatedAlpha(cfg);
    const prompts: string[] = [];
    await curatePortfolio(cfg, async (prompt) => {
      prompts.push(prompt);
      return done(
        '===FILE: portfolio.md===\nthe portfolio\n===FILE: cross-repo-map.md===\nthe map',
      );
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

  it.skipIf(!fileLinksWork)(
    'leaves unread a manifest that is a link out of the repository',
    async () => {
      const cfg = makeCfg(makeTempDir('expert-cur-'));
      curatedAlpha(cfg);
      // beta's package.json is a link to a file elsewhere on the machine, which the host
      // process would otherwise read and hand to the model.
      const outside = path.join(makeTempDir('expert-cur-outside-'), 'credentials.json');
      fs.writeFileSync(outside, '{"token":"OUTSIDE-SECRET"}');
      const beta = path.join(cfg.reposDir, 'beta');
      initGitRepo(beta);
      const sha = commitFile(beta, 'a.ts', 'x');
      fs.symlinkSync(outside, path.join(beta, 'package.json'), 'file');
      const dir = path.join(cfg.knowledgeDir, 'repos', 'beta');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'card.md'), 'beta keeps the books');
      writeMeta(cfg.knowledgeDir, 'beta', {
        sha,
        curatedAt: '2026-08-10T00:00:00Z',
        model: 'claude-sonnet-5',
        docVersion: DOC_VERSION,
      });
      const prompts: string[] = [];
      await curatePortfolio(cfg, async (prompt) => {
        prompts.push(prompt);
        return done('===FILE: portfolio.md===\np\n===FILE: cross-repo-map.md===\nm');
      });
      expect(prompts[0]).toContain('beta keeps the books');
      expect(prompts[0]).toContain('alpha-pkg'); // a manifest inside its repo still goes in
      expect(prompts[0]).not.toContain('OUTSIDE-SECRET');
    },
  );

  it('does not pay for a second portfolio run after a final failure', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    curatedAlpha(cfg);
    let attempts = 0;
    await expect(
      curatePortfolio(cfg, async () => {
        attempts += 1;
        throw new CuratorError('timeout', 'Timed out');
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(attempts).toBe(1);
  });

  it('throws when no repos are curated yet', async () => {
    const cfg = makeCfg(makeTempDir('expert-cur-'));
    fs.mkdirSync(cfg.reposDir, { recursive: true });
    await expect(curatePortfolio(cfg, async () => done(''))).rejects.toThrow(/curate --all/);
  });
});
