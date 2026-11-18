import type { CitationReport, RunStats } from '../registry.js';

/** Said only when something needs a look: citations that point at nothing. */
export function describeCitations(report: CitationReport): string {
  if (report.broken.length === 0) return '';
  return `${report.broken.length} of ${report.checked} citations do not resolve (see meta.json)`;
}

function duration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/** One run, as a person scanning a batch log wants it: cost, time, effort, anything odd. */
export function describeRun(stats: RunStats): string {
  const parts = [
    `$${stats.costUsd.toFixed(2)}`,
    duration(stats.durationMs),
    `${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'}`,
  ];
  if (stats.deniedToolCalls > 0) {
    parts.push(
      `${stats.deniedToolCalls} ${stats.deniedToolCalls === 1 ? 'read' : 'reads'} outside the repo refused`,
    );
  }
  return parts.join(', ');
}

/**
 * git's failure text is a transcript — "Cloning into…", "remote: …", "fatal: …" — and the
 * only line worth a summary is the last fatal/error one. Keeps the whole thing out of a
 * one-line report; the user asked what failed, not for the log.
 */
export function oneLineError(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const decisive = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l));
  return (decisive ?? lines[0] ?? message).replace(/^(fatal|error):\s*/i, '');
}
