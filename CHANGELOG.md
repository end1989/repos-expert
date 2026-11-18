# Changelog

All notable changes to `repos-expert`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor bumps may change behaviour,
patch bumps are fixes and additive changes). Dates are npm publish dates (UTC).

## [Unreleased]

### Security

- **The curator is now read-only in fact, and confined to the repository it studies.** It
  passed `allowedTools: ['Read', 'Glob', 'Grep']` with `permissionMode: 'bypassPermissions'`,
  which pre-approves those three but restricts nothing: the session also had Bash, Write,
  Edit, WebFetch and every MCP server configured on the machine, and it loaded the studied
  repository's own `.claude/` settings — while reading content that may be written to steer
  it. The session now has exactly Read, Glob and Grep, denies anything not pre-approved
  (`dontAsk`), loads no user, project or local settings (managed settings still apply) and
  no MCP servers, and a PreToolUse hook refuses reads outside the repository, through links
  too. The hook judges each path as the runtime will use it (trimmed; on Windows, a Git
  Bash path such as `/c/…` read as `C:\…`), refuses a `~` path, which the runtime would
  expand to the home folder, refuses a network path before resolving it, refuses a Grep
  glob such as `*` that would bring `.git` back into a search, and in the portfolio pass
  refuses repos the config excludes. Each refusal is unit-tested (`tests/confine.test.ts`).
- **`expert mcp --http`: a malformed request no longer crashes the server.** A request for
  `//` raised an unhandled rejection before the token check — an unauthenticated crash
  under Node's defaults. It is now a 400. Binding to `--host ::1` crashed on every request;
  it works.
- **HTTP mode checks Origin**, and its MCP endpoint takes **POST only** (405 otherwise;
  `GET /health` is unchanged), because a GET held an SSE stream open that a stateless
  server can never use. It does its own Host check in place of the SDK's deprecated
  DNS-rebinding options.
- **MCP tools never serve `.git` internals, and a glob can only narrow a search.** ripgrep's
  `-g` overrides its ignore rules, so `glob: "*"` reached `.git`, `node_modules` and
  gitignored files such as `.env`. Globs are now applied to the results. ripgrep also
  searches a hidden folder that an ignore file whitelists, so a studied repository could
  bring its own `.git` into a search; an override glob now keeps `.git` out whatever the
  repository's ignore files say.
- **`read_repo_file` no longer serves `.git`.** It checked only that a path stayed inside
  the repository, so it served `.git/config` — where a remote URL can carry a token — and
  the rest of `.git`. A path is now judged as written and again where it lands, so neither
  a link to `.git` nor another spelling reaches it (short names such as `GIT~1` expanded,
  `GIT~1.` read as Windows reads it, and a stream such as `.git::$INDEX_ALLOCATION`
  refused). The curator's hook refuses `.git` the same way, and refuses Windows
  drive-relative paths (`C:secret`), which resolve against a folder nobody chose.
  `read_repo_file` refuses a path over 4,096 characters before resolving it.
- **A file cannot change between being checked and being used.** `read_repo_file` checks a
  file and reads it through one open handle, so the file that passed the checks is the one
  returned. `expert init` creates its files, and its Claude Desktop backup, in one
  exclusive step, so a file written meanwhile is kept rather than replaced.
- **A file name cannot pose as a path.** Linux and macOS allow a newline in a file name, and
  search output split there passed the rest of the name off as a file of its own, which
  could name a file in another repo. Such files are now skipped, so a name can neither pose
  as a path nor slip past an exclusion.
- **A client glob cannot stall the server.** Now that globs are applied to the results, the
  server matches them itself, on its only thread, so the matcher cannot backtrack: it uses
  no regular expressions, and its cost is bounded by the lengths of the path and the glob.
  `{a,b}` groups are expanded one at a time and a glob that would make more than 64
  alternatives is refused at once, as are nested groups, which ripgrep accepts but this
  matcher does not expand; the cache of compiled globs is bounded. Queries are capped at
  4,096 characters and globs at 256.
- **`excludeRepos` applies to every tool and resource.** It used to hide a repo only from
  the listings, while `get_repo_knowledge`, `read_repo_file` and the searches still served
  it. Names now match without regard to case: on Windows and macOS `Beta` and `beta` are
  one folder.
- git no longer stops at a terminal or Git Credential Manager prompt for HTTPS credentials
  during `sync`, where a scheduled run would hang, and network operations time out after 30
  minutes; an SSH key passphrase can still prompt. `cloneRepo` itself refuses a URL that
  starts with `-`, as `repos.txt` parsing already did.
- Dependencies updated: `npm audit --omit=dev` reports nothing (it reported nine, one
  critical). The MCP SDK floor is 1.32.2; 1.30.0 has a published advisory.

### Fixed

- `expert refresh` on a folder of copied-in repos — the workflow the docs lead with —
  printed FAILED and exited 1, because "nothing to sync" was reported as a failed sync. It
  is now a note; `expert sync` prints the same guidance and exits 0.
- `refresh` with nothing studied yet reported the portfolio pass as failed ("No curated
  repos yet") and exited 1; it now skips the pass. It also no longer pays for a portfolio
  pass when the portfolio already reflects every studied repo's current docs and the run
  rewrote none. Docs rewritten at an unchanged commit (`refresh <name>` on a fresh repo, or
  `curate <name>`) still reach the portfolio, in that run or a later one: the check compares
  when the docs were written, not only their commit. `refresh a a` (or `a A` on Windows)
  studies the repo once, not twice at the same time.
- The refresh fast path could re-verify a repo whose code had moved under an ignored
  folder: rename detection reported only `docs/app.ts`, not the `src/app.ts` that left.
  Diffs now use `--no-renames -z`. The default ignore list no longer matches source files
  by prefix (`SECURITY*` matched `SECURITY_scanner.py`).
- A repo whose recorded commit is no longer in the clone (history rewritten, or the repo
  cloned afresh) could never be studied again.
- A clone that failed partway left a folder the next sync reported as synced; it is
  removed. A failing `gh` no longer stops the repos in `repos.txt` from being cloned.
- The curator prompt said "exactly the four documents" in one place while the parser
  requires five, so a model that obeyed it failed the parse and was paid to run again.
- Only a failure that another attempt could fix is retried. Every failure used to be tried
  a second time: after a timeout, that meant a second full-length, paid run. A timeout, a
  rejected credential, an account out of credit, a rate limit, a network failure and a
  stop at the new `curateMaxBudgetUsd` cap are now reported once.
- Code search failed on broad queries: ripgrep's output was buffered (10 MB) before the
  100-result cap applied. It now streams and stops at the cap, in path order, so the same
  query keeps the same results.
- An explicit `--config` / `EXPERT_CONFIG` naming a missing file is an error; it used to fall
  back silently to another collection's config.
- `expert init` keeps the first backup of the Claude Desktop config instead of overwriting
  it with its own output, and, given a config it cannot parse, stops before copying it over
  the backup.
- Folders that cannot be served (no commits yet, not a repository) are listed by
  `expert status` with the reason instead of vanishing. A plain folder inside a repos
  folder that is itself a git repository is no longer taken for a repo.
- A `.refresh.lock` left by a crash blocked every later refresh until someone deleted it.
  It is now taken over once its process is gone, or, if the run was killed before it wrote
  the lock, once the empty file is ten seconds old. Taking over is itself exclusive — only
  the run that creates a takeover marker may clear the lock — so two runs cannot both take
  it. A run removes the lock only while it is still its own, and Windows' transient EPERM
  is retried rather than thrown. `curate` takes the same lock as `refresh`, and chooses
  what to study only once it holds it.
- Searching every repo at once matched a glob against `repo/path`, so `src/**` found
  nothing; it now matches each repo's own paths, as it does for one repo.
- A search that reached a file ripgrep could not read (permissions, a lock) failed as a
  whole and lost its matches. It now keeps them and says some files were not searched.
- Globs anchor the way gitignore does: a leading `/` (or `./`) roots a pattern, and `x/`
  names a folder `x` at any depth. `refreshIgnore` patterns written that way used to match
  nothing. A `refreshIgnore` pattern matches files, so a whole root folder is `/docs/`.
- A config or Claude Desktop config saved with a byte-order mark — as Notepad and Windows
  PowerShell 5 can write it — was rejected as invalid JSON (`expert init` refused to touch
  the Claude Desktop config). Both are read now, as is a config saved as UTF-16 (Windows
  PowerShell 5.1's `>`). A path written with single backslashes, `"C:\repos"`, is refused
  with the fix — JSON reads it as `C:`, a carriage return and `epos`. A folder given as
  `--config` is called a folder; it failed with a bare `EISDIR`, and `expert init`
  registered it in Claude Desktop.
- `expert init`: a profile label that slugs to nothing (non-Latin letters, a drive root) no
  longer takes the default Claude Desktop entry, and a label registered for another
  collection is refused rather than replaced; two configs kept in one folder get their own
  knowledge bases; `--force` changes only what was asked and backs the config up, where it
  used to reset every setting; a folder answer is unquoted, `~`-expanded and made absolute;
  a re-run keeps fields added to the Claude Desktop entry (an `env`); an existing config's
  folders are read as every command reads them; and paths compare without case on Windows.
- `scripts/setup.ps1` did not parse in Windows PowerShell 5.1, the `powershell.exe` every
  Windows machine has: it reads a script with no byte-order mark as Windows-1252, where the
  last byte of a UTF-8 dash is a curly quote that ends a string. It is ASCII now, stops
  when an npm step fails (it reported "Built" either way), treats paths literally (a `[`
  in a folder name is not a wildcard), checks for Node 22.12, and leaves the config and
  Claude Desktop to the tool's own `init`. Run end to end under Windows PowerShell 5.1 and
  PowerShell 7: another server's settings, timestamps included, keep their values.
- A `meta.json` that parses but has a missing or mistyped field reads as "not curated"
  instead of breaking MCP tools. Config values of the wrong type are rejected naming the
  key; invalid JSON names the file.
- `read_repo_file`: a range past the end, or one that ends before it starts, is an error
  that says why (it returned empty text); binary files are not dumped into the
  conversation.
- CI on `main` is green again: the vitest 5 bump is reverted to vitest 4 (vitest 5 no
  longer installs `vite`, so `npm test` failed at startup). Dependabot now skips vitest
  major bumps.
- `expert curate <repo> --dry-run` and `expert curate --portfolio --dry-run` now actually
  dry-run. Previously `--dry-run` was only honoured with `--all`/`--stale`; given a repo
  name or `--portfolio`, it was silently ignored and the curator ran — spending model
  usage the flag promised not to. Both forms now answer before the curator or the Agent
  SDK is loaded, and an unknown repo name still fails.
- `expert curate --all --dry-run` and `--stale --dry-run` no longer load the curator or the
  Agent SDK at all; they are now as model-free as the single-repo dry run.
- `expert curate --all` / `--stale` with no repos to study now says "No git repositories
  found in …" (or that the repos folder does not exist) and exits non-zero, instead of
  reporting "Nothing to curate — everything is fresh" and then running the portfolio pass.
- `parseCuratedDocs` now keeps only the expected filenames. A `===FILE: ../evil.md===`
  marker echoed from a studied repository could never be written — the write loops only
  use the fixed filename list — but the parser returned it, so that safety depended on
  every caller. The parser now enforces the allowlist itself, as the docs already said.

### Added

- **Run accounting.** Every repo curation records its cost, tokens, turns, duration and
  session id in that repo's `meta.json` (the portfolio pass in `portfolio-meta.json`);
  batches print each repo's cost, time and turns, and the total cost.
  `curateMaxBudgetUsd` stops a run once its estimated cost passes that many dollars.
- **Citation check.** After each repository is studied, the `path/file.ext:line` citations
  in its docs are checked against it; the number checked and up to 20 that do not resolve
  go into `meta.json`, and the batch output says how many do not resolve.
- **Curator eval** (`npm run eval`): studies the agent-kit fixture with the real curator and
  grades the documents in code against `agent-kit/test-fixture/EXPECTED.md` — implemented
  versus README-only routes, unused security packages, stub handlers, the cross-repo link,
  citations, privacy — reporting pass^k over `--trials`.
- `list_repos` declares an output schema and returns structured content: each repo's state,
  current commit and docs commit as data, alongside the text.
- `expert refresh --dry-run`, and a confirmation before a long refresh (`--yes` skips it).
- `expert status --json` and `expert doctor --json`.
- MCP tools have titles and a description on every parameter. Search queries are documented
  as regular expressions, `literal: true` searches for text as written, and an invalid
  regex says how to fix it.
- Truncated results say how to continue: `read_repo_file` names the next `startLine`, and a
  capped search says how to narrow it. Searches stop after 30 seconds, saying so, and stop
  when the client cancels.

### Changed

- **Node 22.12 or newer.** `commander` 15 already required it, so `engines: >=20` was not
  true; Node 20 is past end of life. CI tests Node 22, 24 and 26.
- `read_repo_file` returns at most 48 KB per call (was 200 KB), under the ~50,000
  characters Claude Code keeps in the conversation; longer files come back in parts.
- `find_files` and `search_code` no longer list or search hidden files (`.github`,
  dotfiles) or gitignored ones, even when the glob names them; `read_repo_file` still opens
  such a file by its path.
- The server instructions state facts (the read tools "have no side effects and always
  show the current code") rather than telling the client it needs no permission.
- **A config with a setting the tool does not know is refused**, naming the nearest real
  one (`"curateMaxBudgetUSD"` → did you mean `"curateMaxBudgetUsd"`?). Such a key used to
  be dropped silently, so a misspelt setting (`excludedRepos` for `excludeRepos`, say)
  simply did not apply. `$schema` and keys starting with `_` stay free for notes.
- `scripts/setup.ps1` registers the clone in Claude Desktop as `repos-expert-dev`, with
  `--config` naming the clone's own config. Earlier versions registered `repos-expert`
  without `--config`, which read whichever config it found first; that entry can go.

### Internal

- Lint (oxlint, type-aware) and formatting (Prettier) run in CI; tests are type-checked,
  with stricter compiler flags; coverage is measured against thresholds; tests no longer
  depend on the machine's git config or on a developer's `EXPERT_CONFIG`, and write only
  inside their own temporary folders. An end-to-end test runs the built `expert mcp` over
  stdio and checks that stdout carries only JSON-RPC and that the server exits when its
  input closes, failing rather than hanging if it does not. A source-hygiene test fails on an invisible byte-order mark inside a source file
  and on non-ASCII text in a PowerShell script. CI also runs the exact Node floor, 22.12.0
  (the suite passes on it). GitHub Actions are pinned to commit SHAs, CodeQL and
  dependency review run on pull requests, and the release job checks its npm version
  instead of installing `npm@latest`, uses no dependency cache, and attaches an SBOM. It
  also refuses a tag that is not on `main` or has no CHANGELOG section, and builds the SBOM
  and release notes before publishing, which cannot be undone.
- `.npmrc`'s `legacy-peer-deps=true` is gone: dependencies resolve without it.

## [0.1.14] — 2026-08-25

### Added
- **Tool annotations on every MCP tool.** All seven tools — and the setup-mode stand-ins
  that mirror them — now declare `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`. Every tool reads: no writes, no side
  effects, nothing outside the repos folder on this machine. Hosts use the hints to
  decide whether to warn before a call, and a missing hint reads as "unknown" rather
  than "safe". Some MCP directories reject servers where any of the four is absent.

## [0.1.13] — 2026-08-17

Findings from a fresh newcomer walk-through of 0.1.12 (clean sandbox, install from npm).

### Fixed
- **`doctor` missed the one case its sign-in probe exists for.** `claude auth status`
  prints `{"loggedIn": false, …}` but exits 1 when signed out; the probe treated any
  non-zero exit as "could not ask" and fell back to the hedged wording. It now reads the
  JSON regardless of the exit code, so a signed-out Claude Code gets `warn … installed
  but not signed in` with `claude auth login` as the fix.
- `expert add` with a bad URL said `line 1: …` — parser wording from `repos.txt` leaking
  into a command-line argument error. Now just the reason.
- Batch estimates say `1 repo`, not `1 repos`.
- Sync failures in `refresh`/`add`/`sync` output printed git's whole transcript
  (`Cloning into…`, `remote: …`, `fatal: …`) per repo; now the decisive line only.
- The curator's signed-out explanation names `claude auth login`.

### Added
- `expert status` shows `(code unchanged through <sha>)` next to a repo that is fresh by
  re-verification, so it is distinguishable from one that was just studied.

## [0.1.12] — 2026-08-17

### Added
- **Several collections.** `--config <path>` is a global option on every command,
  including `mcp`. `expert --config C:/work/expert.config.json init --repos-dir …
  --name Work` writes that config, puts its knowledge base beside it, and registers a
  second Claude Desktop entry `repos-expert-work` that launches the server with
  `--config`; the default profile stays `repos-expert`. `doctor` reports the entry that
  belongs to the active profile and names the others when this one is missing.
- **`expert mcp --http`.** The same server over Streamable HTTP for clients that only
  speak HTTP (Copilot Studio / M365, remote setups through a tunnel). Loopback by
  default (`--host` to change, with a warning), **bearer token always required**
  (`--token`, `EXPERT_HTTP_TOKEN`, or generated and printed once to stderr), stateless,
  DNS-rebinding protection on loopback, unauthenticated `GET /health`. Setup mode works
  over HTTP too. Nothing on stdout in either transport.
- **Trivial-change fast path in `refresh` / `curate --stale`.** When a stale repo's only
  changes since curation match `refreshIgnore` (default: markdown, `docs/`, `.github/`,
  licences, changelogs, git dotfiles, lockfiles; `[]` disables), it is *re-verified*
  instead of re-studied: meta records the code is unchanged through HEAD, status is
  fresh, and the provenance footer says "code confirmed unchanged through <sha>" rather
  than pretending the docs were rewritten. Unknown history counts as changed; named
  repos always curate; `--dry-run` classifies without writing. The output line reports
  how many were re-verified without the model.

### Changed
- `RepoStatus` gains `verifiedThrough`; `meta.json` may carry `verifiedSha`. Older
  metas read as before.

## [0.1.11] — 2026-08-17

### Added
- **Knowledge docs as MCP resources.** `expert://portfolio`, `expert://cross-repo-map`,
  and `expert://repos/{repo}/{doc}` (with completion for `repo` and `doc`), so clients
  that attach context — Claude Desktop's "+" menu, VS Code — can pick a doc without a
  tool call. The resource list stays small on purpose: portfolio, cross-repo map, and
  one `card` per repo; the other four docs are one template away. Same staleness banner
  and provenance footer as `get_repo_knowledge`.
- **`expert doctor` now knows whether Claude Code is signed in.** It asks
  `claude auth status` (no shell, 10 s cap) and reports "Claude Code signed in
  (claude.ai, max)" — or warns "installed but not signed in" with `claude auth login` as
  the fix. It repeats only how you are signed in, never the account. When the probe
  cannot run (older Claude Code, a shim it will not execute) the old hedged wording
  stays. An API key, custom endpoint or cloud provider still outranks it — that is what
  would be billed.
- SETUP.md covers macOS and Linux: install commands, the config / knowledge / Claude
  Desktop paths per platform, the macOS PATH gotcha, and a cron line (with the
  launchd / systemd catch-up note) as the counterpart of `schedule-refresh.ps1`.
  `doctor`'s Node and git fix hints are no longer Windows-only.

### Changed
- `search_code` and `find_files` return `src/server.js:12:` on every OS — no `./` or
  `.\` prefix, forward slashes on Windows — so a model sees one path shape everywhere.
- `expert mcp` no longer loads the curator or the Claude Agent SDK; those are imported
  only when `curate`/`refresh` run. The server process now loads 7 packages instead of
  11, and a test traces the built CLI to keep it that way.

## [0.1.10] — 2026-08-17

### Fixed
- **Claude Desktop could silently keep launching an old version.** `expert init` used to
  register the server as a bare `npx -y repos-expert mcp`; npx runs whichever copy it
  finds first — a global install stays at its installed version until `npm update -g`,
  and nothing said so. `init` now writes the absolute path to your `node` and to the
  installed `repos-expert` (offline, no PATH guesswork, and `npm update -g` is picked up
  on the next launch). When running out of npm's npx cache, where no path is stable, it
  writes `npx -y repos-expert@latest mcp` instead. **Existing setups: run `expert init`
  once** (your settings are left alone; only the client entry is rewritten).

### Added
- `expert doctor` has a `claude desktop` line: which version the client would launch and
  from where, `warn` on a version mismatch or a bare-npx entry, `fail` when the path it
  points at no longer exists — each with `expert init` as the fix.
- `expert init` says what the client will launch and how updates reach it.

### Changed
- README's hand-written client snippets use `repos-expert@latest`, with the reason.

## [0.1.9] — 2026-08-17

### Changed
- Default `curateConcurrency` is now **2** (was 4). `expert init` always wrote 2, and
  above 4 the API tends to throttle — a throttled repo that hits `curateTimeoutMinutes`
  costs double because it is retried. Set it explicitly in `expert.config.json` if you
  want more.

### Added
- This changelog, plus `SECURITY.md`, `CONTRIBUTING.md`, and Dependabot configuration.
- README: a "what it can reach, and what leaves your machine" section, badges, and a
  rewritten backing-up / moving-machines section that matches where the knowledge base
  actually lives.
- CI now builds and tests on Node 20, 22 and 24, on Windows, Linux and macOS, and fails
  if the npm tarball would contain anything outside the `files` allowlist.
- Release workflow: tagged versions are published from GitHub Actions with npm
  provenance.

### Fixed
- README and SETUP said the curator writes four documents; it has written five since
  0.1.2 (`interfaces.md`).
- The tarball guard (`tests/tarball.test.ts`) read `npm pack --json` as an array; npm 12
  prints an object keyed by package name, which made the first run of the release
  workflow fail. It now accepts both shapes.

## [0.1.8] — 2026-08-17

### Added
- `LICENSE` file (MIT) ships in the package. `package.json` had declared MIT since 0.1.0
  without one.
- `repository`, `homepage` and `bugs` metadata. The source is public at
  <https://github.com/end1989/repos-expert>.

## [0.1.7] — 2026-08-17

### Fixed
- `expert sync` matched `--only` names (and so `expert refresh <name>`) case-sensitively;
  `Refresh Foo` and `refresh foo` now find the same repo.
- `expert refresh <name>` could go on to curate a repo that `sync` had deliberately
  skipped (for example an excluded or archived one). Skipped repos are now reported, not
  curated.
- A test asserted a Windows-only absolute path and failed on Linux; the Linux CI lane is
  green for the first time.
- CI: `actions/checkout` and `actions/setup-node` moved to v5, off the deprecated Node 20
  action runtime.

## [0.1.6] — 2026-08-13

### Changed
- Dependencies: `@anthropic-ai/claude-agent-sdk` 0.3.231, `hono` 4.13.2.

### Added (repository only, not in the npm package)
- `agent-kit/`: the same knowledge base with no server at all — a `CLAUDE.md`, a
  read-only `curator` agent and `/study`, `/refresh`, `/map` commands for Claude Code,
  with a fixture that fails loudly if the prompts drift from the tool's.

## [0.1.5] — 2026-08-13

### Fixed
- An unauthenticated curator (no Claude Code sign-in and no `ANTHROPIC_API_KEY`) said the
  wrong thing entirely; it now says what is missing.
- `zod` 4 — a first install is no longer a wall of peer-dependency warnings.

## [0.1.4] — 2026-08-12

### Added
- The MCP server starts in **setup mode** when there is no config yet: every tool
  answers with how to run `expert init`, instead of the client showing a dead server.
- `expert curate --dry-run` and a time/cost estimate before batches over 10 repos
  (`--yes` skips the question).
- `expert doctor`: checks Node, the bundled ripgrep, config, the projects folder, the
  knowledge folder and git, names the single first thing to fix, and reports which model
  **provider** is actually in force (Claude Code sign-in, `ANTHROPIC_API_KEY`, custom
  endpoint, Bedrock/Vertex).
- `curatorEnv` in the config lets a local model or any Anthropic-compatible endpoint do
  the writing (`ANTHROPIC_BASE_URL`), and survives scheduled runs that inherit no shell
  environment.

## [0.1.3] — 2026-08-12

### Added
- `repos.txt` in the projects folder as the list of projects, `expert add <url>` to
  append-and-clone, and bare `expert` / `expert help` that say where your files are and
  what to run next.
- `expert status` names the next command instead of only diagnosing.

## [0.1.2] — 2026-08-12

### Added
- `interfaces.md` — a fifth document per repo: the verified contract surface (routes,
  commands, exports, env vars, data models), each entry citing the file and line that
  defines it, with a section for what is documented but not implemented.
- The MCP server tells the consuming assistant how much to trust the docs (they are
  summaries; the repositories are open to it; when doc and code disagree, the code wins).
- `expert init` writes a short `CLAUDE.md` into the projects folder so agents working
  there find the knowledge base (`--skip-workspace-guide` to opt out).
- `scripts/schedule-refresh.ps1` — a weekly scheduled `expert refresh` (Windows).
- `ARCHITECTURE.md`.

### Fixed
- The CLI reported a hardcoded version.

## [0.1.0] — 2026-08-11

First public release.

- `expert init`, `sync`, `status`, `curate`, `refresh`, `doctor`, `mcp`.
- MCP server (stdio) with seven tools: `portfolio_overview`, `list_repos`,
  `get_repo_knowledge`, `search_knowledge`, `search_code`, `find_files`,
  `read_repo_file` — curated docs plus live ripgrep search and capped file reads over the
  real code, with staleness banners when docs are older than the repo.
- Curator agent (read-only, via the Claude Agent SDK) that writes `card`,
  `architecture`, `map` and `activity` docs per repo and a cross-repo portfolio.
- Path-traversal and symlink guards, argument-array subprocesses, transport allowlist for
  clone URLs, and output caps — designed in from the start.
- Works without GitHub: an empty folder or a failed sync degrades with guidance instead of
  failing.

[Unreleased]: https://github.com/end1989/repos-expert/compare/v0.1.14...HEAD
[0.1.14]: https://github.com/end1989/repos-expert/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/end1989/repos-expert/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/end1989/repos-expert/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/end1989/repos-expert/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/end1989/repos-expert/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/end1989/repos-expert/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/end1989/repos-expert/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/end1989/repos-expert/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/end1989/repos-expert/releases/tag/v0.1.6
[0.1.5]: https://www.npmjs.com/package/repos-expert/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/repos-expert/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/repos-expert/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/repos-expert/v/0.1.2
[0.1.0]: https://www.npmjs.com/package/repos-expert/v/0.1.0
