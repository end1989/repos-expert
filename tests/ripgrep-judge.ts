import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Grep globs judged by ripgrep itself. A glob is handed to a real ripgrep exactly as the
 * bundled runtime's Grep tool hands it (read from the runtime: the version-control folders
 * excluded first, then the caller's glob in pieces), over a tree whose .git folders hold
 * tokens. Shared by the unit suite, which uses the project's own ripgrep, and the runtime
 * suite, which uses the ripgrep inside the runtime; the two versions read some globs
 * differently, and the hook must hold against both.
 */

const VCS_FOLDERS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

/** How the runtime splits a Grep glob: deliberately not the hook's code, so they can disagree. */
export function piecesAsTheRuntimeSplitsThem(glob: string): string[] {
  const pieces: string[] = [];
  for (const word of glob.split(/\s+/)) {
    if (word.includes('{') && word.includes('}')) pieces.push(word);
    else pieces.push(...word.split(',').filter(Boolean));
  }
  return pieces.filter(Boolean);
}

/** .git folders holding tokens at the top, in a nested repo and in a portfolio-style repo. */
export function plantGitTree(root: string): void {
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
}

/** A ripgrep to judge with; `argv0: 'rg'` runs the one inside the Claude Code binary. */
export interface Ripgrep {
  path: string;
  argv0?: string;
}

/** The files ripgrep would search for this Grep glob; `null` when ripgrep rejects the glob. */
export function filesRipgrepSearches(
  rg: Ripgrep,
  root: string,
  glob: string,
): Promise<string[] | null> {
  const args = [
    '--no-config',
    '--hidden',
    '--no-follow',
    '--files-with-matches',
    ...VCS_FOLDERS.flatMap((d) => ['--glob', `!${d}`]),
    ...piecesAsTheRuntimeSplitsThem(glob).flatMap((p) => ['--glob', p]),
    '-e',
    'TOKEN_',
    '--',
    '.',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(rg.path, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(rg.argv0 !== undefined ? { argv0: rg.argv0 } : {}),
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.split(/\r?\n/).filter(Boolean));
      else if (code === 1) resolve([]);
      else resolve(null); // ripgrep refused the glob itself: nothing was searched
    });
  });
}

export const reachesGit = (files: string[] | null): boolean =>
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
  '.gi}t',
  '[.-/]git',
  'vendor/lib/[.-/]git',
  '.gi[t/]',
  'vendor/*/*',
  'src/**/*',
  '{src,vendor}/**',
  '*a/**',
  '[av]*/**',
  '**/lib/**',
  '{*/*/.gi?,*/*/.gi?/**}',
  '.gi[!]]',
  '.gi[^]]',
  '.gi[!]x]',
  '[!]]*',
  '[^]]*',
  '*\u0085',
  '.git\u0085',
  'vendor/**\u0085',
];
const PICKERS = [
  'config',
  '{config,y}',
  'c{o,x}nfig',
  'c\\onfig',
  'conf*',
  '[c]onfig',
  '**/config',
  '.gi}t/conf?g',
  '[.-/]git/conf?g',
  'vendor/*/*/*',
  '.gi[t/]/*',
  '*/*/.gi?/**',
  '.gi[!]]/conf?g',
  '.gi[^]]/conf?g',
  'conf[!]]g',
  'config\u0085',
];

/** Globs a curator writes, which must stay allowed. */
export const EVERYDAY = [
  '*.ts',
  '*.{ts,tsx}',
  'src/**/*.ts',
  '**/*.md',
  '!*.md',
  '{src,lib}/**/*.js',
  '*.test.ts *.spec.ts',
  'docs/*.md,*.txt',
  'package.json',
  '**/*.ts !**/node_modules/**',
];

/** Every opener and picker alone, and every pairing of the two, joined three ways. */
export function corpus(): string[] {
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

/** The globs of the corpus with which `rg` would search inside a .git folder. */
export async function leakingGlobs(rg: Ripgrep, root: string): Promise<string[]> {
  const globs = corpus();
  const searched: (string[] | null)[] = [];
  for (let i = 0; i < globs.length; i += 16) {
    const batch = globs.slice(i, i + 16);
    searched.push(...(await Promise.all(batch.map((g) => filesRipgrepSearches(rg, root, g)))));
  }
  return globs.filter((_, i) => reachesGit(searched[i] ?? null));
}
