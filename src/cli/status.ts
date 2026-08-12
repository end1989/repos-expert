import type { RepoStatus } from '../registry.js';

export interface StatusPaths {
  reposDir: string;
  reposListFile: string;
}

export function formatStatus(statuses: RepoStatus[], paths?: StatusPaths): string {
  if (statuses.length === 0) {
    if (paths === undefined) return 'No repos found yet. Run `expert sync` first.';
    return [
      `No projects found in ${paths.reposDir}.`,
      '',
      'Two ways to add some:',
      `  1. Copy or clone project folders into ${paths.reposDir}`,
      `  2. Put their git URLs in ${paths.reposListFile} and run \`expert sync\``,
      '     — or \`expert add <url>\`, which does both.',
    ].join('\n');
  }
  return statuses
    .map((s) => {
      const curated = s.curatedSha ? s.curatedSha.slice(0, 7) : '-';
      return `${s.state.padEnd(10)} ${s.name.padEnd(32)} head ${s.currentSha.slice(0, 7)}  curated ${curated}`;
    })
    .join('\n');
}
