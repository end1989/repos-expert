import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type {
  Options,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import {
  buildAgentOptions,
  createAgentRunner,
  type QueryFn,
  type RunOpts,
} from '../src/curator/agent.js';
import { CuratorError } from '../src/curator/errors.js';
import { makeTempDir } from './helpers.js';

const repo = makeTempDir('agent-repo-');
const elsewhere = makeTempDir('agent-elsewhere-');

function runOpts(overrides: Partial<RunOpts> = {}): RunOpts {
  return {
    cwd: repo,
    model: 'claude-sonnet-5',
    timeoutMs: 60_000,
    env: { PATH: 'x' },
    ...overrides,
  };
}

const USAGE = {
  input_tokens: 1200,
  output_tokens: 3400,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
} as unknown as SDKResultSuccess['usage'];

/** A complete success result as the runtime emits it, so nothing the code reads is missing. */
function success(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 91_000,
    duration_api_ms: 80_000,
    is_error: false,
    num_turns: 17,
    result: 'THE DOCUMENTS',
    stop_reason: 'end_turn',
    total_cost_usd: 0.42,
    usage: USAGE,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 1200,
        outputTokens: 3400,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 9000,
        webSearchRequests: 0,
        costUSD: 0.42,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      },
    },
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'session-abc',
    ...overrides,
  };
}

function failure(subtype: SDKResultError['subtype'], errors: string[]): SDKResultError {
  return {
    type: 'result',
    subtype,
    duration_ms: 5000,
    duration_api_ms: 4000,
    is_error: true,
    num_turns: 3,
    stop_reason: null,
    total_cost_usd: 0.05,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: '00000000-0000-4000-8000-000000000002',
    session_id: 'session-abc',
  };
}

/** A stand-in for the SDK's `query`: replays messages and records what it was asked. */
function replay(
  messages: SDKMessage[],
): QueryFn & { seen: { prompt: string; options: Options }[] } {
  const seen: { prompt: string; options: Options }[] = [];
  const fn: QueryFn = (params) => {
    seen.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return Object.assign(fn, { seen });
}

describe('buildAgentOptions — the privileges a curator session starts with', () => {
  const options = buildAgentOptions(runOpts(), new AbortController());

  it('makes Read, Glob and Grep the only built-in tools that exist for the agent', () => {
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(options.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('denies anything not pre-approved instead of bypassing permission checks', () => {
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.allowDangerouslySkipPermissions).not.toBe(true);
  });

  it('loads no settings from the machine or from the repository being studied', () => {
    // Without this the studied repo's own .claude/ (hooks, CLAUDE.md) and the operator's
    // personal plugins configure the very agent that is reading untrusted content.
    expect(options.settingSources).toEqual([]);
  });

  it('connects no MCP servers, whatever the machine has configured', () => {
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
  });

  it('keeps the runtime default system prompt, which leaves out its git status', () => {
    // Unset, the SDK sends an empty custom prompt, and the runtime omits its git-status
    // snapshot. The claude_code preset adds it to every request: commit subjects, branch
    // names and the repository's git user name, a personal identifier.
    expect(options.systemPrompt).toBeUndefined();
  });

  it('delivers the prompt as written, so an @path in a commit message attaches nothing', () => {
    // The runtime reads "@path" in a prompt as a file to attach before the first turn, and
    // no PreToolUse hook sees that read. The prompt carries commit subjects, branch names and
    // documents from the repository being studied.
    expect(options.verbatimPrompts).toBe(true);
  });

  it('installs a hook that refuses a read outside the repository', async () => {
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeTypeOf('function');
    const out = await hook!(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path.join(elsewhere, 'id_rsa') },
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '',
        cwd: repo,
      },
      't1',
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('runs in the repository, on the configured model, with the given environment', () => {
    expect(options.cwd).toBe(repo);
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.env).toEqual({ PATH: 'x' });
  });

  it('caps spend only when a budget is configured', () => {
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(
      buildAgentOptions(runOpts({ maxBudgetUsd: 3 }), new AbortController()).maxBudgetUsd,
    ).toBe(3);
  });
});

describe('createAgentRunner', () => {
  it('starts the session with the locked-down options, not the SDK defaults', async () => {
    const query = replay([success()]);
    await createAgentRunner(query)('the prompt', runOpts());
    expect(query.seen).toHaveLength(1);
    expect(query.seen[0]!.prompt).toBe('the prompt');
    expect(query.seen[0]!.options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(query.seen[0]!.options.permissionMode).toBe('dontAsk');
    expect(query.seen[0]!.options.settingSources).toEqual([]);
    expect(query.seen[0]!.options.verbatimPrompts).toBe(true);
  });

  it('returns the agent text together with what the run cost', async () => {
    const run = await createAgentRunner(replay([success()]))('p', runOpts());
    expect(run.output).toBe('THE DOCUMENTS');
    expect(run.stats).toEqual({
      costUsd: 0.42,
      turns: 17,
      durationMs: 91_000,
      inputTokens: 60_200, // 1,200 fresh + 50,000 cache reads + 9,000 cache writes
      outputTokens: 3400,
      sessionId: 'session-abc',
      deniedToolCalls: 0,
    });
  });

  it('counts the tool calls its own hook refused', async () => {
    const query: QueryFn = (params) =>
      (async function* () {
        const hook = params.options.hooks!.PreToolUse![0]!.hooks[0]!;
        const input = {
          hook_event_name: 'PreToolUse' as const,
          tool_name: 'Read',
          tool_input: { file_path: path.join(elsewhere, 'secrets.env') },
          tool_use_id: 't',
          session_id: 's',
          transcript_path: '',
          cwd: repo,
        };
        await hook(input, 't', { signal: new AbortController().signal });
        await hook(input, 't', { signal: new AbortController().signal });
        yield success();
      })();
    const run = await createAgentRunner(query)('p', runOpts());
    expect(run.stats?.deniedToolCalls).toBe(2);
  });

  it('turns an execution error into a failure that carries the runtime’s own words', async () => {
    const run = createAgentRunner(
      replay([failure('error_during_execution', ['tool crashed: EACCES'])]),
    )('p', runOpts());
    await expect(run).rejects.toThrow(/tool crashed: EACCES/);
    await expect(run).rejects.toMatchObject({ name: 'CuratorError', kind: 'agent' });
  });

  it('reports a spent budget as final, naming the setting that controls it', async () => {
    const run = createAgentRunner(replay([failure('error_max_budget_usd', [])]))(
      'p',
      runOpts({ maxBudgetUsd: 2 }),
    );
    await expect(run).rejects.toMatchObject({ kind: 'budget', retryable: false });
    await expect(run).rejects.toThrow(/curateMaxBudgetUsd/);
  });

  it.each([
    ['a spent budget', failure('error_max_budget_usd', []), 0.05],
    ['an execution error', failure('error_during_execution', ['tool crashed']), 0.05],
    [
      'a result flagged as an error',
      success({ is_error: true, result: 'Invalid API key · Fix external API key' }),
      0.42,
    ],
  ] as const)('still reports what the run spent when it ends in %s', async (_, result, costUsd) => {
    const run = createAgentRunner(replay([result]))('p', runOpts());
    await expect(run).rejects.toMatchObject({
      name: 'CuratorError',
      stats: { costUsd, sessionId: 'session-abc' },
    });
  });

  it('reads a "successful" result that is flagged as an error as the failure it is', async () => {
    // The runtime reports an unusable credential as a success whose text is the complaint.
    const complaint = success({ is_error: true, result: 'Invalid API key · Fix external API key' });
    const run = createAgentRunner(replay([complaint]))('p', runOpts());
    await expect(run).rejects.toMatchObject({ kind: 'auth', retryable: false });
    await expect(run).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('fails when the session ends without ever producing a result', async () => {
    await expect(createAgentRunner(replay([]))('p', runOpts())).rejects.toThrow(/no result/i);
  });

  it('aborts the session and reports a timeout when the agent overruns its limit', async () => {
    let aborted = false;
    const hangs: QueryFn = (params) =>
      (async function* (): AsyncGenerator<SDKMessage> {
        const signal = params.options.abortController!.signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        aborted = true;
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      })();
    const run = createAgentRunner(hangs)('p', runOpts({ timeoutMs: 20 }));
    await expect(run).rejects.toMatchObject({ kind: 'timeout', retryable: false });
    expect(aborted).toBe(true);
  });

  it('passes on a failure that is not a timeout unchanged in meaning', async () => {
    const breaks: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        throw new Error('spawn claude ENOENT');
      })();
    const run = createAgentRunner(breaks)('p', runOpts());
    await expect(run).rejects.toThrow(/spawn claude ENOENT/);
    await expect(run).rejects.not.toBeInstanceOf(CuratorError);
  });
});
