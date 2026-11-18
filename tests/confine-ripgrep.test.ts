import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { checkToolCall } from '../src/curator/confine.js';
import { makeTempDir } from './helpers.js';

/**
 * The hook decides whether a Grep glob could let ripgrep into a .git folder. Here ripgrep
 * itself is the judge: every glob below is handed to the real ripgrep exactly as the
 * bundled runtime hands it (read from its Grep tool: the version-control folders excluded
 * first, then the caller's glob split into pieces), over a tree whose .git folders hold
 * tokens. Any glob that brings a token back must be one the hook refuses.
 */

const VCS_FOLDERS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

/** How the runtime splits a Grep glob — deliberately not the hook's code, so they can disagree. */
function piecesAsTheRuntimeSplitsThem(glob: string): string[] {
  const pieces: string[] = [];
  for (const word of glob.split(/\s+/)) {
    if (word.includes('{') && word.includes('}')) pieces.push(word);
    else pieces.push(...word.split(',').filter(Boolean));
  }
  return pieces.filter(Boolean);
}

const root = makeTempDir('confine-rg-');
const plant = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
plant('.git/config', 'url = https://user:TOKEN_GIT_ROOT@example.invalid/x.git\n');
plant('vendor/lib/.git/config', 'url = https://user:TOKEN_GIT_NESTED@example.invalid/y.git\n');
plant('alpha/.git/config', 'url = https://user:TOKEN_GIT_ALPHA@example.invalid/z.git\n');
plant('alpha/src/a.ts', 'export const TOKEN_SOURCE = 1;\n');
plant('src/index.ts', 'export const TOKEN_SOURCE = 2;\n');
plant('docs/guide.md', 'TOKEN_SOURCE in docs\n');

/** The files ripgrep would search for this Grep glob; `null` when ripgrep rejects the glob. */
function filesRipgrepSearches(glob: string): Promise<string[] | null> {
  const args = [
    '--no-config',
    '--hidden',
    '--files-with-matches',
    ...VCS_FOLDERS.flatMap((d) => ['--glob', `!${d}`]),
    ...piecesAsTheRuntimeSplitsThem(glob).flatMap((p) => ['--glob', p]),
    '-e',
    'TOKEN_',
    '--',
    '.',
  ];
  return new Promise((resolve) => {
    execFile(rgPath, args, { cwd: root, windowsHide: true }, (err, stdout) => {
      const code = err === null ? 0 : (err as { code?: unknown }).code;
      if (code === 0) resolve(stdout.split(/\r?\n/).filter(Boolean));
      else if (code === 1) resolve([]);
      else resolve(null); // ripgrep refused the glob itself: nothing was searched
    });
  });
}

const reachesGit = (files: string[] | null): boolean =>
  (files ?? []).some((f) => f.split(/[\\/]/).includes('.git'));

/** Pieces that might open a .git folder, and pieces that might then pick its config file. */
const OPENERS = [
  '*',
  '**',
  '.*',
  '.git',
  '.gi?',
  '[.]git',
  '{.git,x}',
  '{.gi,x}t',
  '{x,.git}',
  '*/',
  '**/',
  '.git/',
  '/.git',
  '**/.git',
  '.g*',
  '?git',
  'vendor/**',
  'vendor/*/',
  'alpha/**',
  'alpha/*',
  'alpha/.git',
  'alpha/{.git,x}',
  '**/lib/.git',
  '.gi\\t',
  '.\\git',
  '{.git}',
  'vendor/lib/*',
];
const PICKERS = [
  'config',
  '{config,y}',
  'c{o,x}nfig',
  'c\\onfig',
  'conf*',
  '[c]onfig',
  '**/config',
];
const EVERYDAY = [
  '*.ts',
  '*.{ts,tsx}',
  'src/**/*.ts',
  '**/*.md',
  '!*.md',
  '{src,lib}/**/*.js',
  '*.test.ts *.spec.ts',
  'docs/*.md,*.txt',
  'package.json',
];

function corpus(): string[] {
  const globs = new Set<string>([...OPENERS, ...PICKERS, ...EVERYDAY]);
  for (const opener of OPENERS) {
    for (const picker of PICKERS) {
      globs.add(`${opener} ${picker}`);
      globs.add(`${opener},${picker}`);
      globs.add(`${picker} ${opener}`);
    }
  }
  return [...globs];
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

describe('Grep globs, judged by ripgrep itself', () => {
  it('refuses every glob with which ripgrep would search inside a .git folder', async () => {
    const globs = corpus();
    const searched = await inBatches(globs, 8, filesRipgrepSearches);
    const leaking = globs.filter((_, i) => reachesGit(searched[i] ?? null));
    // Not vacuous: the corpus does contain globs that open .git, nested ones included.
    expect(leaking).toContain('{.git,x} {config,y}');
    expect(leaking).toContain('vendor/**');
    expect(leaking).toContain('alpha/**');

    const allowedYetLeaking = leaking.filter(
      (glob) => checkToolCall(root, 'Grep', { pattern: 'TOKEN_', glob }).allowed,
    );
    expect(allowedYetLeaking).toEqual([]);
  }, 120_000);

  it('allows everyday globs, and ripgrep really searches with them', async () => {
    for (const glob of EVERYDAY) {
      expect(checkToolCall(root, 'Grep', { pattern: 'TOKEN_', glob }), glob).toEqual({
        allowed: true,
      });
    }
    // The fixture is real: an ordinary glob finds the planted source file.
    const found = await filesRipgrepSearches('src/**/*.ts');
    expect(found?.map((f) => f.replace(/\\/g, '/'))).toEqual(['./src/index.ts']);
  });
});
