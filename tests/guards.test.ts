import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin, readFileCapped, MAX_READ_LINES, MAX_READ_BYTES } from '../src/mcp/guards.js';
import { makeTempDir } from './helpers.js';

// Set up junction capability check at module scope
let junctionOk = false;
const junctionTestDirs = { realRoot: '', outsideDir: '', linkPath: '' };
try {
  junctionTestDirs.realRoot = makeTempDir('guard-root-');
  junctionTestDirs.outsideDir = makeTempDir('guard-outside-');
  junctionTestDirs.linkPath = path.join(junctionTestDirs.realRoot, 'link');
  fs.symlinkSync(junctionTestDirs.outsideDir, junctionTestDirs.linkPath, 'junction');
  junctionOk = true;
} catch {
  junctionOk = false;
}

describe('resolveWithin', () => {
  const root = 'C:/some/repo';
  it('resolves paths inside the root', () => {
    expect(resolveWithin(root, 'src/index.ts')).toBe(path.resolve(root, 'src/index.ts'));
  });
  it('rejects traversal outside the root', () => {
    expect(() => resolveWithin(root, '../secrets.txt')).toThrow(/escapes/);
    expect(() => resolveWithin(root, 'src/../../other')).toThrow(/escapes/);
  });
  it('rejects absolute paths outside the root', () => {
    expect(() => resolveWithin(root, 'C:/windows/system32')).toThrow(/escapes/);
  });

  it('rejects prefix collision attempts', () => {
    const realRoot = makeTempDir('guard-root-');
    const basename = path.basename(realRoot);
    const evilPath = `../${basename}-evil/x`;
    expect(() => resolveWithin(realRoot, evilPath)).toThrow(/escapes/);
  });

  it.runIf(junctionOk)('rejects paths that escape via a symlink/junction', () => {
    fs.writeFileSync(path.join(junctionTestDirs.outsideDir, 'secret.txt'), 'secret data');
    expect(() => resolveWithin(junctionTestDirs.realRoot, 'link/secret.txt')).toThrow(/escapes/);
  });
});

describe('readFileCapped', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir('expert-guard-');
    fs.writeFileSync(path.join(dir, 'small.txt'), 'one\ntwo\nthree\n');
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), big);

    // Create a file with ~300 lines × 1KB each (over 200 KB but under 2,000 lines)
    const byteCapped = Array.from({ length: 300 }, (_, i) => 'x'.repeat(1024)).join('\n');
    fs.writeFileSync(path.join(dir, 'byte-cap.txt'), byteCapped);
  });

  it('reads whole small files without a truncation notice', () => {
    const out = readFileCapped(path.join(dir, 'small.txt'));
    expect(out).toContain('two');
    expect(out).not.toContain('truncated');
  });

  it('honors a 1-based inclusive line range', () => {
    const out = readFileCapped(path.join(dir, 'small.txt'), 2, 3);
    expect(out.startsWith('two')).toBe(true);
    expect(out).toContain('three');
    expect(out).not.toContain('one');
  });

  it('caps at MAX_READ_LINES and appends a notice', () => {
    const out = readFileCapped(path.join(dir, 'big.txt'));
    const lines = out.split('\n');
    expect(lines.length).toBe(MAX_READ_LINES + 1);
    expect(lines.at(-1)).toContain('truncated');
    expect(lines[0]).toBe('line 1');
  });

  it('caps at MAX_READ_BYTES and appends a notice', () => {
    const out = readFileCapped(path.join(dir, 'byte-cap.txt'));
    expect(out).toContain('truncated');
    const byteLength = Buffer.byteLength(out, 'utf8');
    expect(byteLength).toBeLessThan(MAX_READ_BYTES + 100); // Some buffer for the notice text
  });

  it('rejects reading a directory', () => {
    expect(() => readFileCapped(dir)).toThrow(/directory/);
  });
});
