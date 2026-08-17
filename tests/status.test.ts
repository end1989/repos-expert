import { describe, it, expect } from 'vitest';
import { formatStatus } from '../src/cli/status.js';
import type { RepoStatus } from '../src/registry.js';

const status = (name: string, state: RepoStatus['state']): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'abcdef1234567890',
  curatedSha: state === 'uncurated' ? null : 'fedcba0987654321',
  curatedAt: state === 'uncurated' ? null : '2026-08-10T00:00:00Z',
  state,
});

describe('formatStatus', () => {
  it('renders one line per repo with state, head, and curated sha', () => {
    const out = formatStatus([status('alpha', 'fresh'), status('beta', 'uncurated')]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('fresh');
    expect(lines[0]).toContain('alpha');
    expect(lines[0]).toContain('abcdef1');
    expect(lines[1]).toContain('uncurated');
    expect(lines[1]).toContain('-');
  });

  it('tells the user to sync when there are no repos', () => {
    expect(formatStatus([])).toContain('expert sync');
  });

  it('names an uncurated repo to study, since a list of "uncurated" is not a next step', () => {
    const out = formatStatus([status('alpha', 'uncurated'), status('beta', 'uncurated')]);
    expect(out).toContain('expert refresh alpha');
  });

  it('says nothing extra once everything is studied', () => {
    const out = formatStatus([status('alpha', 'fresh')]);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('points at refresh when docs have fallen behind the code', () => {
    const out = formatStatus([status('alpha', 'fresh'), status('beta', 'stale')]);
    expect(out).toMatch(/expert refresh\b/);
  });
});

describe('formatStatus — verified freshness', () => {
  it('shows through which commit a re-verified repo was confirmed', () => {
    const out = formatStatus([
      {
        name: 'r',
        path: '/repos/r',
        currentSha: 'b'.repeat(40),
        curatedSha: 'a'.repeat(40),
        curatedAt: 'x',
        verifiedThrough: 'b'.repeat(40),
        state: 'fresh',
      },
    ]);
    expect(out).toMatch(/fresh\s+r\s+head bbbbbbb\s+curated aaaaaaa\s+\(code unchanged through bbbbbbb\)/);
  });
});
