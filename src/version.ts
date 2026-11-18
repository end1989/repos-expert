import { createRequire } from 'node:module';

/**
 * This package's version, read from package.json rather than written as a literal that
 * silently drifts. version.ts sits at src/ and dist/ alike, so '../package.json' is the
 * package root in both.
 */
const pkg: unknown = createRequire(import.meta.url)('../package.json');

export const VERSION: string =
  typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
    ? pkg.version
    : '0.0.0-unknown';
