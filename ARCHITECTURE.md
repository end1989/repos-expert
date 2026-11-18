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
   only, confined to that repo. The agent returns the documents as text; the CLI checks
   their citations, writes the files, and stamps them with the commit and the run's cost.
3. **Connect** — a portfolio pass reads every `card.md` plus root manifests and writes
   `portfolio.md` and `cross-repo-map.md`.
4. **Serve** — `expert mcp` exposes seven read-only tools and three resources over stdio
   (or Streamable HTTP with `--http`).

## Files

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Config shape, discovery order, and validation (a zod schema at the file boundary). |
| `src/registry.ts` | The repo scan, `meta.json`, staleness (`fresh` / `stale` / `uncurated`), portfolio drift. |
| `src/git.ts` | `git`/`gh` calls. Every argument validated; `execFile` with arrays; no credential prompts. |
| `src/rg.ts` | ripgrep, streamed and stopped at the 100-result cap; globs filter results and only narrow. |
| `src/glob.ts` | The glob dialect shared by the refresh fast path and the search tools, matched without regular expressions so no pattern can backtrack. |
| `src/paths.ts` | Path safety shared by the MCP guard and the curator's hook: containment (`isInside`), link-following resolution, the `.git` and Windows drive-relative checks; and `readTextFile` for files a person may have saved with a byte-order mark. |
| `src/repos-list.ts` | repos.txt parsing, the transport allowlist, and appends. |
| `src/provider.ts` | Which model provider is in force, and the curator's environment. |
| `src/version.ts` | The package version, read from package.json. |
| `src/curator/agent.ts` | The one place the Agent SDK is called: the locked-down session, timeout, run stats. |
| `src/curator/confine.ts` | The PreToolUse hook that keeps Read/Glob/Grep inside the repository and out of `.git`. |
| `src/curator/errors.ts` | Typed curator failures, and which of them are worth a second (paid) attempt. |
| `src/curator/agent-failure.ts` | Turns an agent's one-line complaint ("invalid API key") into the real problem. |
| `src/curator/prompts.ts` | Prompt construction and the `===FILE:` output parser with its filename allowlist. |
| `src/curator/citations.ts` | The post-run check that every cited `file:line` exists. |
| `src/curator/curator.ts` | Studying a repo and the portfolio: context, retry policy, doc writing, meta stamping. |
| `src/mcp/server.ts` | The seven MCP tools and three resources, and the setup-mode stand-in. |
| `src/mcp/guards.ts` | Path-traversal guard and the paged, capped file read. |
| `src/mcp/http.ts` | Streamable HTTP: token, Host and Origin checks, one server per request. |
| `src/cli/index.ts` | Command wiring only: options in, a module call, output and exit code out. |
| `src/cli/refresh.ts` | sync → re-verify or curate what changed → portfolio, under a lock shared with `curate`. |
| `src/cli/curate-many.ts` | The worker pool: N repos at a time, failures collected in input order. |
| `src/cli/reverify.ts` | The trivial-change fast path: docs-only changes re-verified without the model. |
| `src/cli/sync.ts` | Clone listed repos (ff-only pull) and GitHub repos (hard-reset mirror). |
| `src/cli/init.ts` | First-run setup: config, repos.txt, workspace guide, Claude Desktop registration. |
| `src/cli/doctor.ts` | Prerequisite checks; pure functions over injected probes. |
| `src/cli/probes.ts` | The probes `doctor` asks of the machine (is a command installed, is Claude signed in). |
| `src/cli/estimate.ts` | Batch time/cost estimate, confirmation threshold, dry run. |
| `src/cli/help.ts`, `status.ts`, `messages.ts` | Orientation, status and the shared one-line messages. |
| `evals/` | The curator eval: fixture, code-based graders, runner (`npm run eval`). Not shipped. |

## Runtime dependencies

Six, each for one job:

| Package | Why |
| --- | --- |
| `@anthropic-ai/claude-agent-sdk` | Runs the curator agent (Claude Code as a library). Loaded only by commands that study. |
| `@anthropic-ai/sdk` | Not imported here: it satisfies the Agent SDK's peer dependency, which a globally installed CLI has to provide itself. |
| `@modelcontextprotocol/sdk` | The MCP server and its stdio / Streamable HTTP transports (the v1 line, which the Agent SDK also peers on). |
| `@vscode/ripgrep` | A ripgrep binary for every platform, so search needs nothing installed. |
| `commander` | Command-line parsing. |
| `zod` | Validation where data crosses a trust boundary: MCP tool inputs, the config file, `meta.json`, `gh` output. |

## Data on disk

- `repos/` — project folders. Repos pulled from a GitHub account are treated as
  disposable mirrors and **hard-reset** by `sync`; repos you listed in `repos.txt` are
  updated with a fast-forward pull instead, so a working copy never loses commits.
  **Don't point `reposDir` at working copies while also setting `githubUser`.**
- `repos.txt` — the editable list of clone URLs, inside `reposDir` by default so it is
  found by anyone who opens the folder. `reposListFile` moves it.
- `knowledge/` — the actual product. Plain markdown, human-editable, worth committing.
- Config — `EXPERT_CONFIG`, then the working directory, then a per-user location
  (`%APPDATA%\repos-expert\`), then the package root. The per-user location is what makes
  `npx` work, since the package then lives in a cache folder.

## Decisions worth knowing before you change something

**The curator's limits are code, not instructions.** It reads repositories nobody vetted,
so its privileges are fixed in `src/curator/agent.ts`: the built-in tool set is exactly
Read, Glob and Grep (`tools` — `allowedTools` only pre-approves and restricts nothing),
anything else is denied (`permissionMode: 'dontAsk'`), no user/project/local settings are
loaded (`settingSources: []`, so the studied repo's own `.claude/` cannot configure it), no
MCP servers are connected, and a PreToolUse hook (`confine.ts`) refuses any path outside the
repository, following links. Each of these is tested, and the whole was checked against a
live session.

**A retry is a second paid run.** Only failures another attempt could fix are retried —
unparseable output, an unknown error. A timeout, a spent `curateMaxBudgetUsd`, a rejected
credential or a throttled account (the runtime has already backed off) are reported once.

**The agent writes prose, the CLI writes files.** The curator returns text delimited by
`===FILE: name===` markers; `parseCuratedDocs` only accepts names on a fixed allowlist, so
a prompt-injected `===FILE: ../evil.md===` is discarded rather than written.

**Staleness is a SHA comparison, not a timestamp.** `meta.json` records the commit the
docs were written from. Everything else — the `--stale` filter, the warning banners, the
portfolio's own staleness — derives from comparing that to current `HEAD`.

**Failure is per-repo, never per-batch.** One repo failing to curate is collected and
reported; the batch continues. A failed sync doesn't stop curation. An empty folder
produces instructions, not an error.

**A broken setup still starts the MCP server.** `startMcpOrExplain` falls back to a
server exposing the same tool names, each returning the setup instructions. A client that
cannot launch the process shows a red light and a log nobody reads; a server that answers
"run `expert init`" is fixable by the person in the chat window.

**Spending is announced before it happens.** Batches print a time and cost estimate,
ask above ten repos when a human is at the terminal, and `--dry-run` answers "how big is
this?" without starting it — the one question you must not have to answer by experiment.

**The curator passes no credentials.** It spawns Claude Code, which authenticates from
its own environment. That indirection is why the same command runs against a
subscription, an API key, Bedrock/Vertex, or a local model behind a proxy — and why
`src/provider.ts` exists to name which one, since otherwise the choice is invisible and
"what am I spending?" has no answer. `curatorEnv` lives in config rather than the shell
because a scheduled task inherits neither.

**Caps exist because the client has a context window**: 100 search results, 2,000 lines or
48 KB per file read (under the ~50,000 characters clients keep inline). They are not
performance tuning. A capped result always says how to continue — the next `startLine`, or
how to narrow a search — and search results come in path order, so the same query keeps
the same 100.

**A glob may only narrow.** ripgrep's `-g` overrides its ignore rules, so a client's
`glob: "*"` would re-include `.git`, `node_modules` and gitignored files. Client globs are
therefore applied to ripgrep's output (`pathFilter` in `glob.ts`), never passed to it.

**Docs are checked mechanically where they can be.** After a run, every cited `file:line`
is checked against the repository and the result is recorded in `meta.json`. The eval
(`evals/`) goes further, grading a real run against a fixture with known answers. Both are
cheap ways to catch a confident, wrong document before someone acts on it.

**Everything external is started from an argument array** — `execFile`, or `spawn` for
ripgrep, whose output is streamed so a search can stop at its cap. No shell strings and no
`shell: true` anywhere, and repo names are validated against `/^[A-Za-z0-9._-]+$/` before
they reach a path or a command line.

**Nothing writes to stdout in the MCP path.** stdout *is* the protocol; a stray
`console.log` corrupts the stream. Diagnostics go to stderr or nowhere.

## Testing

`npm run check` — type-check (source and tests, strict flags), lint (oxlint, type-aware),
format check, build, then the suite. Tests build real git repositories in temp directories
rather than mocking git, and run with an empty git config so the machine they run on cannot
change what they see. The curator is tested with an injected agent runner and an injected
`query`, so the doc-writing pipeline and the session options are exercised without spending
tokens. The MCP tools are tested through an in-memory client/server pair, and the built CLI
is launched as a real stdio server to check that stdout carries only JSON-RPC. Coverage is
measured with thresholds (`npm run test:coverage`).

`npm run eval` is the one test that spends model tokens: the real curator on the agent-kit
fixture, graded in code, with pass^k over `--trials`. Run it after changing a prompt or the
model, before a batch.

## Extending it

**A new knowledge document:** add it to `DOC_FILES` in `prompts.ts`, describe it in the
templates block, and add it to the `doc` enum in `get_repo_knowledge`. Existing repos need
re-curating to gain it.

**A new MCP tool:** register it in `createServer` with a title, a description on every
parameter, and the read-only annotations; add its name to `TOOL_TITLES` so the setup-mode
server mirrors it. If it takes a repo name, go through `requireRepo` — that is what enforces
the name rule and `excludeRepos`, and produces the staleness banner.

**A different model:** `model` in the config is passed straight through to the Agent SDK.
A different *provider* — local, Bedrock, Vertex, an API key — is `curatorEnv`.
