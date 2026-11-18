import { describe, it, expect, vi } from 'vitest';
import type { ExpertConfig } from '../src/config.js';
import type { RepoStatus, RunStats } from '../src/registry.js';
import { curateMany, describeRun, parseConcurrency } from '../src/cli/curate-many.js';
import { makeTempDir, testConfig } from './helpers.js';

function makeCfg(root: string, curateConcurrency = 4): ExpertConfig {
  return testConfig(root, { curateConcurrency });
}

const status = (name: string): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: null,
  curatedAt: null,
  verifiedThrough: null,
  state: 'uncurated',
});

/** Lets every already-scheduled microtask and timer callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('curateMany', () => {
  it('curates each status, collects failures, and continues', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const seen: string[] = [];
    const failures = await curateMany(
      cfg,
      [status('a'), status('bad'), status('c')],
      async (_cfg, s) => {
        seen.push(s.name);
        if (s.name === 'bad') throw new Error('boom');
      },
      1,
    );
    expect(seen).toEqual(['a', 'bad', 'c']);
    expect(failures).toEqual([{ name: 'bad', error: 'boom' }]);
  });

  it('runs at most `concurrency` repos at a time and refills freed slots', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const names = ['a', 'b', 'c', 'd', 'e'];
    const gates = new Map(names.map((n) => [n, deferred()]));
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;

    const done = curateMany(
      cfg,
      names.map(status),
      async (_cfg, s) => {
        started.push(s.name);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gates.get(s.name)!.promise;
        inFlight -= 1;
      },
      2,
    );

    await flush();
    expect(started).toEqual(['a', 'b']);

    gates.get('a')!.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    for (const g of gates.values()) g.resolve();
    expect(await done).toEqual([]);
    expect(started).toEqual(names);
    expect(peak).toBe(2);
  });

  it('defaults the concurrency to cfg.curateConcurrency', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'), 1);
    const gates = new Map([
      ['a', deferred()],
      ['b', deferred()],
    ]);
    const started: string[] = [];

    const done = curateMany(cfg, [status('a'), status('b')], async (_cfg, s) => {
      started.push(s.name);
      await gates.get(s.name)!.promise;
    });

    await flush();
    expect(started).toEqual(['a']);
    for (const g of gates.values()) g.resolve();
    await done;
    expect(started).toEqual(['a', 'b']);
  });

  it('reports failures in input order even when they finish out of order', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const failures = await curateMany(
      cfg,
      [status('a'), status('b'), status('c')],
      async (_cfg, s) => {
        if (s.name === 'c') throw new Error('c-failed');
        if (s.name === 'b') {
          await flush();
          throw new Error('b-failed');
        }
      },
      3,
    );
    expect(failures).toEqual([
      { name: 'b', error: 'b-failed' },
      { name: 'c', error: 'c-failed' },
    ]);
  });

  it('handles an empty target list', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    expect(await curateMany(cfg, [], async () => {})).toEqual([]);
  });

  it('says what each measured run cost, and what the batch cost in total', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      await curateMany(
        cfg,
        [status('a'), status('b')],
        async (_cfg, s) => ({
          stats: { ...STATS, costUsd: s.name === 'a' ? 0.5 : 0.25 },
          citations: { checked: 4, broken: [] },
        }),
        1,
      );
    } finally {
      spy.mockRestore();
    }
    expect(lines).toContain('curated a (1/2) — $0.50, 2.9 min, 41 turns');
    expect(lines).toContain('curated b (2/2) — $0.25, 2.9 min, 41 turns');
    expect(lines.at(-1)).toBe(
      'Spent about $0.75 on 2 runs (the agent runtime’s estimate, not a bill).',
    );
  });

  it('flags a repo whose docs cite lines that do not exist', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      await curateMany(
        cfg,
        [status('a')],
        async () => ({
          stats: STATS,
          citations: {
            checked: 3,
            broken: [{ doc: 'map.md', citation: 'x/y.ts:9', reason: 'no such file' }],
          },
        }),
        1,
      );
    } finally {
      spy.mockRestore();
    }
    expect(lines[0]).toBe(
      'curated a (1/1) — $0.84, 2.9 min, 41 turns; 1 of 3 citations do not resolve (see meta.json)',
    );
  });

  it('prints no cost line when nothing was measured', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      await curateMany(cfg, [status('a')], async () => undefined, 1);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(['curated a (1/1)']);
  });
});

const STATS: RunStats = {
  costUsd: 0.8412,
  turns: 41,
  durationMs: 174_000,
  inputTokens: 500_000,
  outputTokens: 9000,
  sessionId: 's',
  deniedToolCalls: 0,
};

describe('describeRun', () => {
  it('gives cost, time and turns in a form that reads at a glance', () => {
    expect(describeRun(STATS)).toBe('$0.84, 2.9 min, 41 turns');
    expect(describeRun({ ...STATS, durationMs: 45_400, turns: 1 })).toBe('$0.84, 45 s, 1 turn');
  });

  it('calls out reads the agent was refused, which may mean the repo tried to steer it', () => {
    expect(describeRun({ ...STATS, deniedToolCalls: 2 })).toBe(
      '$0.84, 2.9 min, 41 turns, 2 reads outside the repo refused',
    );
  });
});

describe('parseConcurrency', () => {
  it('accepts integers within range', () => {
    expect(parseConcurrency('1')).toBe(1);
    expect(parseConcurrency('16')).toBe(16);
  });

  it.each(['0', '-1', '17', '2.5', 'four', '', ' '])('rejects %o', (value) => {
    expect(() => parseConcurrency(value)).toThrow(/integer between 1 and 16/);
  });
});
