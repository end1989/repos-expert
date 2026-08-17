# repos-expert

[![npm version](https://img.shields.io/npm/v/repos-expert)](https://www.npmjs.com/package/repos-expert)
[![CI](https://github.com/end1989/repos-expert/actions/workflows/ci.yml/badge.svg)](https://github.com/end1989/repos-expert/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/repos-expert)](package.json)
[![license: MIT](https://img.shields.io/npm/l/repos-expert)](LICENSE)

Point it at a folder of code repositories. It studies each one, writes down what it
learned, and serves that to your AI assistant over MCP — so you can ask questions about
any project, including how they connect to each other.

    npm install -g repos-expert
    expert init

`expert init` asks where your projects are, writes your settings, and registers the tool
with Claude Desktop. There is nothing to keep running — the client starts the server
itself. It also drops a short `CLAUDE.md` into your projects folder so agents working
there know the knowledge base exists (`--skip-workspace-guide` if you'd rather it didn't).

Getting projects into that folder, whichever suits you:

    expert add https://github.com/acme/billing-api.git    # clones it and remembers it
    # or copy/clone folders in yourself — anything with a .git is picked up

`expert add` appends to `repos.txt` in your projects folder. That file is the list: one
git URL per line, editable in Notepad, and `expert sync` clones whatever is missing.
Then `expert refresh <name>` studies a project, and Claude Desktop can answer about it.

[SETUP.md](SETUP.md) is the full walkthrough, including troubleshooting.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works internally, for anyone changing the code.

## How it works

`expert curate` sends a read-only Claude agent into each repository to write five
markdown docs: what it does (`card`), how it's built (`architecture`), where everything
lives (`map`), what was recently worked on (`activity`), and its verified contract
surface — routes, commands, exports, env vars, data models, each citing the file and
line that defines it (`interfaces`). A final pass maps the relationships between them. `expert mcp` then
serves those docs *plus* live ripgrep search and file reads over the real code, so exact
questions are answered from the source rather than the summary. Every doc is stamped
with the commit it was written at, and anything stale is flagged in the answer.

`expert sync` clones whatever `repos.txt` lists, and can additionally mirror an entire
GitHub account if you set `githubUser`. Both are conveniences — the folder is the source
of truth, and copying or cloning projects in yourself works identically. Listed projects
are updated with a fast-forward pull, so a repo you also work in never loses commits.

## What it can reach, and what leaves your machine

- **It reads two folders:** your projects folder (`reposDir`) and its own knowledge folder.
  Every MCP file operation is confined to a named repo under `reposDir` — repo names are
  validated, paths are resolved and `realpath`-checked, and anything that escapes is
  refused. Symlinks pointing out of a repo are refused too.
- **Results are capped** so a single tool call cannot flood the model's context: 100 search
  matches, 2,000 lines / 200 KB per file read.
- **No telemetry, no phoning home.** The tool itself makes no network calls. The only
  things that leave your machine are `git`/`gh` traffic during `sync`/`add`, and — during
  `curate`/`refresh` only — the code the curator reads, which goes to whichever model
  provider Claude Code is signed in to (or the endpoint you configured). Serving over MCP
  needs no model and no network at all.
- **Subprocesses are always `execFile` with an argument array** — no shell strings, so a
  crafted repo name or URL cannot inject commands. Clone URLs go through a transport
  allowlist (`https`, `http`, `ssh`, `git`, `file`, `user@host:path`).
- **The curator is a model, and models are wrong sometimes.** Its output is parsed against
  a fixed filename allowlist so a repository containing hostile text cannot make it write
  outside the knowledge folder, and the MCP client is told plainly that the docs are
  summaries — when a doc and the code disagree, the code wins.

See [SECURITY.md](SECURITY.md) for how to report a problem.

## What you need

- **Node 20+** — required.
- **A folder of repositories** — required. That is the whole input.
- **An MCP client** to ask questions from: Claude Desktop, Claude Code, or VS Code with
  GitHub Copilot. Any MCP-aware client works; this is a standard stdio MCP server.
- **Claude Code signed in, or `ANTHROPIC_API_KEY`** — only for the doc-writing step.
  Searching, reading, and serving need no model access at all. The writing step can also
  run against a local model or any Anthropic-compatible endpoint: set
  `curatorEnv.ANTHROPIC_BASE_URL` in the config. `expert doctor` reports which provider
  is actually in force, so "am I spending a subscription or per-token?" has an answer.
- **`git` and the GitHub CLI** — optional, only for pulling repos from GitHub. Without
  them the tool says so and carries on with whatever is in the folder.

## Working from a clone

To hack on the tool itself:

    git clone https://github.com/end1989/repos-expert.git && cd repos-expert
    npm ci
    npm run build
    cp expert.config.example.json expert.config.json   # then edit reposDir
    npm test

## Use

    expert                     # where you are and what to run next
    expert init                # first run: write config, connect to Claude Desktop
    expert add <url>…          # add projects to repos.txt and clone them
    expert doctor              # check the setup and say what to fix
    expert status              # what was found, and what has been studied
    expert refresh <name>…     # study specific repos (adds them if never studied)
    expert refresh             # update everything, re-study what changed, then the portfolio
    expert sync                # clone/update everything in repos.txt (and GitHub, if configured)
    expert curate --stale      # study everything not yet studied — slow, uses the model
    expert curate --stale --dry-run   # what that would study, and cost, without doing it
    expert curate --portfolio  # redo just the cross-repo map

`expert add` accepts the GitHub shorthand, so `expert add acme/billing-api` is the same
as pasting the full clone URL.

Batches over 10 repos print a time and cost estimate and ask before starting; `--yes`
skips the question, `--dry-run` answers it without spending anything.

From a clone, substitute `node dist/cli/index.js` for `expert`.

Batches curate several repos at once — `curateConcurrency` in `expert.config.json`
(default 2, max 16), overridable per run with `curate --concurrency <n>`. Raise it to
finish a large backlog sooner; above 4 the API tends to throttle, and a throttled repo
that hits `curateTimeoutMinutes` costs double because it is retried. Drop it to `1` if
you are being rate-limited.

`refresh` with no arguments never curates repos that have no docs yet — with a large
account that could be hours of model time. Add repos to the knowledge base explicitly:
`refresh <name>`. Only one refresh can run at a time (lockfile in `knowledge/`; the
error message tells you where if a crashed run leaves it behind). The lock only guards refresh against refresh — don't run `refresh` while a `curate --all`/`--stale` batch is active.

## Connect your AI tools

`expert init` does the Claude Desktop case for you: it writes the absolute path to your
`node` and to the installed `repos-expert`, so the client launches exactly the copy you
installed, offline, with no PATH guesswork — and `npm update -g repos-expert` is picked
up on the next launch. `expert doctor` reports which version the client would launch and
flags a mismatch, or a path that has moved (re-run `expert init` to re-point it).

Everything else is the same server. If you write a config by hand, use
`npx -y repos-expert@latest mcp` — the `@latest` matters: a bare `npx repos-expert` runs
whichever copy npm finds first and keeps running it, so a global install silently stays at
its installed version. From a clone the command is `node <project>/dist/cli/index.js mcp`.

**Claude Code (CLI):**

    claude mcp add repos-expert -- npx -y repos-expert@latest mcp

**Claude Desktop** (what `expert init` writes, if you would rather do it by hand):
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), then restart
the app from the tray:

    {
      "mcpServers": {
        "repos-expert": {
          "command": "npx",
          "args": ["-y", "repos-expert@latest", "mcp"]
        }
      }
    }

**GitHub Copilot (VS Code, agent mode):** create `.vscode/mcp.json` in any workspace
where you want the tools (or add it to your user configuration):

    {
      "servers": {
        "repos-expert": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "repos-expert@latest", "mcp"]
        }
      }
    }

Copilot lists the tools in agent mode; check VS Code's MCP docs if the setting names
have moved.

**Microsoft Copilot (M365 / Copilot Studio):** not directly connectable today — it only
consumes remote (HTTP) MCP servers, and this server is a local stdio process. Connecting
it would mean hosting the server behind an HTTP/SSE MCP transport (or a bridge like an
MCP remote proxy). Out of scope for now.

## Backing up, and moving to another computer

The knowledge base is one folder: `knowledgeDir` in your config, which `expert init`
puts next to the config file (`%APPDATA%\repos-expert\knowledge` on Windows,
`~/.config/repos-expert/knowledge` elsewhere — bare `expert` prints the exact paths).
It is plain markdown and JSON, a few MB for dozens of repos, and it is the expensive
part: hours of model time. `repos/` mirrors are disposable and regenerate.

Back it up like any folder, or make it a private git repo of its own — that is what the
author does. To move machines: install the tool, `expert init --repos-dir <folder>`,
put the knowledge folder back where the new config points (or set `knowledgeDir` to
wherever you keep it), then `expert sync` and `expert status`. From then on
`expert refresh` is the only maintenance command.

If you keep the list of projects in `repos.txt`, that file travels with the projects
folder; if you set `githubUser`, `sync` re-mirrors the account on its own.

## Smoke test (spends model tokens)

    expert refresh <some-small-repo>

Inspect `<knowledgeDir>/repos/<name>/` — the docs should read like someone actually
explored the code, and `expert status` should show the repo `fresh`. Always do this on
one repo before starting a large batch.

## Project

- [CHANGELOG.md](CHANGELOG.md) — what changed in each version; releases are also on
  [GitHub](https://github.com/end1989/repos-expert/releases).
- [SECURITY.md](SECURITY.md) — what the tool can and cannot reach, and how to report a
  vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how the code is organised and what a change needs
  before it merges. [ARCHITECTURE.md](ARCHITECTURE.md) is the design tour.
- MIT licensed. Windows is the verified platform; macOS and Linux are built and tested in
  CI on every push.
