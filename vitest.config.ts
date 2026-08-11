import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Only this project's tests — repos/ holds 155 mirrored repositories whose
    // own test suites must never be swept into our runs.
    include: ['tests/**/*.test.ts'],
  },
});
