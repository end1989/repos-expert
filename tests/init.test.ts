import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDesktopConfigPath,
  defaultConfigBody,
  mcpLaunchCommand,
  mergeClientConfig,
  runInit,
} from '../src/cli/init.js';
import { makeTempDir } from './helpers.js';

describe('mcpLaunchCommand', () => {
  it('uses npx when installed from npm — the package path is not stable', () => {
    const entry = path.join('C:', 'Users', 'x', 'AppData', 'npm', 'node_modules', 'repos-expert', 'dist', 'cli', 'index.js');
    expect(mcpLaunchCommand(entry)).toEqual({ command: 'npx', args: ['-y', 'repos-expert', 'mcp'] });
  });

  it('points straight at the file when run from a clone', () => {
    const entry = path.join('C:', 'dev', 'repos-expert', 'dist', 'cli', 'index.js');
    const res = mcpLaunchCommand(entry);
    expect(res.command).toBe('node');
    expect(res.args[1]).toBe('mcp');
    expect(res.args[0]).toContain('dist/cli/index.js');
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

describe('runInit', () => {
  it('writes both files and backs up an existing client config', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'cfg', 'expert.config.json');
    const clientConfigPath = path.join(root, 'client', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
    fs.writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    const res = runInit(
      { reposDir: 'C:/code', skipWorkspaceGuide: true },
      { configPath, clientConfigPath, entryPoint: '/tmp/node_modules/repos-expert/dist/cli/index.js' },
    );

    expect(res.configWritten).toBe(true);
    expect(res.clientWritten).toBe(true);
    expect(fs.existsSync(`${clientConfigPath}.backup`)).toBe(true);
    const client = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    expect(client.mcpServers.other).toBeDefined();
    expect(client.mcpServers['repos-expert'].command).toBe('npx');
  });

  it('writes a workspace CLAUDE.md but never clobbers one that exists', () => {
    const root = makeTempDir('expert-init-');
    const reposDir = path.join(root, 'code');
    const configPath = path.join(root, 'expert.config.json');

    runInit({ reposDir, skipClient: true }, { configPath, clientConfigPath: null, entryPoint: 'x' });
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

  it('never overwrites an existing config unless forced', () => {
    const root = makeTempDir('expert-init-');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(configPath, '{"reposDir":"C:/mine"}');

    const kept = runInit({ reposDir: 'C:/other', skipClient: true, skipWorkspaceGuide: true }, { configPath, clientConfigPath: null, entryPoint: 'x' });
    expect(kept.configWritten).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('C:/mine');

    const forced = runInit({ reposDir: 'C:/other', force: true, skipClient: true, skipWorkspaceGuide: true }, { configPath, clientConfigPath: null, entryPoint: 'x' });
    expect(forced.configWritten).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('C:/other');
  });

  it('says so instead of failing when the platform has no Claude Desktop', () => {
    expect(claudeDesktopConfigPath('linux')).toBeNull();
    const root = makeTempDir('expert-init-');
    const res = runInit(
      { skipWorkspaceGuide: true },
      { configPath: path.join(root, 'expert.config.json'), clientConfigPath: null, entryPoint: 'x' },
    );
    expect(res.clientWritten).toBe(false);
    expect(res.notes.join(' ')).toMatch(/by hand/);
  });
});
