# Changelog

All notable changes to `repos-expert`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor bumps may change behaviour,
patch bumps are fixes and additive changes). Dates are npm publish dates (UTC).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/end1989/repos-expert/compare/v0.1.11...HEAD
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
