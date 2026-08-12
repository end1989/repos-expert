import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-cfg-'));
  const p = path.join(dir, 'expert.config.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('loadConfig', () => {
  it('applies defaults and resolves paths against the config directory', () => {
    const p = writeConfig({ githubUser: 'example-user' });
    const cfg = loadConfig(p);
    expect(cfg.githubUser).toBe('example-user');
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './repos'));
    expect(cfg.knowledgeDir).toBe(path.resolve(path.dirname(p), './knowledge'));
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.excludeRepos).toEqual([]);
    expect(cfg.includeArchived).toBe(false);
    expect(cfg.curateConcurrency).toBe(4);
    expect(cfg.curateTimeoutMinutes).toBe(25);
  });

  it('defaults the repos list to a file inside the repos folder, where people will find it', () => {
    const p = writeConfig({ reposDir: './code' });
    const cfg = loadConfig(p);
    expect(cfg.reposListFile).toBe(path.join(cfg.reposDir, 'repos.txt'));
  });

  it('defaults curatorEnv to empty — no environment meddling unless asked', () => {
    expect(loadConfig(writeConfig({})).curatorEnv).toEqual({});
  });

  it('carries curatorEnv through, so a local endpoint survives into a scheduled run', () => {
    const p = writeConfig({ curatorEnv: { ANTHROPIC_BASE_URL: 'http://localhost:4000' } });
    expect(loadConfig(p).curatorEnv).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:4000' });
  });

  it('rejects a curatorEnv name that is not a valid variable', () => {
    const p = writeConfig({ curatorEnv: { 'BAD NAME': 'x' } });
    expect(() => loadConfig(p)).toThrow(/curatorEnv/);
  });

  it('rejects a non-string curatorEnv value rather than passing undefined to a subprocess', () => {
    const p = writeConfig({ curatorEnv: { ANTHROPIC_BASE_URL: 4000 } });
    expect(() => loadConfig(p)).toThrow(/curatorEnv/);
  });

  it('honors an explicit reposListFile, resolved like every other path', () => {
    const p = writeConfig({ reposListFile: './my-services.txt' });
    expect(loadConfig(p).reposListFile).toBe(path.resolve(path.dirname(p), './my-services.txt'));
  });

  it('honors explicit values', () => {
    const p = writeConfig({
      githubUser: 'x',
      reposDir: './mirrors',
      model: 'claude-haiku-4-5-20251001',
      excludeRepos: ['dotfiles'],
      includeArchived: true,
      curateConcurrency: 6,
      curateTimeoutMinutes: 40,
    });
    const cfg = loadConfig(p);
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './mirrors'));
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.excludeRepos).toEqual(['dotfiles']);
    expect(cfg.includeArchived).toBe(true);
    expect(cfg.curateConcurrency).toBe(6);
  });

  it.each([0, -1, 17, 2.5, '4'])('rejects curateConcurrency %o', (value) => {
    const p = writeConfig({ githubUser: 'x', curateConcurrency: value });
    expect(() => loadConfig(p)).toThrow(/curateConcurrency.*integer between 1 and 16/);
  });

  it('loads without githubUser — GitHub is optional, the repos folder is not', () => {
    const p = writeConfig({});
    const cfg = loadConfig(p);
    expect(cfg.githubUser).toBeNull();
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './repos'));
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig('C:/nope/expert.config.json')).toThrow(/not found/i);
  });

  it('with no argument, prefers an expert.config.json in the current working directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-cfg-cwd-'));
    fs.writeFileSync(
      path.join(dir, 'expert.config.json'),
      JSON.stringify({ githubUser: 'distinctive-cwd-user' }),
    );
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const cfg = loadConfig();
      expect(cfg.githubUser).toBe('distinctive-cwd-user');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
