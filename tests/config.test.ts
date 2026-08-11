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
    const p = writeConfig({ githubUser: 'end1989' });
    const cfg = loadConfig(p);
    expect(cfg.githubUser).toBe('end1989');
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './repos'));
    expect(cfg.knowledgeDir).toBe(path.resolve(path.dirname(p), './knowledge'));
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.excludeRepos).toEqual([]);
    expect(cfg.includeArchived).toBe(false);
  });

  it('honors explicit values', () => {
    const p = writeConfig({
      githubUser: 'x',
      reposDir: './mirrors',
      model: 'claude-haiku-4-5-20251001',
      excludeRepos: ['dotfiles'],
      includeArchived: true,
    });
    const cfg = loadConfig(p);
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './mirrors'));
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.excludeRepos).toEqual(['dotfiles']);
    expect(cfg.includeArchived).toBe(true);
  });

  it('throws when githubUser is missing', () => {
    const p = writeConfig({});
    expect(() => loadConfig(p)).toThrow(/githubUser/);
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig('C:/nope/expert.config.json')).toThrow(/not found/i);
  });
});
