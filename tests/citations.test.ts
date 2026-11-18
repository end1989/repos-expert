import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkCitations, findCitations } from '../src/curator/citations.js';
import { makeTempDir } from './helpers.js';

const repo = makeTempDir('expert-cite-');
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(
  path.join(repo, 'src', 'server.js'),
  Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
);
fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x"\n}\n');

describe('findCitations', () => {
  it('finds file:line and file:line-line references, in or out of backticks', () => {
    const found = findCitations(
      'Routes at `src/server.js:5`, handlers src/server.js:6-7, manifest package.json:2.',
    );
    expect(found.map((c) => c.text)).toEqual([
      'src/server.js:5',
      'src/server.js:6-7',
      'package.json:2',
    ]);
    expect(found[1]).toMatchObject({ file: 'src/server.js', start: 6, end: 7 });
  });

  it('accepts an en dash in a range, and a leading ./', () => {
    expect(findCitations('see ./src/server.js:5–7')[0]).toMatchObject({
      file: 'src/server.js',
      start: 5,
      end: 7,
    });
  });

  it('does not mistake a URL or a host:port for a citation', () => {
    expect(
      findCitations('calls http://localhost:4000/orders and https://api.example.com:443/v1'),
    ).toEqual([]);
    expect(findCitations('listens on localhost:4000')).toEqual([]);
  });
});

describe('checkCitations', () => {
  it('counts citations that point at real lines as sound', () => {
    const report = checkCitations(repo, {
      'interfaces.md': 'GET /health — src/server.js:5; pkg package.json:2-3',
    });
    expect(report).toEqual({ checked: 2, broken: [] });
  });

  it('reports a line past the end of the file, saying how long the file is', () => {
    const report = checkCitations(repo, { 'interfaces.md': 'route at src/server.js:40' });
    expect(report.broken).toEqual([
      { doc: 'interfaces.md', citation: 'src/server.js:40', reason: 'the file has 9 lines' },
    ]);
  });

  it('reports a file that does not exist', () => {
    const report = checkCitations(repo, { 'architecture.md': 'see src/routes/orders.js:12' });
    expect(report.broken).toEqual([
      { doc: 'architecture.md', citation: 'src/routes/orders.js:12', reason: 'no such file' },
    ]);
  });

  it('reports a range that runs backwards', () => {
    expect(checkCitations(repo, { 'map.md': 'src/server.js:7-3' }).broken[0]?.reason).toMatch(
      /ends before it starts/,
    );
  });

  it('never looks outside the repository', () => {
    const report = checkCitations(repo, { 'map.md': 'see ../elsewhere/secret.js:1' });
    expect(report.broken[0]?.reason).toBe('outside the repository');
  });

  it('judges a citation by where a link in the repository leads, not where it sits', () => {
    // src/vendor links to a folder elsewhere on the machine. Reading through it would reach
    // a file the curator itself is never allowed to open.
    const outside = makeTempDir('expert-cite-outside-');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'one\ntwo\n');
    const linked = makeTempDir('expert-cite-linked-');
    fs.mkdirSync(path.join(linked, 'src'));
    // 'junction' needs no privilege on Windows and is an ordinary symlink elsewhere.
    fs.symlinkSync(outside, path.join(linked, 'src', 'vendor'), 'junction');
    const report = checkCitations(linked, { 'map.md': 'see src/vendor/secret.js:1' });
    expect(report.broken).toEqual([
      { doc: 'map.md', citation: 'src/vendor/secret.js:1', reason: 'outside the repository' },
    ]);
  });

  it('still checks a repository that is itself reached through a link', () => {
    const viaLink = path.join(makeTempDir('expert-cite-via-'), 'repo');
    fs.symlinkSync(repo, viaLink, 'junction');
    expect(checkCitations(viaLink, { 'interfaces.md': 'src/server.js:5' })).toEqual({
      checked: 1,
      broken: [],
    });
  });

  it('leaves alone a bare name.ext:N it cannot resolve, which may be a host and port', () => {
    // "api.example.com:443" looks like a file citation; without a folder in it and with no
    // such file, it is more likely a host than a hallucinated file. Not checked, not broken.
    expect(checkCitations(repo, { 'card.md': 'talks to api.example.com:443' })).toEqual({
      checked: 0,
      broken: [],
    });
  });

  it('checks the same citation once per document', () => {
    expect(
      checkCitations(repo, { 'a.md': 'src/server.js:5 and again src/server.js:5' }).checked,
    ).toBe(1);
  });
});
