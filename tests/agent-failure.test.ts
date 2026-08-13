import { describe, it, expect } from 'vitest';
import { explainAgentOutput } from '../src/curator/agent-failure.js';

describe('explainAgentOutput', () => {
  it('recognises an unusable API key and says how to fix it', () => {
    const msg = explainAgentOutput('Invalid API key · Fix external API key');
    expect(msg).toMatch(/API key/i);
    expect(msg).toMatch(/expert doctor|ANTHROPIC_API_KEY/);
  });

  it('recognises not being signed in', () => {
    expect(explainAgentOutput('Please run /login to authenticate')).toMatch(/sign(ed)? in|log ?in/i);
    expect(explainAgentOutput('Invalid bearer token')).toMatch(/sign(ed)? in|log ?in|token/i);
  });

  it('recognises having run out of credit or quota', () => {
    const msg = explainAgentOutput('Your credit balance is too low to access the API');
    expect(msg).toMatch(/credit|quota|balance/i);
  });

  it('recognises being rate limited, which is worth retrying rather than fixing', () => {
    expect(explainAgentOutput('429 rate_limit_error: too many requests')).toMatch(/rate limit/i);
  });

  it('returns null for output that is simply not documents', () => {
    expect(explainAgentOutput('I looked at the repo and it seems fine.')).toBeNull();
  });

  it('ignores case and surrounding noise', () => {
    expect(explainAgentOutput('\n  ERROR: invalid api key\n')).not.toBeNull();
  });

  it('is not fooled by a document that merely mentions API keys', () => {
    const doc = '===FILE: card.md===\nThis service authenticates with an API key from the client.';
    expect(explainAgentOutput(doc)).toBeNull();
  });
});
