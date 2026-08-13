/**
 * When the model cannot run, the agent does not throw — it returns a *successful*
 * result whose text is a short human error like "Invalid API key · Fix external API
 * key". Parsing that for documents produces "Curator output missing docs: card.md, …",
 * which sends the reader looking in exactly the wrong place. This turns the underlying
 * sentence back into the real problem.
 */
interface Pattern {
  match: RegExp;
  explain: string;
}

const PATTERNS: Pattern[] = [
  {
    match: /invalid (api[- ]?key|x-api-key)|fix external api key|authentication[_ ]error/i,
    explain:
      'The API key it tried to use was rejected. Check ANTHROPIC_API_KEY, or the curatorEnv block in your config — `expert doctor` shows which one is in force.',
  },
  {
    match: /run \/login|please log ?in|not logged ?in|invalid bearer token|oauth token (has )?expired/i,
    explain:
      'Claude Code is installed but not signed in. Run `claude` in a terminal, sign in, then try again.',
  },
  {
    match: /credit balance is too low|insufficient (credit|quota)|quota exceeded|billing/i,
    explain:
      'The account has no credit or quota left for this. Nothing is wrong with the setup — search and reading still work.',
  },
  {
    match: /rate[_ ]limit|429|too many requests|overloaded/i,
    explain:
      'Rate limited rather than misconfigured. Lower curateConcurrency (2 or 1) and run it again; finished repos are already saved.',
  },
  {
    match: /econnrefused|enotfound|fetch failed|socket hang up|network/i,
    explain:
      'Could not reach the model endpoint. If curatorEnv points at a local proxy, check that it is running.',
  },
];

/**
 * A real document set is long and contains `===FILE:` markers; these errors are one
 * short line. Requiring brevity keeps a card.md that discusses API keys from being
 * mistaken for an auth failure.
 */
const MAX_ERROR_LENGTH = 400;

export function explainAgentOutput(output: string): string | null {
  const text = output.trim();
  if (text.length > MAX_ERROR_LENGTH || text.includes('===FILE:')) return null;
  const hit = PATTERNS.find((p) => p.match.test(text));
  return hit === undefined ? null : `${hit.explain}\n  The model replied: "${text}"`;
}
