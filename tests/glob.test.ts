import { describe, it, expect } from 'vitest';
import { matchesGlob, matchesAnyGlob, pathFilter } from '../src/glob.js';

/**
 * The refresh fast path decides "only docs changed" with these patterns, against
 * repo-relative, forward-slash paths as `git diff --name-only` prints them. gitignore
 * semantics where they matter: a pattern without a slash matches at any depth.
 */
describe('matchesGlob', () => {
  it.each([
    ['**/*.md', 'README.md', true],
    ['**/*.md', 'docs/guide/intro.md', true],
    ['**/*.md', 'src/notes.mdx', false],
    ['docs/**', 'docs/a/b/c.txt', true],
    ['docs/**', 'docs', false],
    ['docs/**', 'src/docs/x.ts', false],
    ['.github/**', '.github/workflows/ci.yml', true],
    ['LICENSE*', 'LICENSE', true],
    ['LICENSE*', 'LICENSE.md', true],
    ['LICENSE*', 'sub/LICENSE', true],
    ['*.lock', 'yarn.lock', true],
    ['*.lock', 'pkg/Cargo.lock', true],
    ['*.lock', 'lockfile.js', false],
    ['package-lock.json', 'package-lock.json', true],
    ['package-lock.json', 'web/package-lock.json', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['file.(1)', 'file.(1)', true],
  ])('%s vs %s → %s', (pattern, file, expected) => {
    expect(matchesGlob(pattern, file)).toBe(expected);
  });
});

describe('matchesGlob — the forms an MCP client sends', () => {
  it.each([
    ['*.{ts,tsx}', 'src/a.tsx', true],
    ['*.{ts,tsx}', 'src/a.ts', true],
    ['*.{ts,tsx}', 'src/a.js', false],
    ['src/**/*.{ts,js}', 'src/x/y.js', true],
    ['src/**/*.{ts,js}', 'lib/y.js', false],
    ['[ab].txt', 'b.txt', true],
    ['[ab].txt', 'c.txt', false],
    ['[!a].txt', 'c.txt', true],
    ['[!a].txt', 'a.txt', false],
    ['[a-c].txt', 'b.txt', true],
    ['[a-c].txt', 'd.txt', false],
    ['**/Dockerfile', 'deploy/Dockerfile', true],
    ['./src/*.ts', 'src/a.ts', true],
    ['/src/*.ts', 'src/a.ts', true],
    ['src/', 'src/deep/a.ts', true],
  ])('%s vs %s → %s', (pattern, file, expected) => {
    expect(matchesGlob(pattern, file)).toBe(expected);
  });

  it('treats a malformed character class as no match, never an exception', () => {
    expect(() => matchesGlob('[z-a].txt', 'b.txt')).not.toThrow();
    expect(matchesGlob('[z-a].txt', 'b.txt')).toBe(false);
  });

  it('stays fast on patterns built to make a backtracking matcher explode', () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/');
    const longName = 'a'.repeat(60);
    const start = performance.now();
    expect(matchesGlob(`${'**/'.repeat(30)}zzz`, deep)).toBe(false);
    expect(matchesGlob(`${'*a'.repeat(12)}*b`, longName)).toBe(false);
    expect(pathFilter(`${'**/'.repeat(30)}zzz`)(deep)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('refuses, at once, a glob whose {…} groups multiply past 64 alternatives', () => {
    const glob = '{a,b,c,d,e,f,g,h,i,j}'.repeat(12); // 10^12 alternatives in 252 characters
    const start = performance.now();
    expect(() => pathFilter(glob)).toThrow(/more than 64 alternatives/);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('keeps every alternative of a glob that stays within the limit', () => {
    const glob = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}'; // exactly 64
    for (const name of ['acegik', 'bdfhjl', 'adehil', 'bcfgjk']) {
      expect(matchesGlob(glob, name), name).toBe(true);
    }
  });

  it('anchors as gitignore does: a leading slash ties a pattern to the root, a trailing one does not', () => {
    expect(matchesGlob('/x', 'x')).toBe(true);
    expect(matchesGlob('/x', 'a/x')).toBe(false);
    expect(matchesGlob('./x', 'a/x')).toBe(false);
    expect(matchesGlob('x/', 'x/y.ts')).toBe(true);
    expect(matchesGlob('x/', 'a/x/y.ts')).toBe(true);
    expect(matchesGlob('a/x/', 'b/a/x/y.ts')).toBe(false); // a slash in the middle anchors
  });

  it('refuses nested {…} groups rather than misreading them', () => {
    expect(() => matchesGlob('{a,{b,c}}', 'b')).toThrow(/[Nn]ested/);
  });
});

describe('pathFilter', () => {
  it('keeps everything when there is no glob', () => {
    expect(pathFilter(undefined)('any/thing.md')).toBe(true);
    expect(pathFilter('')('any/thing.md')).toBe(true);
  });

  it('keeps only the paths a glob matches', () => {
    const keep = pathFilter('*.ts');
    expect(keep('src/a.ts')).toBe(true);
    expect(keep('README.md')).toBe(false);
  });

  it('reads a leading ! as "everything except"', () => {
    const keep = pathFilter('!*.md');
    expect(keep('README.md')).toBe(false);
    expect(keep('src/a.ts')).toBe(true);
  });

  it('keeps everything under a folder the glob names', () => {
    const keep = pathFilter('docs');
    expect(keep('docs/a/b.md')).toBe(true);
    expect(keep('src/docs.ts')).toBe(false);
  });

  it('across a collection, matches each repo-relative path as well as the full one', () => {
    const keep = pathFilter('src/**/*.py', { belowTopLevel: true });
    expect(keep('alpha/src/x/y.py')).toBe(true);
    expect(keep('alpha/tests/y.py')).toBe(false);
    expect(pathFilter('alpha/**', { belowTopLevel: true })('alpha/src/y.py')).toBe(true);
    expect(pathFilter('!src/**', { belowTopLevel: true })('alpha/src/y.py')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('is true only when some pattern matches', () => {
    const patterns = ['**/*.md', 'docs/**'];
    expect(matchesAnyGlob('README.md', patterns)).toBe(true);
    expect(matchesAnyGlob('src/index.ts', patterns)).toBe(false);
    expect(matchesAnyGlob('src/index.ts', [])).toBe(false);
  });

  it('normalises backslashes so Windows callers get the same answer', () => {
    expect(matchesAnyGlob('docs\\a.txt', ['docs/**'])).toBe(true);
  });
});
