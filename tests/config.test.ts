import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findConfigPath, loadConfig } from '../src/config.js';
import { makeTempDir } from './helpers.js';

function writeConfig(obj: unknown, prefix = ''): string {
  const p = path.join(makeTempDir('expert-cfg-'), 'expert.config.json');
  fs.writeFileSync(p, prefix + JSON.stringify(obj));
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
    expect(cfg.curateConcurrency).toBe(2);
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

  it('rejects a curatorEnv name that is not a valid variable, and names it', () => {
    const p = writeConfig({ curatorEnv: { 'BAD NAME': 'x' } });
    expect(() => loadConfig(p)).toThrow(
      /"curatorEnv" name "BAD NAME" is not a valid environment variable/,
    );
  });

  it('rejects a refreshIgnore pattern the matcher cannot use, naming it, when the config loads', () => {
    const nested = writeConfig({ refreshIgnore: ['docs/**', '{a,{b,c}}'] });
    expect(() => loadConfig(nested)).toThrow(/refreshIgnore.*\{a,\{b,c\}\}.*[Nn]ested/);
    const huge = writeConfig({ refreshIgnore: ['{a,b,c,d,e,f,g,h,i,j}'.repeat(3)] });
    expect(() => loadConfig(huge)).toThrow(/refreshIgnore.*more than 64 alternatives/);
  });

  it('refuses a path that JSON turned into a control character: "C:\\repos" is C:, CR, epos', () => {
    const p = path.join(makeTempDir('expert-cfg-'), 'expert.config.json');
    const backslash = String.fromCharCode(92);
    fs.writeFileSync(p, `{"reposDir": "C:${backslash}repos"}`);
    expect(() => loadConfig(p)).toThrow(/"reposDir" contains a control character/);
  });

  it('refuses a setting it does not know, so a misspelt cap or exclusion cannot fail open', () => {
    expect(() => loadConfig(writeConfig({ curateMaxBudgetUSD: 2 }))).toThrow(
      /unknown setting "curateMaxBudgetUSD".*did you mean "curateMaxBudgetUsd"/,
    );
    expect(() => loadConfig(writeConfig({ excludedRepos: ['secret'] }))).toThrow(
      /did you mean "excludeRepos"/,
    );
    expect(loadConfig(writeConfig({ $schema: 'x', _comment: 'notes' })).excludeRepos).toEqual([]);
  });

  it('says so when --config names a folder, instead of calling it invalid JSON', () => {
    const dir = makeTempDir('expert-cfg-folder-');
    expect(() => loadConfig(dir)).toThrow(/is a folder/);
  });

  it('reads a config saved as UTF-16, as Windows PowerShell 5.1 writes with >', () => {
    const p = path.join(makeTempDir('expert-cfg-'), 'expert.config.json');
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JSON.stringify({ reposDir: './code' }), 'utf16le'),
    ]);
    fs.writeFileSync(p, utf16);
    expect(loadConfig(p).reposDir).toBe(path.resolve(path.dirname(p), './code'));
  });

  it('reads a config saved with a byte-order mark, as Notepad and Windows PowerShell write it', () => {
    const p = writeConfig({ reposDir: './code' }, '\uFEFF');
    expect(loadConfig(p).reposDir).toBe(path.resolve(path.dirname(p), './code'));
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

  it.each([0, 121, 1.5, '25'])('rejects curateTimeoutMinutes %o', (value) => {
    const p = writeConfig({ curateTimeoutMinutes: value });
    expect(() => loadConfig(p)).toThrow(/curateTimeoutMinutes.*integer between 1 and 120/);
  });

  it('has no spending cap unless one is set', () => {
    expect(loadConfig(writeConfig({})).curateMaxBudgetUsd).toBeNull();
    expect(loadConfig(writeConfig({ curateMaxBudgetUsd: null })).curateMaxBudgetUsd).toBeNull();
  });

  it('accepts a spending cap in dollars per repository', () => {
    expect(loadConfig(writeConfig({ curateMaxBudgetUsd: 2.5 })).curateMaxBudgetUsd).toBe(2.5);
  });

  it.each([0, -1, '3', Number.MAX_VALUE])('rejects curateMaxBudgetUsd %o', (value) => {
    const p = writeConfig({ curateMaxBudgetUsd: value });
    expect(() => loadConfig(p)).toThrow(/curateMaxBudgetUsd/);
  });

  it.each([
    ['model', 42],
    ['reposDir', 7],
    ['knowledgeDir', false],
    ['excludeRepos', 'dotfiles'],
    ['excludeRepos', ['ok', 3]],
    ['includeArchived', 'yes'],
    ['refreshIgnore', [1]],
  ])('rejects a %s of the wrong type, naming the key', (key, value) => {
    const p = writeConfig({ [key]: value });
    expect(() => loadConfig(p)).toThrow(new RegExp(`"${key}"`));
  });

  it('names the file when it is not valid JSON', () => {
    const dir = makeTempDir('expert-cfg-');
    const p = path.join(dir, 'expert.config.json');
    fs.writeFileSync(p, '{ "reposDir": "./repos", }');
    expect(() => loadConfig(p)).toThrow(p);
    expect(() => loadConfig(p)).toThrow(/not valid JSON/);
  });

  it('rejects a config that is not an object', () => {
    expect(() => loadConfig(writeConfig(['reposDir']))).toThrow(/must be a JSON object/);
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

  it('treats an explicit EXPERT_CONFIG that does not exist as an error, never falling back to another config', () => {
    const dir = makeTempDir('expert-cfg-explicit-');
    fs.writeFileSync(
      path.join(dir, 'expert.config.json'),
      JSON.stringify({ githubUser: 'the-wrong-one' }),
    );
    const missing = path.join(dir, 'typo', 'expert.config.json');
    const originalCwd = process.cwd();
    const originalEnv = process.env.EXPERT_CONFIG;
    process.chdir(dir); // a perfectly good config is right here — it must not be used instead
    process.env.EXPERT_CONFIG = missing;
    try {
      expect(() => loadConfig()).toThrow(missing);
      expect(() => loadConfig()).toThrow(/EXPERT_CONFIG|--config/);
      expect(findConfigPath()).toBeNull();
    } finally {
      process.chdir(originalCwd);
      if (originalEnv === undefined) delete process.env.EXPERT_CONFIG;
      else process.env.EXPERT_CONFIG = originalEnv;
    }
  });

  it('with no argument, prefers an expert.config.json in the current working directory', () => {
    const dir = makeTempDir('expert-cfg-cwd-');
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
