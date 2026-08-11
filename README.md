# repos-expert

An agent-curated expert on all your GitHub repos, served to Claude Code over MCP.

`expert sync` mirrors every repo from your GitHub account into `repos/`.
`expert curate` sends a read-only Claude agent into each mirror to write
markdown knowledge docs (`knowledge/`). `expert mcp` serves those docs plus
live code search as MCP tools. Docs are stamped with the commit they were
written at; anything stale is flagged so the client trusts live search over
summaries.

## Setup

    npm install
    npm run build
    gh auth status        # needs an authenticated GitHub CLI
    # edit expert.config.json (githubUser, model, excludeRepos)

## Use

    node dist/cli/index.js sync             # mirror all repos from GitHub
    node dist/cli/index.js status           # fresh / stale / uncurated per repo
    node dist/cli/index.js refresh          # sync + re-curate stale docs + portfolio (the maintenance one-liner)
    node dist/cli/index.js refresh <name>…  # pull + curate specific repos (adds them if never curated)
    node dist/cli/index.js curate --all     # curate EVERY mirror (slow, uses the model — deliberate act)

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
