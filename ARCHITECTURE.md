# How it works

The plain-language version is in [SETUP.md](SETUP.md); this is the version for someone
changing the code.

## The idea

Two different things answer questions about code, and they are good at different things:

- **Written summaries** are fast and hold context that isn't in any single file — what a
  project is *for*, how modules relate, which repo talks to which. They go stale.
- **Live search** is always correct but has no memory: it can find `login_handler`, not
  tell you why the project exists.

This tool builds the first with a Claude agent, serves both over MCP, and reconciles them
by stamping every document with the commit it was written from. A stale answer arrives
with a warning rather than silently misleading you.

## The pipeline

```
repos/<name>/          →  curator agent  →  knowledge/repos/<name>/*.md  →  MCP server
(a folder of git repos)   (read-only)       (+ meta.json with the sha)      (+ live ripgrep)
```

1. **Collect** — three interchangeable routes into the folder: copy folders in yourself,
   list git URLs in `repos.txt` (`expert add` / `expert sync`), or mirror a whole GitHub
   account. The folder is the source of truth; every route into it is optional, and each
   one's absence is reported, never fatal.
2. **Study** — `expert curate` runs one Claude agent per repo with `Read`/`Glob`/`Grep`
   only. The agent returns the documents as text; the CLI writes the files. The agent has
   no write access.
3. **Connect** — a portfolio pass reads every `card.md` plus root manifests and writes
   `portfolio.md` and `cross-repo-map.md`.
4. **Serve** — `expert mcp` exposes seven tools over stdio MCP.

## Files

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Config shape, discovery order, validation. `githubUser` is nullable. |
| `src/git.ts` | `git`/`gh` calls. Every argument validated; `execFile` with arrays, never a shell string. |
| `src/registry.ts` | The repo list and the staleness computation (`fresh` / `stale` / `uncurated`). |
| `src/rg.ts` | ripgrep wrapper with the 100-match cap. |
| `src/cli/index.ts` | Command wiring only — no logic. |
| `src/cli/init.ts` | First-run setup: writes config, registers with Claude Desktop. |
| `src/cli/sync.ts` | Clone/update mirrors. |
| `src/cli/curate-many.ts` | The worker pool: N repos at a time, failures collected in input order. |
| `src/cli/refresh.ts` | sync → curate stale → portfolio, under a lockfile. |
| `src/curator/prompts.ts` | Prompt construction and the `===FILE:` output parser. |
| `src/curator/curator.ts` | Agent SDK harness, timeout, retry, doc writing, meta stamping. |
| `src/mcp/server.ts` | The seven MCP tools. |
| `src/mcp/guards.ts` | Path-traversal guard and read caps. |

## Data on disk

- `repos/` — disposable mirrors. Owned by `sync`, which hard-resets them. **Never point
  `reposDir` at working copies you have uncommitted changes in.**
- `knowledge/` — the actual product. Plain markdown, human-editable, worth committing.
- Config — `EXPERT_CONFIG`, then the working directory, then a per-user location
  (`%APPDATA%\repos-expert\`), then the package root. The per-user location is what makes
  `npx` work, since the package then lives in a cache folder.

## Decisions worth knowing before you change something

**The agent writes prose, the CLI writes files.** The curator returns text delimited by
`===FILE: name===` markers; `parseCuratedDocs` only accepts names on a fixed allowlist, so
a prompt-injected `===FILE: ../evil.md===` is discarded rather than written.

**Staleness is a SHA comparison, not a timestamp.** `meta.json` records the commit the
docs were written from. Everything else — the `--stale` filter, the warning banners, the
portfolio's own staleness — derives from comparing that to current `HEAD`.

**Failure is per-repo, never per-batch.** One repo failing to curate is collected and
reported; the batch continues. A failed sync doesn't stop curation. An empty folder
produces instructions, not an error.

**Caps exist because the client has a context window**: 100 search matches, 2,000 lines or
200 KB per file read. They are not performance tuning — removing them will flood the
conversation.

**Everything external goes through `execFile` with an argument array.** No shell strings
anywhere, and repo names are validated against `/^[A-Za-z0-9._-]+$/` before they reach a
path or a command line.

**Nothing writes to stdout in the MCP path.** stdout *is* the protocol; a stray
`console.log` corrupts the stream. Diagnostics go to stderr or nowhere.

## Testing

`npm test` — vitest, no network, no model calls. Tests build real git repositories in temp
directories rather than mocking git, and the curator tests inject a fake agent runner, so
the doc-writing pipeline is exercised without spending tokens. The MCP tools are tested
through an in-memory client/server pair, not by asserting on internals.

## Extending it

**A new knowledge document:** add it to `DOC_FILES` in `prompts.ts`, describe it in the
templates block, and add it to the `doc` enum in `get_repo_knowledge`. Existing repos need
re-curating to gain it.

**A new MCP tool:** register it in `createServer`. If it takes a repo name, go through
`requireRepo` — that is what enforces the name whitelist and produces the staleness banner.

**A different model:** `model` in the config is passed straight through to the Agent SDK.
