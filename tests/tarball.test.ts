import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published tarball is what strangers install. `package.json`'s `files`
 * allowlist is the only thing keeping `knowledge/`, `repos/`, a personal
 * `expert.config.json`, `.npmrc` and the like out of it — so this test packs
 * for real (`npm pack --dry-run`) and refuses anything that is not on the
 * list below. `prepublishOnly` runs the suite, so a bad publish fails here.
 */

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Everything a tarball entry may match. Anything else is a leak. */
const ALLOWED: RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^SETUP\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^expert\.config\.example\.json$/,
  /^dist\/[A-Za-z0-9._/-]+\.(js|d\.ts|js\.map|d\.ts\.map)$/,
];

/** Files that must be present or the package does not work / is not honest. */
const REQUIRED = ['package.json', 'dist/cli/index.js', 'dist/mcp/server.js', 'README.md', 'LICENSE'];

/** Anything matching these is a leak of the author's environment, full stop. */
const FORBIDDEN: RegExp[] = [
  /^knowledge\//,
  /^repos\//,
  /^repos-archived\//,
  /^expert\.config\.json$/,
  /^\.npmrc$/,
  /^\.env/,
  /^tests?\//,
  /^src\//,
  /^node_modules\//,
  /^\.git/,
  /^\.remember\//,
];

function npmCli(): string | null {
  // Set by npm/npx for anything they spawn (npm test, npx vitest, prepublishOnly).
  const fromEnv = process.env.npm_execpath;
  if (fromEnv !== undefined && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv;
  // Fallbacks: npm bundled with the running Node.
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

interface PackEntry {
  files: Array<{ path: string }>;
}

/**
 * `npm pack --json` printed an array of packages through npm 11 and an object keyed by
 * package name from npm 12. Accept both — the release workflow installs npm@latest, CI
 * uses whatever Node bundles, and this guard must not depend on which one ran it.
 */
export function firstPackedEntry(parsed: unknown): PackEntry {
  const candidate = Array.isArray(parsed)
    ? (parsed[0] as unknown)
    : parsed !== null && typeof parsed === 'object'
      ? (Object.values(parsed as Record<string, unknown>)[0] as unknown)
      : undefined;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !Array.isArray((candidate as { files?: unknown }).files)
  ) {
    throw new Error(`npm pack --json returned no packages (got ${JSON.stringify(parsed).slice(0, 120)})`);
  }
  return candidate as PackEntry;
}

function packedPaths(): string[] {
  const cli = npmCli();
  if (cli === null) throw new Error('could not locate npm-cli.js to run `npm pack --dry-run`');
  const out = execFileSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return firstPackedEntry(JSON.parse(out)).files.map((f) => f.path.replace(/\\/g, '/'));
}

describe('npm pack --json output shapes', () => {
  const entry = { files: [{ path: 'package.json' }] };

  it('accepts the npm <= 11 array shape', () => {
    expect(firstPackedEntry([entry])).toBe(entry);
  });

  it('accepts the npm >= 12 object-keyed-by-name shape', () => {
    expect(firstPackedEntry({ 'repos-expert': entry })).toBe(entry);
  });

  it.each([[], {}, null, 'nope', [{ nope: true }]])('rejects %j', (bad) => {
    expect(() => firstPackedEntry(bad)).toThrow(/returned no packages/);
  });
});

describe('published tarball', () => {
  const paths = packedPaths();

  it('packs something', () => {
    expect(paths.length).toBeGreaterThan(5);
  });

  it('contains only allowlisted paths', () => {
    const strays = paths.filter((p) => !ALLOWED.some((re) => re.test(p)));
    expect(strays, `not on the tarball allowlist: ${strays.join(', ')}`).toEqual([]);
  });

  it('never contains the author environment', () => {
    const leaks = paths.filter((p) => FORBIDDEN.some((re) => re.test(p)));
    expect(leaks, `must never ship: ${leaks.join(', ')}`).toEqual([]);
  });

  it('contains everything the package needs to run and to be honest about itself', () => {
    const missing = REQUIRED.filter((r) => !paths.includes(r));
    expect(missing, `missing from tarball (run \`npm run build\`?): ${missing.join(', ')}`).toEqual([]);
  });
});
