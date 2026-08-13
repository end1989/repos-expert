---
description: Find docs older than their code, and restudy those
argument-hint: [--dry-run]
allowed-tools: Task, Read, Write, Bash(git -C *), Glob
---

Bring the knowledge base back in line with the code.

**1. Survey.** For every directory in this folder containing a `.git`:

    git -C <repo> rev-parse HEAD

Compare against `_knowledge/<repo>/meta.json`'s `sha`. Sort every repo into:

- **fresh** — SHAs match. Nothing to do.
- **stale** — SHAs differ. The code moved since the docs were written.
- **undocumented** — no `_knowledge/<repo>/` at all.

**2. Report before spending anything.** Print the three lists with counts, and for stale
repos show how far behind they are:

    git -C <repo> log --oneline <meta.sha>..HEAD | wc -l

Studying a repo takes a few minutes of model time each. Say how many are involved. If the
user passed `--dry-run`, stop here — that is the whole point of the flag.

**3. Ask before a large batch.** If more than 5 repos would be studied, ask first and wait.
Below that, go ahead.

**4. Restudy the stale ones** using the same procedure as `/study`: gather git context,
launch `curator` subagents concurrently, accept only the five allowed filenames, write
`meta.json` with the SHA you read in step 1.

Pass the previous docs and the `<meta.sha>..HEAD` change log to each curator and tell it to
**update, not rewrite** — the point of a refresh is to revise what moved, not to lose
insight that is still true.

**Do not automatically study undocumented repos.** A folder can gain a repo without anyone
intending a multi-minute study of it. List them and let the user ask for `/study <name>`.

**5. Offer the map.** If anything changed, `cross-repo-map.md` may now be wrong too —
offer `/map`, don't run it unprompted.
