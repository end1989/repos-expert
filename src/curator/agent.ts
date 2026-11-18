import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { EnvLike } from '../provider.js';
import type { RunStats } from '../registry.js';
import { diagnoseAgentOutput } from './agent-failure.js';
import { CURATOR_TOOLS, confineToRepo } from './confine.js';
import { CuratorError } from './errors.js';

/**
 * The one place the curator touches the Claude Agent SDK.
 *
 * The agent this starts reads repositories nobody has vetted, so its privileges are set
 * here, in code, and do not depend on the prompt being obeyed:
 *
 * - `tools` is the whole set of built-in tools that exist for the session. (`allowedTools`
 *   only pre-approves; on its own it restricts nothing.)
 * - `permissionMode: 'dontAsk'` denies anything not pre-approved. Nothing is bypassed.
 * - `settingSources: []` loads no user, project or local settings, so neither the
 *   operator's own hooks and plugins nor a `.claude/` folder inside the repository being
 *   studied can configure the agent that is reading it.
 * - `strictMcpConfig` with no servers means no MCP tool is reachable, whatever the
 *   machine has connected.
 * - A PreToolUse hook confines the three read tools to the repository (see confine.ts).
 */

export interface RunOpts {
  /** The repository to study; the agent cannot read outside it. */
  cwd: string;
  model: string;
  timeoutMs: number;
  /** Environment for the Claude Code subprocess — this is what selects the provider. */
  env: EnvLike;
  /** Stop the run once its estimated cost passes this many dollars. */
  maxBudgetUsd?: number;
  /** Repos inside `cwd` the agent must not read — set when `cwd` is the whole repos folder. */
  excludeRepos?: readonly string[];
}

export type { RunStats };

export interface AgentRun {
  output: string;
  /** Absent only for runners that do not measure, such as test doubles. */
  stats?: RunStats;
}

export type AgentRunner = (prompt: string, opts: RunOpts) => Promise<AgentRun>;

/** The part of the SDK's `query` this module uses; injectable so tests need no model. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export function buildAgentOptions(
  opts: RunOpts,
  abort: AbortController,
  onDenied?: () => void,
): Options {
  return {
    cwd: opts.cwd,
    model: opts.model,
    env: opts.env,
    tools: [...CURATOR_TOOLS],
    allowedTools: [...CURATOR_TOOLS],
    permissionMode: 'dontAsk',
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    hooks: {
      PreToolUse: [{ hooks: [confineToRepo(opts.cwd, onDenied, opts.excludeRepos ?? [])] }],
    },
    abortController: abort,
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
  };
}

function describeLimit(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return minutes >= 1 ? `${Number(minutes.toFixed(1))} min` : `${Math.round(timeoutMs / 1000)} s`;
}

function statsFrom(result: SDKResultMessage, deniedToolCalls: number): RunStats {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of Object.values(result.modelUsage)) {
    inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    outputTokens += usage.outputTokens;
  }
  return {
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: result.duration_ms,
    inputTokens,
    outputTokens,
    sessionId: result.session_id,
    deniedToolCalls,
  };
}

function outcomeOf(result: SDKResultMessage, deniedToolCalls: number): AgentRun {
  // A run that failed was still paid for: every failure carries what it spent.
  const stats = statsFrom(result, deniedToolCalls);
  if (result.subtype === 'error_max_budget_usd') {
    throw new CuratorError(
      'budget',
      'Stopped at the spending cap for one repository. Raise "curateMaxBudgetUsd" in the config, or leave the repo out with "excludeRepos".',
      { stats },
    );
  }
  if (result.subtype !== 'success') {
    const detail = result.errors.filter((e) => e.length > 0).join('; ');
    throw new CuratorError(
      'agent',
      `Curator agent failed (${result.subtype})${detail.length > 0 ? `: ${detail}` : ''}`,
      { stats },
    );
  }
  if (result.is_error) {
    const diagnosis = diagnoseAgentOutput(result.result);
    if (diagnosis !== null) throw new CuratorError(diagnosis.kind, diagnosis.message, { stats });
    throw new CuratorError(
      'agent',
      `Curator agent reported an error: ${result.result.trim().slice(0, 400)}`,
      { stats },
    );
  }
  return { output: result.result, stats };
}

export function createAgentRunner(queryFn: QueryFn = query): AgentRunner {
  return async (prompt, opts) => {
    const abort = new AbortController();
    let timedOut = false;
    let deniedToolCalls = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, opts.timeoutMs);
    try {
      const options = buildAgentOptions(opts, abort, () => {
        deniedToolCalls += 1;
      });
      for await (const message of queryFn({ prompt, options })) {
        if (message.type === 'result') return outcomeOf(message, deniedToolCalls);
      }
      throw new CuratorError('agent', 'Curator agent produced no result message');
    } catch (err) {
      // An abort surfaces as whatever the stream throws; the timer is what knows why.
      if (timedOut) {
        throw new CuratorError(
          'timeout',
          `Timed out after ${describeLimit(opts.timeoutMs)} and was stopped. Raise "curateTimeoutMinutes" in the config, or leave the repo out with "excludeRepos".`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The real thing: one locked-down Claude Code session per call. */
export const runClaudeAgent: AgentRunner = createAgentRunner();
