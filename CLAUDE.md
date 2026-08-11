# Working on repos-expert

This tool turns a folder of code repositories into a knowledge base an AI assistant can
answer from. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design; this file is about
changing it safely.

## Ground rules

**TDD.** Write the failing test first, watch it fail for the right reason, then implement.
Tests build real git repositories in temp directories and inject fake agent runners — no
network, no model calls, no mocking of git.

**Never write to stdout in the MCP path.** stdout *is* the protocol. A stray `console.log`
in anything reachable from `expert mcp` corrupts the stream and breaks the client, usually
with a confusing error. Diagnostics go to stderr.

**Every subprocess call uses `execFile` with an argument array.** No shell strings, ever.
Repo names are validated against `/^[A-Za-z0-9._-]+$/` before they reach a path or a
command line — that check is what stops `../` from becoming a file read outside the folder.

**Caps are load-bearing.** 100 search matches, 2,000 lines / 200 KB per file read. They
exist because results land in someone's context window, not for speed. Don't relax them
without a reason that accounts for that.

**Failure is per-repo.** One repo failing to curate is collected and reported; the batch
continues. A failed GitHub sync does not stop curation of what is already on disk. An
empty folder produces instructions, not an error. Preserve this — it is the difference
between a tool that works in a degraded environment and one that doesn't.

## The curator is a model, and models are wrong sometimes

The knowledge docs are written by an agent. Two consequences the code must keep honoring:

- **`parseCuratedDocs` only accepts filenames on a fixed allowlist.** A repo containing
  `===FILE: ../evil.md===` in its source must not be able to write outside the knowledge
  folder. There is a test for this; don't weaken it.
- **The client is told the docs are summaries.** `SERVER_INSTRUCTIONS` tells the consuming
  assistant to verify what matters, that the repositories are open to it, and that when
  documents and code disagree the code wins. If you change what the docs contain, check
  that those instructions still describe reality.

## Costs are real

`curate` spends model tokens — roughly 2–4 minutes and ~$1.20-equivalent per repo. When
testing changes to prompts, run **one** repo and read the output before running a batch.
`curateConcurrency` above 2–4 has triggered throttling; when round-trips slow down, repos
hit `curateTimeoutMinutes` and each failure costs double because of the retry.

## Before committing

    npx tsc --noEmit
    npm test
    npm run build

`tsconfig.json` includes only `src`, so **type errors in `tests/` are invisible to `tsc`** —
vitest transpiles without type-checking. A test fixture missing a new required config field
will pass compilation and fail at runtime.

## Publishing

`npm version patch && npm publish`. `prepublishOnly` rebuilds and runs the suite. The
`files` allowlist in package.json is what keeps `knowledge/`, `repos/`, and a personal
`expert.config.json` out of the tarball — verify with `npm pack --dry-run` after touching
it. Published versions cannot practically be unpublished; `npm deprecate` is the tool.
