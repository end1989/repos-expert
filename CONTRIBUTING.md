# Contributing

Thanks for looking. This is a small project with a clear shape; the fastest way to make a
change that lands is to read two files first:

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit and why.
- [AGENTS.md](AGENTS.md) — the working rules: commands, invariants, what needs a discussion
  first. It is written for people and coding agents alike, and it is short.

## Set up

    git clone https://github.com/end1989/repos-expert.git && cd repos-expert
    npm ci
    npm run check

Node 22.12 or newer. Tests build real git repositories in temp directories and inject fake
agent runners — no network, no model calls, no mocking of git — and they do not depend on
your git configuration. The suite runs in well under a minute.

To exercise the CLI from source: `node dist/cli/index.js <command>` (or
`npm run dev -- <command>` via tsx). Point it at a scratch folder with `expert.config.json`
in the repo root — that file is gitignored because it names your own folders.

## Before you push

    npm run check

That is: `tsc` over source and tests, oxlint with type-aware rules, a Prettier check, the
build, and the test suite. CI runs it on Linux, then the suite on Windows, Linux and macOS
across Node 22, 24 and 26, and packs the tarball to make sure nothing outside the `files`
allowlist ships. `npm run format` fixes formatting.

## Proposing changes

- **Fixes:** open a pull request against `main` with a test that fails without the fix.
- **Anything larger** — a new command, a new MCP tool, a change to what the curator writes —
  open an issue first and describe the behaviour you want. Curator changes cost real money to
  test; run `npm run eval` once (it grades the curator against a fixture with known answers)
  and paste the result.
- Commit messages: `type: what changed, in plain words` (`fix:`, `feat:`, `docs:`, `ci:`,
  `chore:`), with a body explaining *why* when it is not obvious.
- Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice.

## Releasing (maintainers)

    npm version patch        # bumps package.json, commits, tags vX.Y.Z
    git push --follow-tags   # the tag triggers .github/workflows/release.yml

The workflow runs the full check, publishes to npm with provenance via trusted publishing
(no token on anyone's machine), and cuts a GitHub Release whose notes are that version's
CHANGELOG section — so move the `[Unreleased]` entries under a new version heading *before*
running `npm version`.

## Conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
