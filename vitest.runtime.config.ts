import { defineConfig } from 'vitest/config';

/**
 * `npm run test:runtime`: the tests that start the real Claude Code runtime, the one the
 * Agent SDK bundles for this platform, against a fake Messages API on 127.0.0.1
 * (tests/runtime). No tokens and no network, but each run starts the runtime, so they run
 * as their own CI job rather than inside `npm test`.
 */
export default defineConfig({
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
