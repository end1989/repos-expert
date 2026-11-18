import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Only this project's tests — a repos/ folder beside a clone can hold many other
    // repositories whose own test suites must never be swept into our runs.
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // Every source file counts, including any no test imports — an untested module
      // shows up as 0%, not as absent.
      include: ['src/**/*.ts'],
      // The CLI entry point is wiring, exercised end to end by spawning the built binary.
      exclude: ['src/cli/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});
