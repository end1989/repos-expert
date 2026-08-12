import { describe, it, expect } from 'vitest';
import { helpText, type HelpState } from '../src/cli/help.js';

const base: HelpState = {
  version: '9.9.9',
  configPath: 'C:/cfg/expert.config.json',
  reposDir: 'C:/code',
  reposListFile: 'C:/code/repos.txt',
  listedCount: 0,
  repoCount: 0,
  curatedCount: 0,
  githubUser: null,
};

describe('helpText', () => {
  it('leads with `expert init` when there is no config yet', () => {
    const out = helpText({ ...base, configPath: null });
    expect(out).toMatch(/not set up yet/i);
    expect(out).toMatch(/Next step:[\s\S]*expert init/);
  });

  it('leads with adding projects when the folder is empty', () => {
    const out = helpText(base);
    expect(out).toContain('C:/code/repos.txt');
    expect(out).toMatch(/Next step:[\s\S]*expert add/);
  });

  it('leads with syncing when projects are listed but not on disk', () => {
    const out = helpText({ ...base, listedCount: 3 });
    expect(out).toMatch(/Next step:[\s\S]*expert sync/);
  });

  it('leads with studying one repo when nothing has been studied', () => {
    const out = helpText({ ...base, repoCount: 4 });
    expect(out).toMatch(/Next step:[\s\S]*expert refresh/);
  });

  it('says to go ask Claude once everything is studied', () => {
    const out = helpText({ ...base, repoCount: 4, curatedCount: 4 });
    const step = out.slice(out.indexOf('Next step:'), out.indexOf('Commands'));
    expect(step).toMatch(/Claude/);
    expect(step).not.toMatch(/expert (init|add|sync)/);
  });

  it('always lists the commands and where things live', () => {
    const out = helpText({ ...base, repoCount: 2, curatedCount: 1 });
    expect(out).toContain('9.9.9');
    expect(out).toContain('C:/cfg/expert.config.json');
    expect(out).toContain('C:/code');
    expect(out).toMatch(/2 projects/);
    expect(out).toMatch(/1 studied/);
    for (const cmd of ['init', 'add', 'status', 'sync', 'refresh', 'curate', 'mcp']) {
      expect(out).toMatch(new RegExp(`^\\s+expert ${cmd}`, 'm'));
    }
  });
});
