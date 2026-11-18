import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchText, listFiles, MAX_MATCHES, recordReader, requestError } from '../src/rg.js';
import { makeTempDir, initGitRepo } from './helpers.js';

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

describe('ripgrep output records', () => {
  it('reads a search record as a path and a line', () => {
    expect(recordReader('search')(`src/a.ts${NUL}3:const x = 1;`)).toEqual({
      file: 'src/a.ts',
      rest: '3:const x = 1;',
    });
    expect(recordReader('files')('src/a.ts')).toEqual({ file: 'src/a.ts', rest: null });
  });

  it('skips a file whose name has a newline in it, rather than reporting part of the name as a path', () => {
    // ripgrep prints the name "beta/x<newline>alpha", then NUL, then "1:secret". Split at the
    // newline, "alpha" would pass for a file of its own: in another repo, past any exclusion.
    const read = recordReader('search');
    expect(read('beta/x')).toBeNull();
    expect(read(`alpha${NUL}1:secret`)).toBeNull();
    expect(read(`alpha/ok.txt${NUL}2:fine`)).toEqual({ file: 'alpha/ok.txt', rest: '2:fine' });
    expect(recordReader('files')(`beta/x${NEWLINE}alpha`)).toBeNull();
  });

  it('tells a broken request from files ripgrep could not read', () => {
    const unreadable = 'rg: ./tests/unclosed-tag.html: Access is denied. (os error 5)';
    expect(requestError(unreadable)).toBeNull();
    const parse = `rg: regex parse error:${NEWLINE}    (${NEWLINE}    ^${NEWLINE}error: unclosed group`;
    expect(requestError(parse)).toMatch(/not a valid regular expression/);
    expect(requestError(`${unreadable}${NEWLINE}${parse}`)).toMatch(
      /not a valid regular expression/,
    );
  });

  it('says a query cannot span a line break, instead of answering "No matches."', async () => {
    const root = makeTempDir('expert-rg-twolines-');
    fs.writeFileSync(path.join(root, 'a.ts'), 'login() {\n  return token;\n}\n');
    await expect(
      searchText(root, `login() {${NEWLINE}  return token;`, { literal: true }),
    ).rejects.toThrow(/one line/);
    await expect(searchText(root, 'login\\n')).rejects.toThrow(/one line/);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps an excluded repo excluded even when a file name in it holds a newline',
    async () => {
      const root = makeTempDir('expert-rg-newline-');
      fs.mkdirSync(path.join(root, 'beta'));
      fs.mkdirSync(path.join(root, 'alpha'));
      fs.writeFileSync(path.join(root, 'beta', `x${NEWLINE}alpha`), 'needle from beta\n');
      fs.writeFileSync(path.join(root, 'alpha', 'ok.txt'), 'needle\n');
      expect(await searchText(root, 'needle', { excludeFolders: ['beta'] })).toBe(
        'alpha/ok.txt:1:needle',
      );
      expect(await listFiles(root, '*', { excludeFolders: ['beta'] })).toBe('alpha/ok.txt');
    },
  );
});

describe('ripgrep wrapper', () => {
  let root: string;

  beforeAll(() => {
    root = makeTempDir('expert-rg-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'function login() {}\n');
    fs.writeFileSync(path.join(root, 'readme.md'), 'docs about login flows\n');
    const many = Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n');
    fs.writeFileSync(path.join(root, 'big.txt'), many + '\n');
    for (const name of ['zeta.txt', 'alpha.txt', 'mid/beta.txt']) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), 'ordering-probe\n');
    }
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
    const out = await searchText(root, 'login', { glob: '*.ts' });
    expect(out).toContain('auth.ts');
    expect(out).not.toContain('readme.md');
  });

  it('returns "No matches." on zero hits', async () => {
    expect(await searchText(root, 'zebra-unicorn')).toBe('No matches.');
  });

  it('caps results at MAX_MATCHES lines and says how to narrow the search', async () => {
    const out = await searchText(root, 'needle');
    const lines = out.split('\n');
    expect(lines).toHaveLength(MAX_MATCHES + 1);
    expect(lines.at(-1)).toMatch(/first 100 matches/);
    expect(lines.at(-1)).toMatch(/glob/);
  });

  it('returns matches in path order, so the same query always keeps the same 100', async () => {
    const out = await searchText(root, 'ordering-probe');
    expect(out.split('\n').map((l) => l.split(':')[0])).toEqual([
      'alpha.txt',
      'mid/beta.txt',
      'zeta.txt',
    ]);
    const files = await listFiles(root, '*.txt');
    const listed = files.split('\n');
    expect(listed).toEqual([...listed].sort());
  });

  it('stops at the cap instead of failing when the full result would be enormous', async () => {
    // ~13 MB of matching output: more than the old 10 MB buffer, which turned the search
    // into an error instead of a capped result.
    const huge = makeTempDir('expert-rg-huge-');
    const line = `${'x'.repeat(190)} haystack-needle\n`;
    fs.writeFileSync(path.join(huge, 'huge.txt'), line.repeat(65_000));
    const out = await searchText(huge, 'haystack-needle');
    expect(out.split('\n')).toHaveLength(MAX_MATCHES + 1);
  });

  it('explains a query that is not a valid regular expression, and how to search literally', async () => {
    await expect(searchText(root, 'login(')).rejects.toThrow(/not a valid regular expression/);
    await expect(searchText(root, 'login(')).rejects.toThrow(/literal: true/);
  });

  it('searches for the text exactly as written when asked to', async () => {
    const out = await searchText(root, 'login(', { literal: true });
    expect(out).toContain('src/auth.ts:1:function login() {}');
  });

  it('treats a query that starts with a dash as text, never as a ripgrep option', async () => {
    fs.writeFileSync(path.join(root, 'flags.txt'), 'pass --files to list\n');
    const out = await searchText(root, '--files', { literal: true });
    expect(out).toBe('flags.txt:1:pass --files to list');
  });

  it('lists files by glob', async () => {
    const out = await listFiles(root, '*.ts');
    expect(out).toContain('src/auth.ts');
    expect(out).not.toContain('readme.md');
  });
});

describe('ripgrep wrapper — what a glob may and may not reach', () => {
  let repo: string;

  beforeAll(() => {
    repo = makeTempDir('expert-rg-scope-');
    initGitRepo(repo);
    const files: Record<string, string> = {
      'src/a.ts': 'needle\n',
      'src/deep/b.js': 'needle\n',
      'top.md': 'needle\n',
      '.env': 'needle SECRET\n',
      'node_modules/pkg/index.ts': 'needle\n',
      'build.local': 'needle\n',
      '.gitignore': 'node_modules/\nbuild.local\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    }
  });

  const pathsOf = (out: string) =>
    out
      .split('\n')
      .filter((l) => !l.startsWith('…'))
      .map((l) => l.split(':')[0]);

  it('narrows a search, and never widens it to ignored, hidden or .git files', async () => {
    const all = pathsOf(await searchText(repo, 'needle'));
    expect(all).toEqual(['src/a.ts', 'src/deep/b.js', 'top.md']);
    expect(pathsOf(await searchText(repo, 'needle', { glob: '*' }))).toEqual(all);
    expect(pathsOf(await searchText(repo, 'needle', { glob: '**' }))).toEqual(all);
  });

  it('lists files the same way: a broad glob shows what a plain listing shows, and nothing more', async () => {
    const listed = (await listFiles(repo, '*')).split('\n');
    expect(listed).toEqual(['src/a.ts', 'src/deep/b.js', 'top.md']);
    expect(listed.some((p) => p.startsWith('.git/'))).toBe(false);
  });

  it("keeps .git out even when the repository's own ignore file whitelists it", async () => {
    // A studied repository is untrusted, and ripgrep searches a hidden folder that an ignore
    // file whitelists. .git/config can hold a token in a remote URL.
    const hostile = makeTempDir('expert-rg-whitelist-');
    initGitRepo(hostile);
    fs.appendFileSync(
      path.join(hostile, '.git', 'config'),
      '[remote "origin"]\n\turl = https://user:CANARY_TOKEN@example.invalid/x.git\n',
    );
    fs.writeFileSync(path.join(hostile, '.ignore'), '!.git\n!.git/**\n');
    fs.mkdirSync(path.join(hostile, 'src'));
    fs.writeFileSync(path.join(hostile, 'src', 'a.ts'), 'export const ok = 1;\n');

    expect(await searchText(hostile, 'CANARY_TOKEN', { literal: true })).toBe('No matches.');
    const listed = (await listFiles(hostile, '**')).split('\n');
    expect(listed).toContain('src/a.ts');
    expect(listed.filter((p) => /(^|\/)\.git(\/|$)/.test(p))).toEqual([]);
  });

  it('understands path globs, alternatives and exclusions', async () => {
    expect(pathsOf(await searchText(repo, 'needle', { glob: 'src/**/*.ts' }))).toEqual([
      'src/a.ts',
    ]);
    expect(pathsOf(await searchText(repo, 'needle', { glob: '*.{ts,js}' }))).toEqual([
      'src/a.ts',
      'src/deep/b.js',
    ]);
    expect(pathsOf(await searchText(repo, 'needle', { glob: '!*.md' }))).toEqual([
      'src/a.ts',
      'src/deep/b.js',
    ]);
    expect((await listFiles(repo, 'src/**')).split('\n')).toEqual(['src/a.ts', 'src/deep/b.js']);
  });

  it('leaves out top-level folders it is told to skip', async () => {
    expect(pathsOf(await searchText(repo, 'needle', { excludeFolders: ['src'] }))).toEqual([
      'top.md',
    ]);
    expect((await listFiles(repo, '*', { excludeFolders: ['src'] })).split('\n')).toEqual([
      'top.md',
    ]);
  });

  it('stops a search that runs past its time limit, and says so', async () => {
    const slow = makeTempDir('expert-rg-slow-');
    fs.writeFileSync(path.join(slow, 'big.txt'), `${'x'.repeat(200)}\n`.repeat(100_000));
    const out = await searchText(slow, 'never-present-anywhere', { timeoutMs: 1 });
    expect(out).toMatch(/stopped after/);
  });

  it('reports a regex too large to compile, instead of claiming there were no matches', async () => {
    await expect(searchText(repo, 'a{1000}{1000}{1000}')).rejects.toThrow(/too large|size limit/i);
  });

  it('stops when the client cancels: before it starts, and while it runs', async () => {
    const before = new AbortController();
    before.abort();
    await expect(searchText(repo, 'needle', { signal: before.signal })).rejects.toThrow(
      /cancelled/,
    );

    const slow = makeTempDir('expert-rg-cancel-');
    fs.writeFileSync(path.join(slow, 'big.txt'), `${'x'.repeat(200)}\n`.repeat(200_000));
    const during = new AbortController();
    const search = searchText(slow, 'never-present-anywhere', { signal: during.signal });
    setTimeout(() => during.abort(), 5);
    await expect(search).rejects.toThrow(/cancelled/);
  });

  it('across a folder of repos, matches a glob against each repo’s own paths', async () => {
    const collection = makeTempDir('expert-rg-many-');
    for (const rel of ['one/src/a.ts', 'one/docs/a.md', 'two/src/b.ts']) {
      fs.mkdirSync(path.dirname(path.join(collection, rel)), { recursive: true });
      fs.writeFileSync(path.join(collection, rel), 'needle\n');
    }
    const out = await searchText(collection, 'needle', { glob: 'src/**', globBelowTopLevel: true });
    expect(pathsOf(out)).toEqual(['one/src/a.ts', 'two/src/b.ts']);
    const files = await listFiles(collection, 'src/*.ts', { globBelowTopLevel: true });
    expect(files.split('\n')).toEqual(['one/src/a.ts', 'two/src/b.ts']);
  });

  it('fails with a plain sentence when the folder to search does not exist', async () => {
    await expect(searchText(path.join(repo, 'no-such-folder'), 'x')).rejects.toThrow(
      /does not exist/,
    );
  });
});
