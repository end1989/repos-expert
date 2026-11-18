import type { RepoStatus, SkippedRepo } from '../registry.js';

export interface StatusPaths {
  reposDir: string;
  reposListFile: string;
}

export function formatStatus(
  statuses: RepoStatus[],
  paths?: StatusPaths,
  skipped: readonly SkippedRepo[] = [],
): string {
  const skippedLines = skipped.map(
    (s) => `${'skipped'.padEnd(10)} ${s.name.padEnd(32)} ${s.reason}`,
  );
  if (statuses.length === 0) {
    if (paths === undefined)
      return ['No repos found yet. Run `expert sync` first.', ...skippedLines].join('\n');
    return [
      `No projects found in ${paths.reposDir}.`,
      ...(skippedLines.length > 0 ? ['', ...skippedLines] : []),
      '',
      'Two ways to add some:',
      `  1. Copy or clone project folders into ${paths.reposDir}`,
      `  2. Put their git URLs in ${paths.reposListFile} and run \`expert sync\``,
      '     — or `expert add <url>`, which does both.',
    ].join('\n');
  }
  const lines = statuses.map((s) => {
    const curated = s.curatedSha ? s.curatedSha.slice(0, 7) : '-';
    const verified =
      typeof s.verifiedThrough === 'string' && s.verifiedThrough !== s.curatedSha
        ? `  (code unchanged through ${s.verifiedThrough.slice(0, 7)})`
        : '';
    return `${s.state.padEnd(10)} ${s.name.padEnd(32)} head ${s.currentSha.slice(0, 7)}  curated ${curated}${verified}`;
  });
  lines.push(...skippedLines);

  // A column of "uncurated" is a diagnosis, not an instruction — name the command.
  const uncurated = statuses.filter((s) => s.state === 'uncurated');
  const stale = statuses.filter((s) => s.state === 'stale');
  const firstUncurated = uncurated[0];
  if (firstUncurated !== undefined) {
    lines.push(
      '',
      `${uncurated.length} not studied yet. Study one and read the result:  expert refresh ${firstUncurated.name}`,
      `Then the rest, a few minutes each:  expert curate --stale`,
    );
  } else if (stale.length > 0) {
    lines.push('', `${stale.length} out of date — the code moved since. Catch up:  expert refresh`);
  }
  return lines.join('\n');
}
