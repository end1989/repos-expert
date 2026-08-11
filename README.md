# repos-expert

Point it at a folder of code repositories. It studies each one, writes down what it
learned, and serves that to your AI assistant over MCP — so you can ask questions about
any project, including how they connect to each other.

    npm install -g repos-expert
    expert init

`expert init` writes your settings and registers the tool with Claude Desktop. Restart
Claude Desktop and ask "what projects do I have?" — there is nothing to keep running,
the client starts the server itself.

[SETUP.md](SETUP.md) is the full walkthrough, including troubleshooting.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works internally, for anyone changing the code.

## How it works

`expert curate` sends a read-only Claude agent into each repository to write four
markdown docs: what it does, how it's built, where everything lives, and what was
recently worked on. A final pass maps the relationships between them. `expert mcp` then
serves those docs *plus* live ripgrep search and file reads over the real code, so exact
questions are answered from the source rather than the summary. Every doc is stamped
with the commit it was written at, and anything stale is flagged in the answer.

`expert sync` can mirror repos from a GitHub account, but that is a convenience — the
folder is the source of truth, and copying or cloning projects in yourself works
identically.

## What you need

- **Node 20+** — required.
- **A folder of repositories** — required. That is the whole input.
- **An MCP client** to ask questions from: Claude Desktop, Claude Code, or VS Code with
  GitHub Copilot. Any MCP-aware client works; this is a standard stdio MCP server.
- **Claude Code signed in, or `ANTHROPIC_API_KEY`** — only for the doc-writing step.
  Searching, reading, and serving need no model access at all.
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

    node dist/cli/index.js sync             # mirror all repos from GitHub
    node dist/cli/index.js status           # fresh / stale / uncurated per repo
    node dist/cli/index.js refresh          # sync + re-curate stale docs + portfolio (the maintenance one-liner)
    node dist/cli/index.js refresh <name>…  # pull + curate specific repos (adds them if never curated)
    node dist/cli/index.js curate --all     # curate EVERY mirror (slow, uses the model — deliberate act)
    node dist/cli/index.js curate --stale   # curate only stale/uncurated repos, then the portfolio

Batches curate several repos at once — `curateConcurrency` in `expert.config.json`
(default 4, max 16), overridable per run with `curate --concurrency <n>`. Raise it to
finish a large backlog sooner; drop it to `1` if the API rate-limits you.

`refresh` with no arguments never curates repos that have no docs yet — with a large
account that could be hours of model time. Add repos to the knowledge base explicitly:
`refresh <name>`. Only one refresh can run at a time (lockfile in `knowledge/`; the
error message tells you where if a crashed run leaves it behind). The lock only guards refresh against refresh — don't run `refresh` while a `curate --all`/`--stale` batch is active.

## Connect your AI tools

All clients run the same local command: `node <project>\dist\cli\index.js mcp`
(substitute `<project>` with your clone's absolute path, e.g. `C:\dev\repos\ai_github_repos_expert`).

**Claude Code (CLI):**

    claude mcp add repos-expert -- node <project>\dist\cli\index.js mcp

**Claude Desktop:** add to `claude_desktop_config.json` (Windows:
`%APPDATA%\Claude\claude_desktop_config.json`; macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart the app:

    {
      "mcpServers": {
        "repos-expert": {
          "command": "node",
          "args": ["<project>/dist/cli/index.js", "mcp"]
        }
      }
    }

**GitHub Copilot (VS Code, agent mode):** create `.vscode/mcp.json` in any workspace
where you want the tools (or add to your user configuration):

    {
      "servers": {
        "repos-expert": {
          "type": "stdio",
          "command": "node",
          "args": ["<project>/dist/cli/index.js", "mcp"]
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
4. From then on, `node dist/cli/index.js refresh` is the only maintenance command.

## Curator smoke test (manual, uses the API)

    node dist/cli/index.js refresh git-practice-2

Inspect `knowledge/repos/git-practice-2/` — the four docs should read like someone
actually explored the code, and `status` should show the repo `fresh`.
