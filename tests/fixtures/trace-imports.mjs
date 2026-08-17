// Preload for `node --import`: records every ESM specifier the process resolves,
// one URL per line, into the file named by EXPERT_TRACE_OUT. Used by
// tests/mcp-footprint.test.ts to prove what `expert mcp` does and does not load.
import { register } from 'node:module';

register('./trace-imports-hooks.mjs', import.meta.url);
