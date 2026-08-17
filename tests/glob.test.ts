import { describe, it, expect } from 'vitest';
import { globToRegExp, matchesAnyGlob } from '../src/glob.js';

/**
 * The refresh fast path decides "only docs changed" with these patterns, against
 * repo-relative, forward-slash paths as `git diff --name-only` prints them. gitignore
 * semantics where they matter: a pattern without a slash matches at any depth.
 */
describe('globToRegExp', () => {
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
    expect(globToRegExp(pattern).test(file)).toBe(expected);
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
