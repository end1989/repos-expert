import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Properties of the source text itself that no linter here checks, each of which has
 * broken this project once.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function filesIn(dir: string, extension: RegExp): string[] {
  const base = path.join(ROOT, dir);
  return fs
    .readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((rel) => extension.test(rel))
    .map((rel) => path.join(dir, rel));
}

const BOM = String.fromCharCode(0xfeff);

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e) return false;
  }
  return true;
}

describe('source hygiene', () => {
  it('has no invisible byte-order mark inside any source file', () => {
    // An editor or tool can turn the escape for U+FEFF into the character itself: it
    // still works, and nobody reading the code can see it. Write the escape.
    const files = ['src', 'tests', 'evals', 'scripts'].flatMap((d) =>
      filesIn(d, /\.(ts|mts|js|mjs|cjs|ps1|sh)$/),
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) =>
      fs.readFileSync(path.join(ROOT, f), 'utf8').includes(BOM),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps PowerShell scripts ASCII, which Windows PowerShell 5.1 reads correctly', () => {
    // 5.1 reads a script without a byte-order mark as Windows-1252: the last byte of a
    // UTF-8 dash becomes a curly quote, which ends a string, and the script stops parsing.
    const scripts = filesIn('scripts', /\.ps1$/);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const lines = fs.readFileSync(path.join(ROOT, script), 'utf8').split('\n');
      const bad = lines.flatMap((line, i) => (isAscii(line) ? [] : [`${script}:${i + 1}`]));
      expect(bad, 'non-ASCII characters').toEqual([]);
    }
  });
});
