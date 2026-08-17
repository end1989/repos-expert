# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:
**Security → Report a vulnerability** at
<https://github.com/end1989/repos-expert/security/advisories/new>. Do not open a public
issue for anything that could be exploited before it is fixed.

You will get an acknowledgement within a week. Confirmed problems are fixed in a patch
release and noted in [CHANGELOG.md](CHANGELOG.md); you will be credited if you want to be.

## Supported versions

Only the latest release on npm receives fixes. The project is pre-1.0; there are no
maintenance branches.

## What this tool is, so you know what to worry about

`repos-expert` is a **local** command-line tool and a **local MCP server over stdio**.
There is no account and no telemetry. The one network service is opt-in:
`expert mcp --http` serves the same tools over Streamable HTTP, **loopback-only unless
you bind elsewhere, and always behind a bearer token** — there is no unauthenticated
mode, DNS-rebinding protection is on for loopback binds, and each request gets a fresh
server (no sessions). If you expose it beyond the machine, the token is the only lock and
TLS is your tunnel's job. Otherwise it:

- reads two folders — your projects folder (`reposDir`) and its own knowledge folder
  (`knowledgeDir`) — and writes only to the second;
- runs `git` and `gh` as subprocesses during `sync`/`add`, and the bundled `ripgrep`
  during search;
- during `curate`/`refresh` only, launches Claude Code (through the Claude Agent SDK) as
  a read-only agent over one repository at a time. **The code the agent reads is sent to
  whichever model provider Claude Code is signed in to**, or the endpoint you configured
  in `curatorEnv`. That is the only step where anything leaves your machine, and it is
  the step you run deliberately;
- serves the resulting docs plus live search and file reads to an MCP client (Claude
  Desktop, Claude Code, VS Code) that runs on the same machine.

## Invariants the code keeps (and that a report would be about)

These are the properties the design relies on. Breaking any of them is a vulnerability
we want to hear about:

1. **No MCP file operation escapes the named repository.** Repo names are validated
   against `^[A-Za-z0-9._-]+$`; paths are resolved under the repo, then `realpath`-checked
   so a symlink pointing outside is refused as well (`src/mcp/guards.ts`).
2. **Every subprocess is `execFile` with an argument array.** No shell strings, so a
   crafted repo name, file name or URL cannot become a command (`src/git.ts`,
   `src/rg.ts`).
3. **Clone URLs go through a transport allowlist** — `https`, `http`, `ssh`, `git`,
   `file`, and `user@host:path` — because git's `ext::` transport runs a shell command
   and a URL pasted from a chat window must not reach it (`src/repos-list.ts`).
4. **The curator's output is parsed against a fixed filename allowlist**, so a repository
   containing hostile text (for example `===FILE: ../evil.md===`) cannot make the tool
   write outside the knowledge folder (`src/curator/prompts.ts`).
5. **Results are capped** — 100 search matches, 2,000 lines / 200 KB per file read, 5 MB
   file size — so a single tool call cannot flood the model's context.
6. **stdout is the MCP protocol.** Nothing reachable from `expert mcp` writes to stdout
   except the transport; diagnostics go to stderr.
7. **HTTP mode never answers without the token.** Every request to the MCP endpoint is
   checked (constant-time compare) before a server is even constructed; a foreign
   `Host` header on a loopback bind is refused; `/health` is the only unauthenticated
   path and reveals only the name and version (`src/mcp/http.ts`).

## In scope

- Anything that violates an invariant above.
- Argument or path injection through repository names, file paths, `repos.txt` entries,
  config values, or the contents of a repository being studied.
- The MCP server writing anywhere other than `knowledgeDir`, or reading outside
  `reposDir`/`knowledgeDir`.
- A dependency vulnerability that is actually reachable from this tool's code paths.
  (Most Socket/Dependabot alerts on the tree are transitive dependencies of the MCP SDK's
  HTTP transports, which this tool never loads — but if you can show one is reachable,
  that is a report.)

## Out of scope

- **What the model writes.** The knowledge docs are produced by a model reading code; a
  repository can contain text that steers them. That is inherent, it is why the docs are
  labelled as summaries, and it is why the consuming assistant is told to verify against
  code. Docs that are *wrong* are a quality problem; a doc that makes the tool *do*
  something (write outside the knowledge folder, run a command) is in scope — see
  invariant 4.
- The security of the model provider, of Claude Code, or of the MCP client you connect.
- The contents of repositories you choose to point the tool at.
