import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDesktopConfigPath,
  clientEntryName,
  defaultConfigBody,
  mcpLaunchCommand,
  mergeClientConfig,
  resolveFolderAnswer,
  runInit,
  suggestReposDir,
} from '../src/cli/init.js';
import { makeTempDir } from './helpers.js';

describe('mcpLaunchCommand', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';

  it('pins a global install to its absolute path, launched by the absolute node binary', () => {
    // A bare `npx repos-expert` runs whichever copy npm finds first and stays there;
    // `npm update -g` replaces these files in place, so the path is the stable thing.
    const entry = path.join(
      'C:',
      'Users',
      'x',
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      'repos-expert',
      'dist',
      'cli',
      'index.js',
    );
    const res = mcpLaunchCommand(entry, NODE);
    expect(res.command).toBe(NODE);
    expect(res.args).toEqual([
      'C:/Users/x/AppData/Roaming/npm/node_modules/repos-expert/dist/cli/index.js',
      'mcp',
    ]);
  });

  it('points straight at the file when run from a clone, with the absolute node binary', () => {
    const entry = path.join('C:', 'dev', 'repos-expert', 'dist', 'cli', 'index.js');
    const res = mcpLaunchCommand(entry, NODE);
    expect(res.command).toBe(NODE);
    expect(res.args).toEqual(['C:/dev/repos-expert/dist/cli/index.js', 'mcp']);
  });

  it('falls back to npx @latest when running out of the npx cache — that path is not stable', () => {
    const entry = path.join(
      'C:',
      'Users',
      'x',
      'AppData',
      'Local',
      'npm-cache',
      '_npx',
      'abc123',
      'node_modules',
      'repos-expert',
      'dist',
      'cli',
      'index.js',
    );
    expect(mcpLaunchCommand(entry, NODE)).toEqual({
      command: 'npx',
      args: ['-y', 'repos-expert@latest', 'mcp'],
    });
  });

  it('passes --config through when the profile is not the default one', () => {
    const entry = path.join('C:', 'dev', 'repos-expert', 'dist', 'cli', 'index.js');
    const res = mcpLaunchCommand(entry, NODE, 'C:/work/expert.config.json');
    expect(res.args).toEqual([
      'C:/dev/repos-expert/dist/cli/index.js',
      'mcp',
      '--config',
      'C:/work/expert.config.json',
    ]);
    const npx = mcpLaunchCommand(
      path.join(
        'C:',
        'x',
        '_npx',
        'abc',
        'node_modules',
        'repos-expert',
        'dist',
        'cli',
        'index.js',
      ),
      NODE,
      '/home/me/work/expert.config.json',
    );
    expect(npx.args).toEqual([
      '-y',
      'repos-expert@latest',
      'mcp',
      '--config',
      '/home/me/work/expert.config.json',
    ]);
  });

  it('accepts POSIX paths too', () => {
    const res = mcpLaunchCommand(
      '/usr/local/lib/node_modules/repos-expert/dist/cli/index.js',
      '/usr/local/bin/node',
    );
    expect(res).toEqual({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/repos-expert/dist/cli/index.js', 'mcp'],
    });
  });
});

describe('clientEntryName', () => {
  it('is the bare package name for the default profile', () => {
    expect(clientEntryName(undefined)).toBe('repos-expert');
    expect(clientEntryName('')).toBe('repos-expert');
  });

  it('suffixes a slug of the label — client keys must stay identifier-like', () => {
    expect(clientEntryName('work')).toBe('repos-expert-work');
    expect(clientEntryName('Client Work (2026)!')).toBe('repos-expert-client-work-2026');
  });
});

describe('mergeClientConfig — profiles', () => {
  it('writes under the given key so two profiles can coexist', () => {
    const merged = JSON.parse(
      mergeClientConfig(
        JSON.stringify({
          mcpServers: { 'repos-expert': { command: 'node', args: ['a.js', 'mcp'] } },
        }),
        'node',
        ['a.js', 'mcp', '--config', 'C:/work/expert.config.json'],
        'repos-expert-work',
      ),
    );
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['repos-expert', 'repos-expert-work']);
    expect(merged.mcpServers['repos-expert-work'].args).toContain('--config');
  });
});

describe('mergeClientConfig', () => {
  it('keeps other MCP servers and unrelated keys', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'node', args: ['other.js'] } },
    });
    const merged = JSON.parse(mergeClientConfig(existing, 'npx', ['-y', 'repos-expert', 'mcp']));
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(merged.mcpServers['repos-expert']).toEqual({
      command: 'npx',
      args: ['-y', 'repos-expert', 'mcp'],
    });
  });

  it('creates the structure when there is no config yet', () => {
    const merged = JSON.parse(mergeClientConfig(null, 'npx', ['-y', 'repos-expert', 'mcp']));
    expect(Object.keys(merged.mcpServers)).toEqual(['repos-expert']);
  });

  it('refuses to clobber a config it cannot parse', () => {
    expect(() => mergeClientConfig('{ not json', 'npx', [])).toThrow(/not valid JSON/);
  });

  it('keeps fields the user added to our entry, such as env', () => {
    const existing = JSON.stringify({
      mcpServers: {
        'repos-expert': { command: 'old-node', args: ['old.js', 'mcp'], env: { X: '1' } },
      },
    });
    const merged = JSON.parse(mergeClientConfig(existing, 'node', ['new.js', 'mcp']));
    expect(merged.mcpServers['repos-expert']).toEqual({
      command: 'node',
      args: ['new.js', 'mcp'],
      env: { X: '1' },
    });
  });
});

describe('resolveFolderAnswer', () => {
  const cwd = path.resolve('/work/here');
  const home = path.resolve('/home/me');

  it('makes the answer absolute, as the config needs it', () => {
    expect(resolveFolderAnswer('code', cwd, home)).toBe(path.join(cwd, 'code'));
    expect(resolveFolderAnswer('.', cwd, home)).toBe(cwd);
  });

  it('expands ~, which only a shell would otherwise', () => {
    expect(resolveFolderAnswer('~/code', cwd, home)).toBe(path.join(home, 'code'));
    expect(resolveFolderAnswer('~', cwd, home)).toBe(home);
  });

  it('drops the quotes Explorer’s "Copy as path" adds', () => {
    const quoted = `"${path.join(home, 'My Code')}"`;
    expect(resolveFolderAnswer(quoted, cwd, home)).toBe(path.join(home, 'My Code'));
  });
});

describe('defaultConfigBody', () => {
  it('omits githubUser entirely when not given — GitHub is optional', () => {
    const body = JSON.parse(defaultConfigBody({ reposDir: 'C:/code' }));
    expect('githubUser' in body).toBe(false);
    expect(body.reposDir).toBe('C:/code');
    expect(body.curateConcurrency).toBe(2);
  });

  it('includes githubUser when given', () => {
    const body = JSON.parse(defaultConfigBody({ reposDir: 'C:/code', githubUser: 'someone' }));
    expect(body.githubUser).toBe('someone');
  });
});

describe('suggestReposDir', () => {
  it('prefers a folder that already has git repos in it', () => {
    const root = makeTempDir('expert-suggest-');
    const empty = path.join(root, 'repos');
    const real = path.join(root, 'dev', 'repos');
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(path.join(real, 'a-project', '.git'), { recursive: true });

    expect(suggestReposDir([empty, real])).toBe(real);
  });

  it('falls back to the first candidate when nothing has repos yet', () => {
    const root = makeTempDir('expert-suggest-');
    const first = path.join(root, 'repos');
    expect(suggestReposDir([first, path.join(root, 'other')])).toBe(first);
  });
});

describe('runInit', () => {
  it('writes both files and backs up an existing client config', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'cfg', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    fs.writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    const res = runInit(
      { reposDir: path.join(root, 'code'), skipWorkspaceGuide: true },
      {
        configPath,
        clientConfigPath,
        entryPoint: '/tmp/node_modules/repos-expert/dist/cli/index.js',
      },
    );

    expect(res.configWritten).toBe(true);
    expect(res.clientWritten).toBe(true);
    expect(fs.existsSync(`${clientConfigPath}.backup`)).toBe(true);
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(client.mcpServers.other).toBeDefined();
    expect(client.mcpServers['repos-expert'].command).toBe(process.execPath);
    expect(client.mcpServers['repos-expert'].args).toEqual([
      '/tmp/node_modules/repos-expert/dist/cli/index.js',
      'mcp',
    ]);
  });

  it('merges into a Claude Desktop config saved with a byte-order mark, instead of refusing it', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'cfg', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    const bom = String.fromCharCode(0xfeff);
    fs.writeFileSync(
      clientConfigPath,
      bom + JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );

    const res = runInit(
      { reposDir: path.join(root, 'code'), skipWorkspaceGuide: true },
      { configPath, clientConfigPath, entryPoint: '/x/dist/cli/index.js' },
    );

    expect(res.clientWritten).toBe(true);
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(Object.keys(client.mcpServers)).toEqual(['other', 'repos-expert']);
  });

  it('keeps the first backup of the Claude Desktop config when run again', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'cfg', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    const original = JSON.stringify({ mcpServers: { mine: { command: 'original' } } });
    fs.writeFileSync(clientConfigPath, original);
    const paths = { configPath, clientConfigPath, entryPoint: '/x/dist/cli/index.js' };

    const reposDir = path.join(root, 'code');
    runInit({ reposDir, skipWorkspaceGuide: true }, paths);
    runInit({ reposDir, skipWorkspaceGuide: true, force: true }, paths);

    expect(fs.readFileSync(`${clientConfigPath}.backup`, 'utf8')).toBe(original);
  });

  it('leaves a client config it cannot parse untouched, and makes no backup of it', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'cfg', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    fs.writeFileSync(clientConfigPath, '{ "mcpServers": { oops');

    expect(() =>
      runInit(
        { reposDir: path.join(root, 'code'), skipWorkspaceGuide: true },
        { configPath, clientConfigPath, entryPoint: '/x/index.js' },
      ),
    ).toThrow(/not valid JSON/);
    expect(fs.readFileSync(clientConfigPath, 'utf8')).toBe('{ "mcpServers": { oops');
    expect(fs.existsSync(`${clientConfigPath}.backup`)).toBe(false);
  });

  it('writes a workspace CLAUDE.md but never clobbers one that exists', () => {
    const root = makeTempDir('expert-init-');
    const reposDir = path.join(root, 'code');
    const configPath = path.join(root, 'expert.config.json');

    runInit(
      { reposDir, skipClient: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    const guide = fs.readFileSync(path.join(reposDir, 'CLAUDE.md'), 'utf8');
    expect(guide).toMatch(/repositories are open to you/i);
    expect(guide).toMatch(/interfaces/);

    fs.writeFileSync(path.join(reposDir, 'CLAUDE.md'), 'MY OWN NOTES');
    const second = runInit(
      { reposDir, skipClient: true, force: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    expect(fs.readFileSync(path.join(reposDir, 'CLAUDE.md'), 'utf8')).toBe('MY OWN NOTES');
    expect(second.notes.join(' ')).toMatch(/Left your existing/);
  });

  it('creates the repos list so there is somewhere obvious to put project URLs', () => {
    const root = makeTempDir('expert-init-');
    const reposDir = path.join(root, 'code');
    const res = runInit(
      { reposDir, skipClient: true },
      {
        configPath: path.join(root, 'expert.config.json'),
        clientConfigPath: null,
        entryPoint: 'x',
      },
    );

    const listPath = path.join(reposDir, 'repos.txt');
    expect(res.reposListPath).toBe(listPath);
    expect(fs.readFileSync(listPath, 'utf8')).toMatch(/expert sync/);
    expect(res.notes.join(' ')).toContain(listPath);
  });

  it('leaves a repos list that already has projects in it alone', () => {
    const root = makeTempDir('expert-init-');
    const reposDir = path.join(root, 'code');
    const configPath = path.join(root, 'expert.config.json');
    const listPath = path.join(reposDir, 'repos.txt');
    fs.mkdirSync(reposDir, { recursive: true });
    fs.writeFileSync(listPath, 'https://github.com/acme/mine.git\n');

    runInit(
      { reposDir, skipClient: true, force: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    expect(fs.readFileSync(listPath, 'utf8')).toBe('https://github.com/acme/mine.git\n');
  });

  it('reports the folder the existing config actually uses, not the one you asked for', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'expert.config.json');
    const inUse = path.join(root, 'already-configured');
    fs.writeFileSync(configPath, JSON.stringify({ reposDir: inUse }));

    const res = runInit(
      { reposDir: path.join(root, 'asked-for'), skipClient: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );

    expect(res.reposDir).toBe(inUse);
    expect(fs.existsSync(path.join(inUse, 'repos.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'asked-for'))).toBe(false);
    expect(res.notes.join(' ')).toMatch(/--force/);
  });

  it('with --force, backs up the config and changes only what was asked', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'expert.config.json');
    const original = {
      reposDir: path.join(root, 'old').replace(/\\/g, '/'),
      excludeRepos: ['client-secret'],
      curateMaxBudgetUsd: 2,
      curatorEnv: { ANTHROPIC_BASE_URL: 'http://localhost:4000' },
    };
    fs.writeFileSync(configPath, JSON.stringify(original));
    const newDir = path.join(root, 'new');
    runInit(
      { reposDir: newDir, force: true, skipClient: true, skipWorkspaceGuide: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after).toEqual({ ...original, reposDir: newDir.replace(/\\/g, '/') });
    expect(JSON.parse(fs.readFileSync(`${configPath}.backup`, 'utf8'))).toEqual(original);
  });

  it('sets up the folder an existing config really uses, even when it relies on the default', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ githubUser: 'someone' })); // reposDir defaults
    const res = runInit(
      { reposDir: path.join(root, 'asked'), skipClient: true, skipWorkspaceGuide: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    expect(res.reposDir).toBe(path.join(root, 'repos'));
    expect(fs.existsSync(path.join(root, 'repos', 'repos.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'asked'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'treats a path that differs only in case as the same folder',
    () => {
      const root = makeTempDir('expert-init-');
      const configPath = path.join(root, 'expert.config.json');
      const repos = path.join(root, 'Repos');
      fs.writeFileSync(configPath, JSON.stringify({ reposDir: repos }));
      const res = runInit(
        { reposDir: repos.toLowerCase(), skipClient: true, skipWorkspaceGuide: true },
        { configPath, clientConfigPath: null, entryPoint: 'x' },
      );
      expect(res.notes.join(' ')).not.toMatch(/--force/);
    },
  );

  it('says so when the config path names a folder', () => {
    const root = makeTempDir('expert-init-');
    expect(() =>
      runInit(
        { reposDir: path.join(root, 'r'), skipClient: true, skipWorkspaceGuide: true },
        { configPath: root, clientConfigPath: null, entryPoint: 'x' },
      ),
    ).toThrow(/is a folder/);
  });

  it('never overwrites an existing config unless forced', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'expert.config.json');
    const mine = path.join(root, 'mine').replace(/\\/g, '/');
    const other = path.join(root, 'other');
    fs.writeFileSync(configPath, JSON.stringify({ reposDir: mine }));

    const kept = runInit(
      { reposDir: other, skipClient: true, skipWorkspaceGuide: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    expect(kept.configWritten).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toContain(mine);

    const forced = runInit(
      { reposDir: other, force: true, skipClient: true, skipWorkspaceGuide: true },
      { configPath, clientConfigPath: null, entryPoint: 'x' },
    );
    expect(forced.configWritten).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain(other.replace(/\\/g, '/'));
  });

  it('says so instead of failing when the platform has no Claude Desktop', () => {
    expect(claudeDesktopConfigPath('linux')).toBeNull();
    const root = makeTempDir('expert-init-');
    const res = runInit(
      { skipWorkspaceGuide: true },
      {
        configPath: path.join(root, 'expert.config.json'),
        clientConfigPath: null,
        entryPoint: 'x',
      },
    );
    expect(res.clientWritten).toBe(false);
    expect(res.notes.join(' ')).toMatch(/by hand/);
  });
});

describe('runInit with a second profile', () => {
  it('writes the config where told, puts knowledge beside it, and registers a --config client entry under a profile key', () => {
    const root = makeTempDir('expert-init-profile-');
    const configPath = path.join(root, 'work', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    const res = runInit(
      { reposDir: path.join(root, 'work-repos'), skipWorkspaceGuide: true, name: 'Work' },
      {
        configPath,
        defaultConfigPath: path.join(root, 'default', 'expert.config.json'),
        clientConfigPath,
        entryPoint: '/tmp/node_modules/repos-expert/dist/cli/index.js',
      },
    );
    expect(res.configWritten).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.knowledgeDir.replace(/\\/g, '/')).toBe(
      path.join(root, 'work', 'knowledge').replace(/\\/g, '/'),
    );
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(client.mcpServers['repos-expert-work']).toBeDefined();
    expect(client.mcpServers['repos-expert-work'].args).toEqual([
      '/tmp/node_modules/repos-expert/dist/cli/index.js',
      'mcp',
      '--config',
      configPath.replace(/\\/g, '/'),
    ]);
    expect(res.clientEntry).toBe('repos-expert-work');
  });

  it('derives the profile label from the config folder when none is given', () => {
    const root = makeTempDir('expert-init-profile-');
    const configPath = path.join(root, 'Client Two', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    const res = runInit(
      { reposDir: path.join(root, 'r'), skipWorkspaceGuide: true },
      {
        configPath,
        defaultConfigPath: path.join(root, 'default', 'expert.config.json'),
        clientConfigPath,
        entryPoint: 'x/dist/cli/index.js',
      },
    );
    expect(res.clientEntry).toBe('repos-expert-client-two');
  });

  it('never takes the default entry when the label slugs to nothing', () => {
    const root = makeTempDir('expert-init-profile-');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    const theDefault = { command: 'node', args: ['x/dist/cli/index.js', 'mcp'] };
    fs.writeFileSync(
      clientConfigPath,
      JSON.stringify({ mcpServers: { 'repos-expert': theDefault } }),
    );
    const res = runInit(
      { reposDir: path.join(root, 'r'), skipWorkspaceGuide: true, name: 'Работа' },
      {
        configPath: path.join(root, 'Работа', 'expert.config.json'),
        defaultConfigPath: path.join(root, 'default', 'expert.config.json'),
        clientConfigPath,
        entryPoint: 'x/dist/cli/index.js',
      },
    );
    expect(res.clientEntry).toMatch(/^repos-expert-[0-9a-f]{8}$/);
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(client.mcpServers['repos-expert']).toEqual(theDefault);
  });

  it('refuses to replace another collection’s entry that has the same label', () => {
    const root = makeTempDir('expert-init-profile-');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    const register = (folder: string) =>
      runInit(
        { reposDir: path.join(root, 'r'), skipWorkspaceGuide: true, name: 'work' },
        {
          configPath: path.join(root, folder, 'expert.config.json'),
          defaultConfigPath: path.join(root, 'default', 'expert.config.json'),
          clientConfigPath,
          entryPoint: 'x/dist/cli/index.js',
        },
      );
    register('work-a');
    const before = fs.readFileSync(clientConfigPath, 'utf8');
    expect(() => register('work-b')).toThrow(/already has a "repos-expert-work" entry/);
    expect(fs.readFileSync(clientConfigPath, 'utf8')).toBe(before);
  });

  it('gives two profiles kept in one folder their own knowledge bases and entries', () => {
    const root = makeTempDir('expert-init-profile-');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    const entries = ['work.json', 'personal.json'].map(
      (file) =>
        runInit(
          { reposDir: path.join(root, 'r'), skipWorkspaceGuide: true },
          {
            configPath: path.join(root, 'configs', file),
            defaultConfigPath: path.join(root, 'default', 'expert.config.json'),
            clientConfigPath,
            entryPoint: 'x/dist/cli/index.js',
          },
        ).clientEntry,
    );
    expect(entries).toEqual(['repos-expert-work', 'repos-expert-personal']);
    const knowledge = ['work.json', 'personal.json'].map(
      (file) => JSON.parse(fs.readFileSync(path.join(root, 'configs', file), 'utf8')).knowledgeDir,
    );
    expect(new Set(knowledge).size).toBe(2);
  });

  it('keeps the plain key and no --config for the default profile', () => {
    const root = makeTempDir('expert-init-profile-');
    const configPath = path.join(root, 'default', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    const res = runInit(
      { reposDir: path.join(root, 'r'), skipWorkspaceGuide: true },
      {
        configPath,
        defaultConfigPath: configPath,
        clientConfigPath,
        entryPoint: 'x/dist/cli/index.js',
      },
    );
    expect(res.clientEntry).toBe('repos-expert');
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(client.mcpServers['repos-expert'].args).not.toContain('--config');
  });
});
