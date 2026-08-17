import { describe, it, expect } from 'vitest';
import { curatorEnvFrom, describeProvider, isValidEnvKey, parseClaudeAuthOutput } from '../src/provider.js';

describe('describeProvider', () => {
  const sub = { hasClaudeCode: true };

  it('reports the subscription when nothing redirects it', () => {
    const p = describeProvider({}, sub);
    expect(p.kind).toBe('subscription');
    expect(p.detail).toMatch(/subscription/i);
  });

  it('reports a local or custom endpoint, and shows which one', () => {
    const p = describeProvider({ ANTHROPIC_BASE_URL: 'http://localhost:4000' }, sub);
    expect(p.kind).toBe('custom-endpoint');
    expect(p.detail).toContain('http://localhost:4000');
  });

  it('says plainly when an API key means per-token billing', () => {
    const p = describeProvider({ ANTHROPIC_API_KEY: 'sk-ant-secret' }, sub);
    expect(p.kind).toBe('api-key');
    expect(p.detail).toMatch(/per.token|billed/i);
  });

  it('never echoes the key itself', () => {
    const p = describeProvider({ ANTHROPIC_API_KEY: 'sk-ant-hunter2' }, sub);
    expect(JSON.stringify(p)).not.toContain('hunter2');
  });

  it('recognises Bedrock and Vertex, which outrank a base URL', () => {
    expect(describeProvider({ CLAUDE_CODE_USE_BEDROCK: '1' }, sub).kind).toBe('bedrock');
    expect(describeProvider({ CLAUDE_CODE_USE_VERTEX: '1' }, sub).kind).toBe('vertex');
    expect(
      describeProvider({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'http://x' }, sub).kind,
    ).toBe('bedrock');
  });

  it('an empty value does not count as set', () => {
    expect(describeProvider({ ANTHROPIC_BASE_URL: '' }, sub).kind).toBe('subscription');
    expect(describeProvider({ CLAUDE_CODE_USE_BEDROCK: '0' }, sub).kind).toBe('subscription');
  });

  it('says "signed in" only when the auth probe says so — and names the account type, never the account', () => {
    const p = describeProvider({}, {
      hasClaudeCode: true,
      claudeAuth: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' },
    });
    expect(p.kind).toBe('subscription');
    expect(p.detail).toMatch(/signed in/i);
    expect(p.detail).toContain('claude.ai');
    expect(p.detail).toContain('max');
    expect(p.detail).not.toContain('someone@example.com');
  });

  it('keeps the hedge when the probe could not run', () => {
    const p = describeProvider({}, { hasClaudeCode: true, claudeAuth: null });
    expect(p.kind).toBe('subscription');
    expect(p.detail).toMatch(/if it is signed in/i);
  });

  it('reports none, with the sign-in command, when Claude Code is installed but signed out', () => {
    const p = describeProvider({}, { hasClaudeCode: true, claudeAuth: { loggedIn: false } });
    expect(p.kind).toBe('none');
    expect(p.detail).toMatch(/not signed in/i);
    expect(p.fix).toBe('claude auth login');
  });

  it('an API key still wins over a signed-in Claude Code — that is what would be billed', () => {
    const p = describeProvider({ ANTHROPIC_API_KEY: 'sk-ant-secret' }, { hasClaudeCode: true, claudeAuth: { loggedIn: true } });
    expect(p.kind).toBe('api-key');
  });

  it('reports none when there is no Claude Code and nothing configured', () => {
    const p = describeProvider({}, { hasClaudeCode: false });
    expect(p.kind).toBe('none');
  });

  it('a custom endpoint counts even without Claude Code signed in', () => {
    const p = describeProvider({ ANTHROPIC_BASE_URL: 'http://localhost:4000' }, { hasClaudeCode: false });
    expect(p.kind).toBe('custom-endpoint');
  });
});

describe('curatorEnvFrom', () => {
  it('layers config over the process environment', () => {
    const env = curatorEnvFrom({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://old' }, { ANTHROPIC_BASE_URL: 'http://new' });
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://new');
  });

  it('passes the environment through untouched when config sets nothing', () => {
    expect(curatorEnvFrom({ PATH: '/bin' }, undefined)).toEqual({ PATH: '/bin' });
  });
});

describe('isValidEnvKey', () => {
  it('accepts normal names and rejects anything a shell would treat oddly', () => {
    expect(isValidEnvKey('ANTHROPIC_BASE_URL')).toBe(true);
    expect(isValidEnvKey('_x1')).toBe(true);
    expect(isValidEnvKey('1BAD')).toBe(false);
    expect(isValidEnvKey('HAS SPACE')).toBe(false);
    expect(isValidEnvKey('HAS=EQUALS')).toBe(false);
    expect(isValidEnvKey('')).toBe(false);
  });
});

describe('parseClaudeAuthOutput', () => {
  it('reads the JSON whatever the exit code was — signed out prints loggedIn:false and exits 1', () => {
    expect(parseClaudeAuthOutput('{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n')).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty',
    });
  });

  it('tolerates chatter before the JSON, and gives null for anything that is not an answer', () => {
    expect(parseClaudeAuthOutput('Checking…\n{"loggedIn":true,"authMethod":"claude.ai"}')?.loggedIn).toBe(true);
    expect(parseClaudeAuthOutput('')).toBeNull();
    expect(parseClaudeAuthOutput('command not found')).toBeNull();
    expect(parseClaudeAuthOutput('{"nope": 1}')).toBeNull();
    expect(parseClaudeAuthOutput('{ broken')).toBeNull();
  });
});
