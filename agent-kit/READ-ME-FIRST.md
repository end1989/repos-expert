# Read me first

This turns a folder of code projects into something you can ask questions about, using
only Claude Code. There is nothing to install and nothing runs in the background — it is
markdown files that tell Claude how to work in that folder.

**Do not copy this file.** It is instructions for you. Everything else in this kit gets
copied.

---

## What you need

- **Claude Code**, installed and signed in. Type `claude` in a terminal; if it starts,
  you're set.
- **git**.
- **A folder with your projects in it.**

No Node, no npm, no API key, no account. If you already use Claude Code, you have
everything.

---

## Step 1 — put your projects in one folder

Each project its own subfolder, each with its own `.git`:

```
C:\Users\you\code\
    billing-api\
    web-frontend\
    worker\
```

Clone or copy them in however you normally would. They don't need to be related to each
other, or on GitHub, or all present at once — you can add more later.

## Step 2 — copy the kit files in

Copy **everything in this kit except this file** into that folder. Afterwards it looks
like:

```
C:\Users\you\code\
    CLAUDE.md              <- copied
    .claude\               <- copied
        agents\curator.md
        commands\study.md
        commands\refresh.md
        commands\map.md
    billing-api\
    web-frontend\
    worker\
```

Only `CLAUDE.md` is required. The `.claude` folder adds the `/study`, `/refresh` and `/map`
shortcuts and a reader that can't write files — worth having, but everything still works
without it.

**If Windows won't let you make a folder named `.claude`:** copy the one from this kit
rather than creating a new one — copying works fine, it's only *typing* the name that
Explorer objects to. Or skip it, start Claude Code in the folder, and ask it to set the
folder up from `CLAUDE.md`; it can create the files itself.

## Step 3 — start it

```
cd C:\Users\you\code
claude
```

## Step 4 — study one project, and read what it wrote

```
/study billing-api
```

Or just say: *"study the billing-api project and write it up."*

A few minutes later, open `_knowledge\billing-api\card.md` and read it. **If it describes
your project accurately, everything works.** Check one before doing thirty — each project
costs a few minutes of model time.

## Step 5 — do the rest, then the map

```
/study web-frontend worker
/map
```

`/map` builds the portfolio view and works out which projects are genuinely connected to
each other.

## Step 6 — from then on, just ask

No commands needed:

- *"What does the billing API expose?"*
- *"Do any of these projects talk to each other?"*
- *"What was I in the middle of in the worker?"*
- *"I want to change the auth flow — what would that break?"*

## Keeping it current

```
/refresh --dry-run     which docs have fallen behind the code (costs nothing)
/refresh               bring them back in line
```

---

## Adding tools later (optional)

`CLAUDE.md` assumes nothing beyond Claude Code's own abilities, and works fully without
anything else. If you later add MCP servers — a code-graph indexer, a security scanner —
Claude will notice and use them where they make an answer more certain. You don't need to
tell it about them, and nothing breaks if you never add any.

## Making it yours

`CLAUDE.md` is meant to be edited — it's read at the start of every session, so what's in
it shapes every answer. Its last section says what's safe to change and what's load-bearing.
Good first additions are things no repository knows: *"the staging database is shared"*,
*"anything under legacy/ is frozen"*.

---

## If something goes wrong

**`/study` isn't offered** — you're in the wrong folder, or you didn't copy `.claude`. The
commands only exist in the folder you copied them into. You can always ask in plain English
instead.

**A login or API key error while studying** — Claude Code isn't signed in on this machine.
Run `claude` on its own, complete the sign-in, try again.

**Answers ignore your projects** — check `CLAUDE.md` is in that folder, and that you started
`claude` from that folder rather than somewhere else.

**Docs describe an old version of the code** — expected, and detected. `/refresh` fixes it;
`/refresh --dry-run` shows what drifted without spending anything.

**Something looks wrong in a document** — say so in the session. Claude will go read the
code and settle it; the code always wins over the document.

---

*repos-expert agent kit v2.0.0 — the version is also at the bottom of `CLAUDE.md`.*
