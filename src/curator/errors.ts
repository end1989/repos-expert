/**
 * Why a curation attempt failed, named by what should happen next rather than by where
 * the failure surfaced.
 */
export type CuratorFailureKind =
  /** Credentials were rejected, or there are none. */
  | 'auth'
  /** The account is out of credit or quota. */
  | 'billing'
  /** Throttled, after the agent runtime's own backoff gave up. */
  | 'rate-limit'
  /** The model endpoint could not be reached. */
  | 'network'
  /** Ran past `curateTimeoutMinutes` and was stopped. */
  | 'timeout'
  /** Ran past `curateMaxBudgetUsd` and was stopped. */
  | 'budget'
  /** The agent runtime reported an execution error of its own. */
  | 'agent'
  /** The agent finished, but what it returned is not the documents. */
  | 'malformed-output';

/**
 * Failures a second identical attempt cannot fix. Each one either needs a person (sign
 * in, add credit, raise a limit) or has already been retried with backoff by the agent
 * runtime before it was reported — and every attempt is a full, paid model run.
 */
const FINAL: ReadonlySet<CuratorFailureKind> = new Set<CuratorFailureKind>([
  'auth',
  'billing',
  'rate-limit',
  'network',
  'timeout',
  'budget',
]);

export class CuratorError extends Error {
  readonly kind: CuratorFailureKind;

  constructor(kind: CuratorFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CuratorError';
    this.kind = kind;
  }

  /** Whether running the same thing again could plausibly end differently. */
  get retryable(): boolean {
    return !FINAL.has(this.kind);
  }
}

/**
 * Unrecognised failures get the benefit of the doubt: only a failure known to be final
 * skips the retry.
 */
export function isWorthRetrying(err: unknown): boolean {
  return !(err instanceof CuratorError) || err.retryable;
}
