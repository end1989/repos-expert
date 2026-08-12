/**
 * Which model actually writes the documents.
 *
 * The curator passes no credentials of its own — it spawns Claude Code, which
 * authenticates itself from the environment. That indirection is what lets the same
 * command run against a subscription, an API key, a cloud provider, or a local model
 * behind a proxy. It is also what makes it invisible, hence this module: the one
 * place that answers "what is about to be billed, and to whom".
 */
export type ProviderKind =
  | 'subscription'
  | 'api-key'
  | 'custom-endpoint'
  | 'bedrock'
  | 'vertex'
  | 'none';

export interface Provider {
  kind: ProviderKind;
  /** Human-readable, and never containing a secret. */
  detail: string;
}

export type EnvLike = Record<string, string | undefined>;

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/** Claude Code treats these as booleans; "0" and "false" mean off. */
function isOn(value: string | undefined): boolean {
  return isSet(value) && value !== '0' && value!.toLowerCase() !== 'false';
}

export function describeProvider(env: EnvLike, opts: { hasClaudeCode: boolean }): Provider {
  if (isOn(env.CLAUDE_CODE_USE_BEDROCK)) {
    return { kind: 'bedrock', detail: 'AWS Bedrock (CLAUDE_CODE_USE_BEDROCK) — billed by AWS' };
  }
  if (isOn(env.CLAUDE_CODE_USE_VERTEX)) {
    return { kind: 'vertex', detail: 'Google Vertex (CLAUDE_CODE_USE_VERTEX) — billed by GCP' };
  }
  if (isSet(env.ANTHROPIC_BASE_URL)) {
    return {
      kind: 'custom-endpoint',
      detail: `custom endpoint ${env.ANTHROPIC_BASE_URL} — a local model or proxy, nothing billed to Anthropic`,
    };
  }
  if (isSet(env.ANTHROPIC_API_KEY)) {
    // Deliberately does not include the key.
    return { kind: 'api-key', detail: 'ANTHROPIC_API_KEY — billed per token, not from a subscription' };
  }
  if (opts.hasClaudeCode) {
    return { kind: 'subscription', detail: 'Claude Code sign-in — draws on your Claude subscription' };
  }
  return { kind: 'none', detail: 'nothing configured — studying repos will fail' };
}

export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Config layered over the real environment. Config wins, because it is the thing
 * that survives into a scheduled task, where no shell variables are set.
 */
export function curatorEnvFrom(base: EnvLike, fromConfig: Record<string, string> | undefined): EnvLike {
  if (fromConfig === undefined || Object.keys(fromConfig).length === 0) return base;
  return { ...base, ...fromConfig };
}
