# Contributing

Thanks for looking. This is a small project with a clear shape; the fastest way to make
a change that lands is to read two files first:

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit and why.
- [CLAUDE.md](CLAUDE.md) — the working rules. It is addressed to an AI pair, but every
  rule in it applies to humans too, and it is short.

## Set up

    git clone https://github.com/end1989/repos-expert.git && cd repos-expert
    npm ci
    npm run build
    npm test

Node 20 or newer. Tests build real git repositories in temp directories and inject fake
agent runners — no network, no model calls, no mocking of git. They run in well under a
minute.

To exercise the CLI from source: `node dist/cli/index.js <command>` (or `npm run dev --
<command>` via tsx). Point it at a scratch folder with `expert.config.json` in the repo
root — that file is gitignored because it names your own folders.

## The rules that matter

- **Test first.** Write the failing test, watch it fail for the right reason, then make
  it pass. Every behaviour change comes with a test in `tests/`.
- **Never write to stdout in anything reachable from `expert mcp`.** stdout is the MCP
  protocol; a stray `console.log` breaks every client. Diagnostics go to stderr.
- **Subprocesses use `execFile` with an argument array.** No shell strings.
- **Repo names, paths and URLs are validated before they touch a path or a command line.**
  See [SECURITY.md](SECURITY.md) for the invariants; a change that weakens one needs a
  very good reason and a discussion first.
- **Failure is per-repo.** One repo failing must not stop the batch; an empty folder
  produces instructions, not an error.
- **Caps stay.** 100 matches, 2,000 lines / 200 KB per read. They exist because output
  lands in someone's context window.
- **Docs are written for the person installing from npm.** README and SETUP use plain
  language, folder-first wording, and say what things cost. Match that register.

## Before you push

    npx tsc --noEmit
    npm test
    npm run build

`tsconfig.json` includes only `src`, so type errors in `tests/` are invisible to `tsc` —
vitest transpiles without type-checking. A fixture missing a new required config field
passes compilation and fails at runtime; run the suite.

CI runs the same on Windows, Linux and macOS across Node 20, 22 and 24, and packs the
tarball to make sure nothing outside the `files` allowlist ships.

## Proposing changes

- **Fixes:** open a pull request against `main` with a test that fails without the fix.
- **Anything larger** — a new command, a new MCP tool, a change to what the curator
  writes — open an issue first and describe the behaviour you want. Curator changes cost
  real money to test (2–4 minutes and roughly a dollar of model time per repo); say what
  you ran and paste the result.
- Commit messages: `type: what changed, in plain words` (`fix:`, `feat:`, `docs:`,
  `ci:`, `chore:`), body explaining *why* when it is not obvious.
- Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice.

## Releasing (maintainers)

    npm version patch        # bumps package.json, commits, tags vX.Y.Z
    git push --follow-tags   # the tag triggers .github/workflows/release.yml

The workflow builds, tests, publishes to npm with provenance via trusted publishing (no
token on anyone's machine), and cuts a GitHub Release whose notes are that version's
CHANGELOG section — so move the `[Unreleased]` entries under a new version heading
*before* running `npm version`.
