import { describe, it, expect } from 'vitest';
import { rgPath } from '@vscode/ripgrep';
import { checkToolCall } from '../src/curator/confine.js';
import { makeTempDir } from './helpers.js';
import { EVERYDAY, filesRipgrepSearches, leakingGlobs, plantGitTree } from './ripgrep-judge.js';

/**
 * The hook decides whether a Grep glob could let ripgrep into a .git folder. Here ripgrep
 * itself is the judge — this project's own ripgrep (tests/runtime judges with the one inside
 * the runtime, which reads some globs differently): any glob of the corpus that brings a
 * planted token back must be one the hook refuses.
 */

const root = makeTempDir('confine-rg-');
plantGitTree(root);
const ripgrep = { path: rgPath };

describe('Grep globs, judged by ripgrep itself', () => {
  it('refuses every glob with which ripgrep would search inside a .git folder', async () => {
    const leaking = await leakingGlobs(ripgrep, root);
    // Not vacuous: the corpus does contain globs that open .git, nested ones included.
    expect(leaking).toContain('{.git,x} {config,y}');
    expect(leaking).toContain('vendor/**');
    expect(leaking).toContain('alpha/**');
    expect(leaking).toContain('[.-/]git [.-/]git/conf?g');

    const allowedYetLeaking = leaking.filter(
      (glob) => checkToolCall(root, 'Grep', { pattern: 'TOKEN_', glob }).allowed,
    );
    expect(allowedYetLeaking).toEqual([]);
  }, 300_000);

  it('allows everyday globs, and ripgrep really searches with them', async () => {
    for (const glob of EVERYDAY) {
      expect(checkToolCall(root, 'Grep', { pattern: 'TOKEN_', glob }), glob).toEqual({
        allowed: true,
      });
    }
    // The fixture is real: an ordinary glob finds the planted source file.
    const found = await filesRipgrepSearches(ripgrep, root, 'src/**/*.ts');
    expect(found?.map((f) => f.replace(/\\/g, '/'))).toEqual(['./src/index.ts']);
  });
});
