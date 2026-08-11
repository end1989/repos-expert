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

    node dist/cli/index.js sync            # mirror all repos
    node dist/cli/index.js curate --all    # curate everything + portfolio (slow, uses the model)
    node dist/cli/index.js status          # fresh / stale / uncurated per repo
    node dist/cli/index.js curate --stale  # refresh only what changed

## Register with Claude Code

    claude mcp add repos-expert -- node C:\dev\repos\ai_github_repos_expert\dist\cli\index.js mcp

Then ask Claude Code things like "which of my repos handle auth, and how
do they differ?" — it will consult `portfolio_overview`, `get_repo_knowledge`,
and `search_code`.

## Curator smoke test (manual, uses the API)

    node dist/cli/index.js sync
    node dist/cli/index.js curate <small-repo-name>
    node dist/cli/index.js status          # repo should now be "fresh"

Inspect `knowledge/repos/<small-repo-name>/` — card, architecture, map,
activity should read like they were written by someone who actually
explored the code. Then `curate --portfolio` and read `portfolio.md`.

## Maintenance loop

    node dist/cli/index.js sync && node dist/cli/index.js status
    node dist/cli/index.js curate --stale
