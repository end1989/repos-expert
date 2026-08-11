import { describe, it, expect } from 'vitest';
import {
  DOC_FILES,
  buildRepoPrompt,
  buildPortfolioPrompt,
  parseCuratedDocs,
} from '../src/curator/prompts.js';

describe('parseCuratedDocs', () => {
  it('extracts docs delimited by FILE markers', () => {
    const output = [
      'Some preamble the model wrote.',
      '===FILE: card.md===',
      '# card',
      'body',
      '===FILE: architecture.md===',
      '# arch',
    ].join('\n');
    const docs = parseCuratedDocs(output, ['card.md', 'architecture.md']);
    expect(docs['card.md']).toBe('# card\nbody');
    expect(docs['architecture.md']).toBe('# arch');
  });

  it('throws listing every missing or empty doc', () => {
    const output = '===FILE: card.md===\n# card\n===FILE: map.md===\n\n';
    expect(() => parseCuratedDocs(output, DOC_FILES)).toThrow(
      /architecture\.md.*map\.md.*activity\.md|missing docs/,
    );
  });
});

describe('buildRepoPrompt', () => {
  it('includes name, git context, templates, and marker instructions', () => {
    const p = buildRepoPrompt({ name: 'alpha', gitLog: 'abc first', branches: '* main' });
    expect(p).toContain('"alpha"');
    expect(p).toContain('abc first');
    expect(p).toContain('===FILE: card.md===');
    expect(p).toContain('architecture.md');
    expect(p).not.toContain('Previous docs');
  });

  it('switches to update mode when previous docs exist', () => {
    const p = buildRepoPrompt({
      name: 'alpha',
      gitLog: 'abc first',
      branches: '* main',
      previousDocs: { 'card.md': 'old card body' },
      changesSincePrevious: 'abc..def 3 files changed',
    });
    expect(p).toContain('Previous docs');
    expect(p).toContain('old card body');
    expect(p).toContain('3 files changed');
  });
});

describe('buildPortfolioPrompt', () => {
  it('includes every card and manifest and asks for the two portfolio docs', () => {
    const p = buildPortfolioPrompt({
      cards: { alpha: 'alpha card' },
      manifests: { 'alpha/package.json': '{"name":"alpha"}' },
    });
    expect(p).toContain('alpha card');
    expect(p).toContain('"name":"alpha"');
    expect(p).toContain('===FILE: portfolio.md===');
    expect(p).toContain('cross-repo-map.md');
  });
});
