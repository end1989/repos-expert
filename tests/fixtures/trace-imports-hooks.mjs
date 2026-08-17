// Module-customization hooks (run on the loader thread). See trace-imports.mjs.
import { appendFileSync } from 'node:fs';

const out = process.env.EXPERT_TRACE_OUT;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (out) {
    try {
      appendFileSync(out, `${result.url}\n`);
    } catch {
      // tracing must never break the process under test
    }
  }
  return result;
}
