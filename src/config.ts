import fs from 'node:fs';
import path from 'node:path';

export interface ExpertConfig {
  githubUser: string;
  reposDir: string;
  knowledgeDir: string;
  model: string;
  excludeRepos: string[];
  includeArchived: boolean;
}

const DEFAULTS = {
  reposDir: './repos',
  knowledgeDir: './knowledge',
  model: 'claude-sonnet-5',
  excludeRepos: [] as string[],
  includeArchived: false,
};

export function loadConfig(
  configPath: string = path.resolve('expert.config.json'),
): ExpertConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  if (typeof raw.githubUser !== 'string' || raw.githubUser.length === 0) {
    throw new Error('expert.config.json: "githubUser" (string) is required');
  }
  const merged = { ...DEFAULTS, ...raw } as typeof DEFAULTS & { githubUser: string };
  const base = path.dirname(configPath);
  return {
    githubUser: merged.githubUser,
    reposDir: path.resolve(base, merged.reposDir),
    knowledgeDir: path.resolve(base, merged.knowledgeDir),
    model: merged.model,
    excludeRepos: merged.excludeRepos,
    includeArchived: Boolean(merged.includeArchived),
  };
}
