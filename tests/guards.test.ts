import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveWithin,
  readFileCapped,
  MAX_READ_LINES,
  MAX_READ_BYTES,
} from '../src/mcp/guards.js';
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
    // Absolute on both platforms: POSIX resolves this to /etc/passwd, and Windows
    // resolves a root-relative path against the root's drive (C:\etc\passwd).
    // Either way it lands outside the repository.
    expect(() => resolveWithin(root, '/etc/passwd')).toThrow(/escapes/);
  });

  it.runIf(process.platform === 'win32')('rejects drive-absolute paths outside the root', () => {
    // Only meaningful on Windows. On POSIX 'C:/windows/system32' is a legitimate
    // relative name that resolves *inside* the root, so asserting a throw there
    // would be asserting the wrong behaviour.
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

    // ~300 lines × 1 KB each: over the byte cap, well under the line cap
    const byteCapped = Array.from({ length: 300 }, () => 'x'.repeat(1024)).join('\n');
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

  it('caps at MAX_READ_LINES and says exactly where to continue', () => {
    const out = readFileCapped(path.join(dir, 'big.txt'));
    const lines = out.split('\n');
    expect(lines.length).toBe(MAX_READ_LINES + 1);
    expect(lines[0]).toBe('line 1');
    expect(lines[MAX_READ_LINES - 1]).toBe('line 2000');
    expect(lines.at(-1)).toBe('… showing lines 1–2000 of 3000. Continue with startLine: 2001.');
  });

  it('caps at MAX_READ_BYTES on a whole line, and says where to continue', () => {
    const out = readFileCapped(path.join(dir, 'byte-cap.txt'));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_READ_BYTES + 200);
    const lines = out.split('\n');
    const shown = lines.length - 1;
    expect(lines.slice(0, shown).every((l) => l === 'x'.repeat(1024))).toBe(true); // no half lines
    expect(lines.at(-1)).toBe(
      `… showing lines 1–${shown} of 300. Continue with startLine: ${shown + 1}.`,
    );
  });

  it('keeps the cap well under what MCP clients accept inline in one result', () => {
    // Claude Code moves any text result over 50,000 characters out of the conversation.
    expect(MAX_READ_BYTES).toBeLessThanOrEqual(48 * 1024);
  });

  it('counts the continuation from where the requested range began', () => {
    const out = readFileCapped(path.join(dir, 'big.txt'), 500);
    const lines = out.split('\n');
    expect(lines[0]).toBe('line 500');
    expect(lines.at(-1)).toBe('… showing lines 500–2499 of 3000. Continue with startLine: 2500.');
  });

  it('says when the requested range starts past the end of the file', () => {
    expect(() => readFileCapped(path.join(dir, 'small.txt'), 10)).toThrow(/has 3 lines/);
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => readFileCapped(path.join(dir, 'small.txt'), 3, 2)).toThrow(/endLine/);
  });

  it('does not dump a binary file into the conversation', () => {
    fs.writeFileSync(
      path.join(dir, 'blob.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
    );
    expect(readFileCapped(path.join(dir, 'blob.bin'))).toBe('Binary file (8 bytes) — not shown.');
  });

  it('rejects reading a directory', () => {
    expect(() => readFileCapped(dir)).toThrow(/directory/);
  });
});
