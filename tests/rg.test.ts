import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchText, listFiles, MAX_MATCHES } from '../src/rg.js';
import { makeTempDir } from './helpers.js';

describe('ripgrep wrapper', () => {
  let root: string;

  beforeAll(() => {
    root = makeTempDir('expert-rg-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'function login() {}\n');
    fs.writeFileSync(path.join(root, 'readme.md'), 'docs about login flows\n');
    const many = Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n');
    fs.writeFileSync(path.join(root, 'big.txt'), many + '\n');
  });

  it('finds matches with relative paths and line numbers', async () => {
    const out = await searchText(root, 'login');
    expect(out).toContain('auth.ts');
    expect(out).toContain('readme.md');
    expect(out).toMatch(/auth\.ts:1:/);
  });

  it('prints repo-relative paths with forward slashes and no leading ./ — the same on every OS', async () => {
    const out = await searchText(root, 'login');
    const paths = out.split('\n').map((l) => l.split(':')[0]);
    expect(paths).toContain('src/auth.ts');
    for (const p of paths) {
      expect(p).not.toMatch(/^\.[\\/]/);
      expect(p).not.toContain('\\');
    }
    const files = await listFiles(root, '*.ts');
    expect(files.split('\n')).toContain('src/auth.ts');
  });

  it('filters with a glob', async () => {
    const out = await searchText(root, 'login', '*.ts');
    expect(out).toContain('auth.ts');
    expect(out).not.toContain('readme.md');
  });

  it('returns "No matches." on zero hits', async () => {
    expect(await searchText(root, 'zebra-unicorn')).toBe('No matches.');
  });

  it('caps results at MAX_MATCHES lines', async () => {
    const out = await searchText(root, 'needle');
    const lines = out.split('\n');
    expect(lines.length).toBe(MAX_MATCHES + 1);
    expect(lines.at(-1)).toContain('truncated');
  });

  it('lists files by glob', async () => {
    const out = await listFiles(root, '*.ts');
    expect(out).toContain('src/auth.ts');
    expect(out).not.toContain('readme.md');
  });
});
