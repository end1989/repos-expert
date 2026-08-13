# The agent kit

Turn a folder of code repositories into something you can ask questions about — using
only Claude Code. No server, no npm package, nothing running in the background.

Five text files go into your code folder. After that, opening a terminal there and typing
`claude` gives you an assistant that knows the whole collection: what each project does,
how they're built, what they expose, and which ones are actually wired together.

## What you need

| Thing | Why |
| --- | --- |
| **Claude Code**, installed and signed in | Reads the code and writes the documents |
| **git** | Used to detect when documents fall behind the code |
| **A folder with your projects in it** | One folder, each project a subfolder |

That's the whole list. No Node, no npm, no API key, no config file. If you already use
Claude Code, you have everything.

## Install

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Into "C:\path\to\your\repos"
```

The `-ExecutionPolicy Bypass` is not optional on most machines — Windows blocks unsigned
scripts by default, and without it you get "running scripts is disabled on this system".

**macOS / Linux**

```bash
./install.sh ~/path/to/your/repos
```

Nothing is overwritten. If the folder already has a `CLAUDE.md`, yours is kept and the
kit's copy is written alongside as `CLAUDE.repo-expert.md` for you to merge.

## Use

```
cd /path/to/your/repos
claude
```

Then, inside Claude Code:

```
/study billing-api          study one project, read the result before doing more
/study api web worker       study several at once, in parallel
/map                        build the portfolio view and the cross-repo map
/refresh --dry-run          see which documents have fallen behind the code
/refresh                    bring them back in line
```

**Study one project first and read what it wrote.** `_knowledge/billing-api/card.md` should
read like someone actually explored your code. If it does, do the rest. Each project takes
a few minutes of model time, so checking one before starting forty is worth the pause.

Once documents exist, you don't run commands to use them — just ask. "What does the
billing API expose?", "Which of these projects talk to each other?", "What was I in the
middle of in the worker?"

## What gets created

```
your-repos/
  CLAUDE.md              the instructions that make the assistant an expert on this folder
  .claude/
    agents/curator.md    the read-only agent that studies one repo
    commands/            /study, /refresh, /map
  _knowledge/
    portfolio.md         what exists, grouped by theme
    cross-repo-map.md    which projects are genuinely connected
    <project>/           card, architecture, map, activity, interfaces, meta.json
```

`_knowledge/` is plain markdown. Read it, edit it, commit it, delete it — it's yours, and
nothing depends on a database or an index.

## Why the documents are trustworthy

The rule the whole thing rests on: **documentation is a lead, code is evidence.**

READMEs, design docs, planning notes and old chat transcripts describe what someone
intended. The curator is required to read the implementation before describing it, to say
plainly when the docs and the code disagree, and to treat a missing feature as a real
finding. `interfaces.md` keeps a separate section — *Documented but not implemented* — for
things a README claims that the code does not do.

That is also why the curator can only read. It holds Read, Glob and Grep and cannot write
files; the main session writes them. Repositories often contain instruction files and
saved chat transcripts addressed to AI agents, and the thing reading those should not be
the thing with write access.

## Cost

Studying uses Claude Code, so it draws on whatever plan you already have. Roughly a few
minutes per project. Reading and searching afterwards costs nothing extra — the documents
are just files.

## Troubleshooting

**"running scripts is disabled on this system"** — use the `-ExecutionPolicy Bypass` form
above.

**`/study` isn't offered in Claude Code** — you're not in the right folder. The commands
are project-scoped; `cd` to the folder the kit was installed into and start `claude`
there.

**The assistant doesn't seem to know about the projects** — check `CLAUDE.md` exists in
that folder. If the installer found one already there, your instructions are in
`CLAUDE.repo-expert.md` and were not applied; merge them into your `CLAUDE.md`.

**"Invalid API key" or a login error when studying** — Claude Code isn't signed in on this
machine. Run `claude` on its own and complete the sign-in, then try again.

**Documents describe an older version of the code** — that's expected and detected. Run
`/refresh` to bring them back in line, or `/refresh --dry-run` to see what has drifted
without spending anything.
