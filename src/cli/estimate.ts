/**
 * Curation is the only thing here that spends money and hours. Saying so before the
 * batch starts is cheaper than explaining it afterwards.
 *
 * The figures come from measured runs of this tool — roughly two and a half to four
 * minutes per repo, and about a dollar of model usage — not from a pricing table. They
 * are an order of magnitude, and the output says so.
 */
export const MINUTES_PER_REPO_LOW = 2.5;
export const MINUTES_PER_REPO_HIGH = 4;
export const DOLLARS_PER_REPO = 1.2;

/** Above this, a batch is long enough that starting it by accident is expensive. */
export const CONFIRM_THRESHOLD = 10;

export interface Estimate {
  repos: number;
  minutesLow: number;
  minutesHigh: number;
  dollars: number;
}

export function estimateBatch(repos: number, concurrency: number): Estimate {
  const lanes = Math.max(1, Math.min(concurrency, repos));
  // Rounded up: the last partly-filled wave still takes a whole repo's time.
  const waves = Math.ceil(repos / lanes);
  return {
    repos,
    minutesLow: waves * MINUTES_PER_REPO_LOW,
    minutesHigh: waves * MINUTES_PER_REPO_HIGH,
    dollars: repos * DOLLARS_PER_REPO,
  };
}

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`;
}

export function formatEstimate(est: Estimate, repos: number, lead?: string): string {
  return [
    lead ?? `About to study ${repos} repos.`,
    `  Time:  ${duration(est.minutesLow)}–${duration(est.minutesHigh)} at this concurrency`,
    `  Cost:  roughly $${est.dollars.toFixed(0)} of model usage if you are billed per token.`,
    `         On a Claude subscription nothing is charged per repo — it draws on your allowance.`,
    `  Both numbers are a rough estimate from past runs, not a quote.`,
    `  Stopping partway is safe: finished repos are saved as they go.`,
  ].join('\n');
}

export function needsConfirmation(repos: number, interactive: boolean): boolean {
  return interactive && repos > CONFIRM_THRESHOLD;
}

/** How many names are worth reading before the list stops being informative. */
const PREVIEW_NAMES = 20;

/**
 * `--dry-run`. Wanting to know the size of a batch should never require starting it —
 * that is the one question you cannot afford to answer by experiment.
 */
export function formatDryRun(names: string[], est: Estimate): string {
  const shown = names.slice(0, PREVIEW_NAMES);
  const hidden = names.length - shown.length;
  return [
    formatEstimate(est, names.length, `${names.length} repos would be studied.`),
    '',
    'Which ones:',
    ...shown.map((n) => `  ${n}`),
    ...(hidden > 0 ? [`  … and ${hidden} more`] : []),
    '',
    'Dry run — nothing was studied and nothing was spent. Drop --dry-run to go ahead.',
  ].join('\n');
}
