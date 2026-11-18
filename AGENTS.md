# Working on repos-expert

This tool turns a folder of code repositories into a knowledge base an AI assistant can
answer from. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design; this file is the rules
for changing it — for people and coding agents alike.

## Command canon

    npm ci                 # install exactly what the lockfile says
    npm run check          # typecheck (src + tests) → lint → format check → build → test
    npm test               # builds, then runs the suite (no network, no model calls)
    npm run test:coverage  # the same, with coverage and thresholds
    npm run test:runtime   # the real Claude Code runtime vs a fake API (no tokens, no network)
    npm run format         # apply Prettier
    npm run eval           # SPENDS MODEL TOKENS — the real curator on the fixture, graded

`npm run check` is what CI runs and what must pass before a commit.

## Key invariants

- **TDD.** Write the failing test first, watch it fail for the right reason, then implement.
  Tests build real git repositories in temp directories and inject fake agent runners — no
  network, no model calls, no mocking of git.
- **stdout is the MCP protocol.** Nothing outside `src/cli/` writes to it; the linter
  enforces this, and `tests/mcp-stdio.test.ts` checks the built server end to end.
  Diagnostics go to stderr.
- **The curator can only read, and only its repository.** Its session options live in
  `src/curator/agent.ts` and its path confinement in `src/curator/confine.ts`; both are
  tested, and `npm run test:runtime` checks them against the real runtime. Never widen its
  tools, set a bypass permission mode, or load settings or MCP servers into it.
- **Every subprocess takes an argument array** (`execFile`, or `spawn` where output must
  stream), and a full path from `findOnPath` (`src/which.ts`), never a bare name: on
  Windows a bare name is looked for in the working folder first, and git's working folder
  is a studied repository. No shell strings and no `shell: true`, ever. Repo names are validated against
  `/^[A-Za-z0-9._-]+$/` (`isValidRepoName`) before they reach a path or a command line.
- **`repos.txt` URLs go through a transport allowlist** (https, http, ssh, git, file,
  `user@host:path`). git's `ext::` transport runs a shell command.
- **Caps are load-bearing.** 100 search results; 2,000 lines / 48 KB per file read; 30 s per
  search. They exist because results land in a context window. Tighten freely; relax only
  with a reason that accounts for that.
- **Failure is per-repo.** One repo failing is collected and reported; the batch continues.
  A failed sync does not stop curation. An empty folder produces instructions, not an error.
- **`parseCuratedDocs` accepts only allowlisted filenames**, so `===FILE: ../evil.md===` in a
  studied repo can never be written. There is a test; don't weaken it.

## Forbidden actions

- Running `curate`, `refresh` or `npm run eval` for real without being asked: they spend
  model tokens (roughly 2–4 minutes and ~$1 per repo). `--dry-run` is free.
- Logging to stdout from anything `expert mcp` can reach.
- Shell strings in subprocess calls.
- Publishing, tagging or pushing tags (a `v*` tag publishes to npm).

## Escalate before you

- Change what the curator is allowed to do, or its prompt's evidence rules.
- Change the MCP tool surface (names, parameters, result shape) — clients depend on it.
- Relax a cap, a path guard or the URL allowlist.
- Add a runtime dependency.

## If you change…

- **What the docs contain** — check that `SERVER_INSTRUCTIONS` (`src/mcp/server.ts`) still
  describes it, add the file to `DOC_FILES`, and run the eval once before a batch.
- **A config field** — add it to `ConfigFile` and `ExpertConfig` (`src/config.ts`), and to
  `testConfig` in `tests/helpers.ts`; tests are type-checked, so a missing field fails `tsc`.
- **What ships** — `tests/tarball.test.ts` packs the package for real and fails on anything
  outside its `ALLOWED` list; extend it deliberately.
- **The Agent SDK version** — it is pinned exactly: it bundles the runtime whose path and
  glob handling the hook mirrors. `npm run test:runtime` (CI's runtime job) must pass on it.
- **The curator's behaviour** — `curateConcurrency` above 2–4 has triggered throttling, and
  a throttled repo that hits `curateTimeoutMinutes` is reported, not retried.

## Publishing

Move the `[Unreleased]` CHANGELOG entries under a new version heading, then
`npm version <patch|minor> && git push --follow-tags`. The tag triggers
`.github/workflows/release.yml`, which runs `npm run check`, publishes to npm **with
provenance via trusted publishing** (no token anywhere), and cuts a GitHub Release from that
CHANGELOG section with an SBOM attached. Published versions cannot practically be
unpublished; `npm deprecate` is the tool.
