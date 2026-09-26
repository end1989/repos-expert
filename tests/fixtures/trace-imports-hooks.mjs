// Module-customization hooks (run on the loader thread). See trace-imports.mjs.
import { appendFileSync } from 'node:fs';

const out = process.env.EXPERT_TRACE_OUT;
// Optional: a substring that must never be imported. Resolving a match throws, so a test
// can prove a code path stays away from a module (e.g. the Agent SDK) without any risk of
// actually running it if the code under test is wrong.
const block = process.env.EXPERT_TRACE_BLOCK;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (out) {
    try {
      appendFileSync(out, `${result.url}\n`);
    } catch {
      // tracing must never break the process under test
    }
  }
  if (block && result.url.includes(block)) {
    throw new Error(`blocked import (EXPERT_TRACE_BLOCK=${block}): ${result.url}`);
  }
  return result;
}
