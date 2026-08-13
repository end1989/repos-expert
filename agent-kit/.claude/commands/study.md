---
description: Study one or more repos and write their knowledge docs
argument-hint: <repo> [repo...]
allowed-tools: Task, Read, Write, Bash(git -C *), Glob
---

Write the knowledge documents for: **$ARGUMENTS**

If no repo was named, list the repos in this folder that have no `_knowledge/<repo>/`
directory, and ask which to study. Do not pick for the user.

For each named repo:

1. Gather git context yourself — the curator cannot run commands:

       git -C <repo> rev-parse HEAD
       git -C <repo> log --oneline -30
       git -C <repo> branch -a

2. If `_knowledge/<repo>/` already exists, read the current docs and the changes since
   their recorded commit:

       git -C <repo> log <meta.sha>..HEAD --stat

   Pass both to the curator and tell it to **update rather than rewrite** — preserve
   still-valid insight, revise what changed.

3. Launch the `curator` subagent for that repo. If `.claude/agents/curator.md` is not
   installed, use any read-only agent (`Explore`) instead, and give it the evidence rule
   and document list from `CLAUDE.md`. Give it the repo's absolute path, the git
   context above, and the previous docs if any. **Launch all named repos concurrently** —
   one Task call per repo in a single message — so a long batch runs in parallel and each
   gets its own context.

4. When a curator returns, split its output on the `===FILE: name===` markers and write
   each document to `_knowledge/<repo>/<name>`. **Accept only these five filenames:**
   `card.md`, `architecture.md`, `map.md`, `activity.md`, `interfaces.md`. Anything else —
   a path with `..`, a different name, an absolute path — is discarded, and you tell the
   user it was. That check is what keeps a repository's contents from writing outside
   `_knowledge/`.

   **Never write `notes.md`.** It is hand-written by the user and survives every study run.
   If it exists, read it first and treat it as authoritative where it conflicts with what
   the curator returned — a person wrote it on purpose.

5. Write `_knowledge/<repo>/meta.json`:

       { "sha": "<the HEAD you read in step 1>", "curatedAt": "<ISO date>", "docVersion": 1 }

   Use the SHA from step 1, not a fresh one — it must record the commit the documents were
   actually written from.

6. If a curator fails or returns something that isn't five documents, report that repo as
   failed, quote what it did return, and continue with the others. One failure never stops
   the batch.

Finish by reporting: which repos were written, which failed and why, and — if any docs
were newly written — remind the user that `/map` will refresh the portfolio view to
include them.
