# GitHub Repos Expert — Design

**Date:** 2026-08-10
**Status:** Approved approach: agent-curated docs knowledge base ("Approach C")
**Stack:** TypeScript / Node 20+, Claude Agent SDK, MCP SDK

## Problem

The user has ~20 GitHub repos and wants a single place where an AI agent can act as an
expert on all of them: what each repo does, how it's built, where things happen, how the
repos relate to each other, and what work is active or unfinished. The expert is consumed
from Claude Code via an MCP server.

## Approach

Claude curates the knowledge base, rather than a parsing pipeline building one. At
curation time, a Claude agent explores each repo checkout and **writes** structured
markdown docs. The MCP server serves those docs plus live code search over the checkouts.

Division of labor:

- **Curated docs** answer conceptual, architectural, cross-repo, and status questions.
- **Live search/read tools** answer precise "where is X right now" questions and remain
  correct even when docs lag behind the code.
- **Claude Code** is the reasoning agent; this project is its memory of the portfolio.

Explicitly rejected alternatives: SQLite index pipeline (tree-sitter + FTS5 + embeddings)
and graph-first knowledge graph. Both remain possible future layers; nothing in this
design blocks them.

## Layout

```
ai_github_repos_expert/
├── expert.config.json      # configuration (see Config)
├── src/
│   ├── cli/                # `expert` CLI: sync, curate, status, mcp
│   ├── curator/            # Agent SDK harness + curation prompt templates
│   └── mcp/                # MCP server (stdio)
├── repos/                  # read-only mirrors of all GitHub repos (gitignored)
└── knowledge/              # the knowledge base (committed to git)
    ├── portfolio.md        # portfolio overview: what exists, how it fits together
    ├── cross-repo-map.md   # dependencies/relationships between repos
    ├── portfolio-meta.json # repo SHAs at portfolio-curation time
    └── repos/<name>/
        ├── card.md         # what it does, stack, status, entry points
        ├── architecture.md # how it's built, key modules, design decisions
        ├── map.md          # annotated directory map — "where things happen"
        ├── activity.md     # recent work, branches, unfinished business
        └── meta.json       # { sha, curatedAt, model, docVersion }
```

`repos/` is owned by sync and treated as disposable read-only mirrors — safe to
hard-reset. `knowledge/` is plain markdown: human-readable, hand-editable, versioned in
this project's git repo.

## Component: `expert sync`

1. Discover repos via `gh repo list --json name,url,defaultBranchRef,isArchived`
   (relies on existing `gh` auth; includes private repos).
2. Skip repos in `excludeRepos`; skip archived repos by default.
3. Clone missing repos into `repos/<name>`; update existing ones with
   `git fetch` + `git reset --hard origin/<defaultBranch>`.
4. Per-repo failures are collected and reported at the end; the batch continues.
   Non-zero exit if any repo failed.

Git and `gh` are invoked via `execFile` (args array, no shell).

## Component: `expert curate [--all | --stale | <repo>]`

For each target repo:

1. Launch a curator agent (Claude Agent SDK, TypeScript) with **read-only** access:
   Read/Glob/Grep plus git inspection (`git log`, `git branch -a`) inside the mirror.
2. The prompt provides the four doc templates (section headings fixed by this spec) and
   instructs the agent to write `card.md`, `architecture.md`, `map.md`, `activity.md`.
   The agent returns doc contents; the CLI writes the files (agent has no write access).
3. **Incremental mode:** if previous docs exist, the prompt includes them plus
   `git log <previousSha>..HEAD --stat` and instructs the agent to update rather than
   rewrite.
4. **Verification:** the CLI checks all four docs exist and are non-empty before writing
   `meta.json` with the mirror's HEAD SHA. No meta ⇒ repo counts as uncurated.
5. Timeout per agent run (default 10 min) and one retry; on final failure the repo stays
   uncurated/stale and the batch continues.

**Portfolio pass** (runs after per-repo curation in `--all`/`--stale` mode, or via
`expert curate --portfolio`): one agent reads every `card.md` plus root manifests
(`package.json`, `pyproject.toml`, etc.) and writes `portfolio.md` and
`cross-repo-map.md`. `portfolio-meta.json` records each repo's curated SHA; the portfolio
is stale if any repo has been re-curated since.

Default model: Sonnet (config `model`). Curation is infrequent and the repo count small,
so quality beats token cost; incremental mode keeps refreshes cheap.

## Component: `expert status`

Prints the registry: each repo, its curated-at SHA vs current HEAD, and a
fresh/stale/uncurated flag. Convenience view of the same staleness computation used by
`curate --stale` and the MCP server.

## Component: MCP server (`expert mcp`, stdio)

Package name `repos-expert`, CLI binary `expert`. Registered once with
`claude mcp add repos-expert -- node C:\dev\repos\ai_github_repos_expert\dist\cli\index.js mcp`. Tools:

| Tool | Input | Output |
| --- | --- | --- |
| `portfolio_overview` | — | portfolio.md + cross-repo-map.md + staleness summary |
| `list_repos` | — | name, one-line summary (from card.md), fresh/stale/uncurated flag per repo |
| `get_repo_knowledge` | `repo`, `doc?` (card\|architecture\|map\|activity; default card) | the doc's markdown |
| `search_knowledge` | `query` | ripgrep matches across `knowledge/` |
| `search_code` | `query`, `repo?`, `glob?` | ripgrep matches across `repos/` (capped, see below) |
| `find_files` | `pattern`, `repo?` | matching paths |
| `read_repo_file` | `repo`, `path`, `startLine?`, `endLine?` | file content (capped) |

Behavior rules:

- **Staleness banner:** every response about a stale repo is prefixed with
  "docs curated at `<shortSha>`, repo now at `<shortSha>` — trust live search over
  summaries." Uncurated repos are flagged as such in `list_repos`.
- **Validation:** `repo` must exist in the registry; `read_repo_file` paths are resolved
  and must remain inside `repos/` (path-traversal guard).
- **Caps:** search results max 100 matches with truncation notice; file reads max 2,000
  lines / 200 KB per call.
- **Search engine:** ripgrep via `@vscode/ripgrep` (bundled binary, Windows-safe),
  invoked with `execFile`.
- Re-curation is **not** exposed as an MCP tool; the server reports staleness and the
  user runs `expert sync && expert curate --stale`.

## Config (`expert.config.json`)

```json
{
  "githubUser": "end1989",
  "reposDir": "./repos",
  "knowledgeDir": "./knowledge",
  "model": "claude-sonnet-5",
  "excludeRepos": [],
  "includeArchived": false
}
```

## Doc templates (fixed section headings)

- **card.md:** Purpose · Tech stack · Status (active/dormant/archived) · Entry points ·
  How to run · Related repos
- **architecture.md:** Overview · Key modules (with paths) · Data flow · External
  dependencies/services · Design decisions & conventions
- **map.md:** Annotated directory tree — for each significant directory/file, one line on
  what happens there
- **activity.md:** Recent focus (from git log) · Open branches and what they contain ·
  Apparent unfinished work / TODOs

## Testing

- **Unit (vitest):** staleness computation, path-traversal guard, config
  parsing/defaults, result caps.
- **Integration:** MCP tools run against fixture `knowledge/` and `repos/` directories
  (tiny fake repos committed as fixtures); asserts tool outputs, staleness banners,
  validation errors.
- **Curator smoke test (manual, hits API):** curate one tiny golden repo end-to-end;
  asserts the four docs exist and meta.json is stamped.

## Out of scope (this iteration)

- Embeddings / semantic vector search
- Symbol-level index or knowledge graph (possible phase 2 on top of this)
- Webhooks or scheduled auto-sync (manual `expert sync` for now)
- Standalone client UI — Claude Code via MCP is the only consumer
