import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { oneLineError } from '../src/cli/messages.js';
import { onPath } from '../src/cli/probes.js';
import { gatherHelpState } from '../src/cli/help.js';
import { commitFile, initGitRepo, makeTempDir } from './helpers.js';

describe('oneLineError', () => {
  it('keeps the decisive line of a git transcript, without its "fatal:" prefix', () => {
    const transcript = [
      "Cloning into 'x'...",
      'remote: Repository not found.',
      "fatal: repository 'https://example.com/x.git/' not found",
    ].join('\n');
    expect(oneLineError(transcript)).toBe("repository 'https://example.com/x.git/' not found");
  });

  it('falls back to the first line when nothing is marked fatal or error', () => {
    expect(oneLineError('\n  something odd happened\nmore detail')).toBe('something odd happened');
  });
});

describe('onPath', () => {
  it('finds a command that is installed, and not one that is not', () => {
    expect(onPath('git')).toBe(true);
    expect(onPath('expert-no-such-command-anywhere')).toBe(false);
  });

  it('refuses a name that is not a plain command name, rather than handing it to a finder', () => {
    expect(onPath('git & calc')).toBe(false);
    expect(onPath('../git')).toBe(false);
  });
});

describe('gatherHelpState', () => {
  it('counts the projects, studied ones and listed URLs for the config in force', async () => {
    const root = makeTempDir('expert-helpstate-');
    const alpha = path.join(root, 'repos', 'alpha');
    initGitRepo(alpha);
    commitFile(alpha, 'a.txt', 'a');
    fs.writeFileSync(path.join(root, 'repos', 'repos.txt'), 'https://github.com/acme/one.git\n');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }),
    );
    const before = process.env.EXPERT_CONFIG;
    process.env.EXPERT_CONFIG = configPath;
    try {
      const state = await gatherHelpState('9.9.9');
      expect(state).toMatchObject({
        version: '9.9.9',
        configPath,
        repoCount: 1,
        curatedCount: 0,
        listedCount: 1,
      });
    } finally {
      if (before === undefined) delete process.env.EXPERT_CONFIG;
      else process.env.EXPERT_CONFIG = before;
    }
  });

  it('never throws, even with no config at all', async () => {
    const before = process.env.EXPERT_CONFIG;
    process.env.EXPERT_CONFIG = path.join(makeTempDir('expert-helpstate-none-'), 'missing.json');
    try {
      expect((await gatherHelpState('1.0.0')).configPath).toBeNull();
    } finally {
      if (before === undefined) delete process.env.EXPERT_CONFIG;
      else process.env.EXPERT_CONFIG = before;
    }
  });
});
