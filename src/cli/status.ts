import type { RepoStatus } from '../registry.js';

export function formatStatus(statuses: RepoStatus[]): string {
  if (statuses.length === 0) return 'No repos mirrored yet. Run `expert sync` first.';
  return statuses
    .map((s) => {
      const curated = s.curatedSha ? s.curatedSha.slice(0, 7) : '-';
      return `${s.state.padEnd(10)} ${s.name.padEnd(32)} head ${s.currentSha.slice(0, 7)}  curated ${curated}`;
    })
    .join('\n');
}
