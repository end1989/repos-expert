# `expert refresh` — Design

**Date:** 2026-08-10
**Status:** Approved
**Parent spec:** 2026-08-10-repos-expert-design.md

## Problem

Keeping the knowledge base current takes three commands run in the right order
(`sync`, `curate --stale`, `curate --portfolio`). An agent (or a scheduler, or the user)
needs a single safe entry point: "fetch and pull the repos and update the docs."

## Command

`expert refresh [repo...]`

**No arguments:** sync all mirrors → curate every repo whose state is not `fresh`
(stale + uncurated) → portfolio pass.

**With repo names:** sync only the named repos (remote list filtered to those names;
unknown names are reported as failures) → curate the named repos **unconditionally**
(explicit naming means "update these now", no staleness check; empty/unborn mirrors
still fail their curate step and are reported) → portfolio pass.

Per-repo failures in any stage are collected and reported; the run continues. Exit code
1 if any stage recorded a failure, else 0.

## Lockfile

Refresh holds an exclusive lock for its whole run: `<knowledgeDir>/.refresh.lock`,
created with flag `wx` (content: pid + ISO timestamp), removed in a `finally`. If
creation fails because the file exists, refresh exits immediately with:
`Another refresh appears to be running (started <timestamp from lockfile>). If that is stale, delete <path> and retry.`
The lock is refresh-only; plain `sync`/`curate` invocations do not take it.

## Structure

- `src/cli/refresh.ts` — `runRefresh(cfg, names?, deps?)`. Deps injectable for tests:
  `{ sync, curateOne, curatePortfolio, listStatuses, getStatus }` defaulting to the real
  implementations.
- `src/cli/curate-many.ts` — extracted shared helper
  `curateMany(cfg, statuses, curateOne): Promise<{name, error}[]>` — the sequential
  per-repo loop with failure collection currently inlined in the `curate` CLI action.
  Both the `curate` action and `runRefresh` use it.
- `src/cli/sync.ts` — `syncRepos` gains optional `only?: string[]`: filters the remote
  list to those names; names not present in the remote list land in `result.failed`.
- `src/cli/index.ts` — `refresh` subcommand wiring (prints per-stage summaries; sets
  `process.exitCode = 1` on any failure).

## Testing

Unit tests with fake deps (no API, no network):

- No-args mode curates exactly the non-fresh statuses.
- Named mode curates the named repos regardless of state and passes `only` to sync.
- Unknown name in named mode → reported failure, exit-signal true, run continues.
- Failure in one repo's curate doesn't stop the rest; portfolio still runs.
- Lockfile: second concurrent run errors naming the lock path; lock removed after
  normal completion AND after a thrown stage (finally).
- `syncRepos` `only` filter: unit test with fake remote list.

## Operational note

`repos/` mirrors and the running initial-curation batch execute from `dist/`. Building
(`npm run build`) is deferred until the initial curation batch has finished; tests run
from `src/` via vitest and don't require a build. README gains the refresh one-liner and
the "don't run refresh while another curation batch is active" warning.

## Portability (requirement: easy to use, easy to move machines)

The refresh feature must not introduce machine-specific state, and the README gains a
**"Moving to another computer"** section documenting the full transfer path:

1. Push this project to a private GitHub remote (the committed `knowledge/` IS the
   knowledge base — it travels with the repo; `repos/` mirrors are disposable and
   regenerate).
2. On the new machine: clone → `npm install && npm run build` (`.npmrc` is committed, so
   the install reproduces) → `gh auth login` → `node dist/cli/index.js sync`.
3. Register the MCP server from the project root with a self-locating command:
   `claude mcp add repos-expert -- node "<project>\dist\cli\index.js" mcp` — the README
   shows how to substitute the local path; config lookup already falls back to the
   package root, so the server works regardless of the spawn directory.
4. `node dist/cli/index.js refresh` is the only maintenance command anyone needs
   thereafter.

Everything refresh writes (lockfile included) lives under the config-relative
`knowledgeDir` — no absolute paths, no registry/env state.

## Out of scope

- MCP-exposed re-curation (parent spec's decision stands).
- Scheduling (the command is scheduler-friendly; wiring a schedule is a later choice).
- `--force` re-curation of fresh repos in no-args mode.
