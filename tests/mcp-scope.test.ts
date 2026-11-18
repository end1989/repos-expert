import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clientFor, makeFixture, resultText } from './mcp-fixture.js';
import { initGitRepo, makeTempDir, testConfig } from './helpers.js';

/** What the tools can reach — and what they refuse — beyond the plain path guard. */
describe('MCP scope', () => {
  it('treats an excluded repo as absent from every tool, not just the listing', async () => {
    const { client } = await makeFixture({ excludeRepos: ['beta'] });
    const listed = resultText(await client.callTool({ name: 'list_repos', arguments: {} }));
    expect(listed).not.toContain('beta');

    const read = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'beta', path: 'main.py' },
    });
    expect(read.isError).toBe(true);
    expect(resultText(read)).toMatch(/Unknown repo "beta"/);

    const searched = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'beta' } }),
    );
    expect(searched).not.toContain('beta/main.py');
    const found = resultText(
      await client.callTool({ name: 'find_files', arguments: { pattern: '*.py' } }),
    );
    expect(found).not.toContain('beta/');
  });

  it('never serves git internals, where a remote URL can carry a token', async () => {
    const { client } = await makeFixture();
    for (const p of ['.git/config', '.git/HEAD', 'src/../.git/config']) {
      const res = await client.callTool({
        name: 'read_repo_file',
        arguments: { repo: 'alpha', path: p },
      });
      expect(res.isError, p).toBe(true);
      expect(resultText(res), p).toMatch(/\.git/);
    }
  });

  it('refuses .git reached through a link inside the repo, not just by name', async () => {
    const { cfg, client } = await makeFixture();
    const alpha = path.join(cfg.reposDir, 'alpha');
    try {
      fs.symlinkSync(path.join(alpha, '.git'), path.join(alpha, 'gitlink'), 'junction');
    } catch {
      return; // this machine cannot make links
    }
    const res = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'alpha', path: 'gitlink/config' },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/\.git/);
  });

  it.runIf(process.platform === 'win32')(
    'refuses Windows spellings of .git: a short name, and alternate-stream syntax',
    async () => {
      const { cfg, client } = await makeFixture();
      const paths = ['.git::$INDEX_ALLOCATION/config', '.git./config', '.GIT /config'];
      if (fs.existsSync(path.join(cfg.reposDir, 'alpha', 'GIT~1'))) paths.push('GIT~1/config');
      for (const p of paths) {
        const res = await client.callTool({
          name: 'read_repo_file',
          arguments: { repo: 'alpha', path: p },
        });
        expect(res.isError, p).toBe(true);
        expect(resultText(res), p).not.toContain('[core]');
      }
    },
  );

  it('treats an excluded repo as absent whatever the case of the name in the config', async () => {
    const { client } = await makeFixture({ excludeRepos: ['BETA'] });
    const read = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'beta', path: 'main.py' },
    });
    expect(read.isError).toBe(true);
    const searched = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'beta' } }),
    );
    expect(searched).not.toContain('beta/main.py');
    const docs = resultText(
      await client.callTool({ name: 'search_knowledge', arguments: { query: 'Python script' } }),
    );
    expect(docs).not.toContain('repos/beta/');
  });

  it('hides the docs of every excluded repo, however many are excluded', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `other${i}`);
    const { cfg, client } = await makeFixture({ excludeRepos: [...many, 'beta'] });
    for (const name of many) {
      const dir = path.join(cfg.knowledgeDir, 'repos', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'card.md'), `# ${name}\n\nA Python script too.\n`);
    }
    const res = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'Python script' },
    });
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).not.toContain('repos/beta/');
  });

  it('reads a glob given across every repo as each repo’s own path', async () => {
    const { client } = await makeFixture();
    const out = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'greet', glob: 'src/**' } }),
    );
    expect(out).toContain('alpha/src/hello.ts');
  });

  it('refuses a file path longer than any real one, at once', async () => {
    const { client } = await makeFixture();
    const start = performance.now();
    const res = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'alpha', path: `${'a/'.repeat(64_000)}x` },
    });
    expect(res.isError).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('refuses a glob longer than any real one', async () => {
    const { client } = await makeFixture();
    const res = await client.callTool({
      name: 'find_files',
      arguments: { pattern: `${'x'.repeat(300)}*` },
    });
    expect(res.isError).toBe(true);
  });

  it('answers a search of the written docs before any exist with what to do, not a ripgrep error', async () => {
    const cfg = testConfig(makeTempDir('expert-mcp-empty-'));
    fs.mkdirSync(cfg.reposDir, { recursive: true });
    const client = await clientFor(cfg);
    const res = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'anything' },
    });
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toMatch(/No written docs yet/);
  });

  it('answers a code search before the repos folder exists with the setup hint', async () => {
    const cfg = testConfig(makeTempDir('expert-mcp-none-'));
    const client = await clientFor(cfg);
    const res = await client.callTool({ name: 'search_code', arguments: { query: 'anything' } });
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toMatch(/does not exist yet/);
  });

  it('explains a repo with no commits instead of passing on a raw git error', async () => {
    const { cfg, client } = await makeFixture();
    initGitRepo(path.join(cfg.reposDir, 'empty'));
    const res = await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'empty' } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/has no commits yet/);
  });
});
