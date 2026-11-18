import { describe, it, expect } from 'vitest';
import { checkToolCall } from '../../src/curator/confine.js';
import { makeTempDir } from '../helpers.js';
import { leakingGlobs, plantGitTree } from '../ripgrep-judge.js';
import { runtimeBinary } from './runtime-binary.js';

/**
 * The Grep-glob corpus judged by the ripgrep inside the Claude Code runtime: the binary run
 * as `rg`, the way the runtime runs it. That ripgrep is the one whose reading counts, and it
 * is not the project's own: its version drops a `}` that closes nothing, so `.gi}t` is
 * `.git`, where the project's ripgrep rejects the glob. Any glob that brings a planted token
 * back must be one the hook refuses.
 */

const root = makeTempDir('runtime-rg-');
plantGitTree(root);

describe("Grep globs, judged by the runtime's own ripgrep", () => {
  it('refuses every glob with which it would search inside a .git folder', async () => {
    const leaking = await leakingGlobs({ path: runtimeBinary(), argv0: 'rg' }, root);
    // Not vacuous, and this ripgrep's own reading is in play.
    expect(leaking).toContain('{.git,x} {config,y}');
    expect(leaking).toContain('vendor/**');
    expect(leaking).toContain('.gi}t .gi}t/conf?g');

    const allowedYetLeaking = leaking.filter(
      (glob) => checkToolCall(root, 'Grep', { pattern: 'TOKEN_', glob }).allowed,
    );
    expect(allowedYetLeaking).toEqual([]);
  }, 240_000);
});
