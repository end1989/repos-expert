# repos-expert

Point it at a folder of code repositories. It studies each one, writes down what it
learned, and serves that to your AI assistant over MCP — so you can ask questions about
any project, including how they connect to each other.

    npm install -g repos-expert
    expert init

`expert init` asks where your projects are, writes your settings, and registers the tool
with Claude Desktop. There is nothing to keep running — the client starts the server
itself.

Getting projects into that folder, whichever suits you:

    expert add https://github.com/acme/billing-api.git    # clones it and remembers it
    # or copy/clone folders in yourself — anything with a .git is picked up

`expert add` appends to `repos.txt` in your projects folder. That file is the list: one
git URL per line, editable in Notepad, and `expert sync` clones whatever is missing.
Then `expert refresh <name>` studies a project, and Claude Desktop can answer about it.

[SETUP.md](SETUP.md) is the full walkthrough, including troubleshooting.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works internally, for anyone changing the code.

## How it works

`expert curate` sends a read-only Claude agent into each repository to write four
markdown docs: what it does, how it's built, where everything lives, and what was
recently worked on. A final pass maps the relationships between them. `expert mcp` then
serves those docs *plus* live ripgrep search and file reads over the real code, so exact
questions are answered from the source rather than the summary. Every doc is stamped
with the commit it was written at, and anything stale is flagged in the answer.

`expert sync` clones whatever `repos.txt` lists, and can additionally mirror an entire
GitHub account if you set `githubUser`. Both are conveniences — the folder is the source
of truth, and copying or cloning projects in yourself works identically. Listed projects
are updated with a fast-forward pull, so a repo you also work in never loses commits.

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

    git clone <this repo> && cd repos-expert
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
(default 4, max 16), overridable per run with `curate --concurrency <n>`. Raise it to
finish a large backlog sooner; drop it to `1` if the API rate-limits you.

`refresh` with no arguments never curates repos that have no docs yet — with a large
account that could be hours of model time. Add repos to the knowledge base explicitly:
`refresh <name>`. Only one refresh can run at a time (lockfile in `knowledge/`; the
error message tells you where if a crashed run leaves it behind). The lock only guards refresh against refresh — don't run `refresh` while a `curate --all`/`--stale` batch is active.

## Connect your AI tools

`expert init` does the Claude Desktop case for you. The rest are the same server, so the
config is nearly identical everywhere. Installed from npm the command is `npx`; from a
clone it is `node <project>/dist/cli/index.js`.

**Claude Code (CLI):**

    claude mcp add repos-expert -- npx -y repos-expert mcp

**Claude Desktop:** `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), then restart
the app from the tray:

    {
      "mcpServers": {
        "repos-expert": {
          "command": "npx",
          "args": ["-y", "repos-expert", "mcp"]
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
          "args": ["-y", "repos-expert", "mcp"]
        }
      }
    }

Copilot lists the tools in agent mode; check VS Code's MCP docs if the setting names
have moved.

**Microsoft Copilot (M365 / Copilot Studio):** not directly connectable today — it only
consumes remote (HTTP) MCP servers, and this server is a local stdio process. Connecting
it would mean hosting the server behind an HTTP/SSE MCP transport (or a bridge like an
MCP remote proxy). Out of scope for now.

## Moving to another computer

The committed `knowledge/` folder IS the knowledge base — it travels with the repo.
`repos/` mirrors are disposable and regenerate.

1. Push this project to a private GitHub repo (one-time):
   `gh repo create repos-expert --private --source . --push`
2. On the new machine: `gh auth login`, clone the project, then
   `npm install && npm run build && node dist/cli/index.js sync`
3. Register with your AI tools (section above).
4. From then on, `expert refresh` is the only maintenance command.

## Smoke test (spends model tokens)

    expert refresh <some-small-repo>

Inspect `knowledge/repos/<name>/` — the four docs should read like someone actually
explored the code, and `expert status` should show the repo `fresh`. Always do this on
one repo before starting a large batch.
