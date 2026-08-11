import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin, readFileCapped, MAX_READ_LINES } from '../src/mcp/guards.js';
import { makeTempDir } from './helpers.js';

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
});

describe('readFileCapped', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir('expert-guard-');
    fs.writeFileSync(path.join(dir, 'small.txt'), 'one\ntwo\nthree\n');
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), big);
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
});
