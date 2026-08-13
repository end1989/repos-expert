---
description: Redo the portfolio view and the cross-repo map
argument-hint: [--diagram]
allowed-tools: Task, Read, Write, Glob, Grep, Bash(git -C *)
---

Rewrite `_knowledge/portfolio.md` and `_knowledge/cross-repo-map.md` from the current
card set.

**Read every `_knowledge/*/card.md`**, plus the root manifests of each repo
(`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `*.csproj`)
— those carry dependency facts the cards may have missed.

**portfolio.md** — what repos exist, one line each on what they are for, how they group
into themes, and the overall state of the collection.

**cross-repo-map.md** — how the repos actually relate. The cards are summaries written by
an earlier pass, not primary sources. You are sitting in the folder that holds every
repository, with Read, Glob and Grep, so check anything that matters.

A claimed relationship is worth asserting only when you can point at what creates it: an
import, a package dependency, a URL or `host:port` one side serves and the other calls, a
shared file path, a queue or table name in both. Verify before asserting, and cite the file.

Keep three categories explicitly distinct, and never blur them:

- **Connected** — evidenced in code, with the file cited.
- **Merely similar** — same framework or conventions, no data or code flowing between
  them. Say so; convergent tooling is not a relationship.
- **Claimed but unconfirmed** — a card or README implies a link you could not find. Say
  that you looked and what you found instead.

Two more findings are worth their own sections when they apply, because they are common
here and neither is a "relationship":

- **Same codebase, two repo names** — check with `diff -rq <a>/src <b>/src` before
  claiming it, and say whether the trees are identical or merely similar.
- **Referenced but absent** — a repo depending on a sibling path that is not in this
  folder. That is a broken assumption worth surfacing, not an edge to draw.

"No evidence of a connection" is a useful, honest finding. An inferred link stated as fact
is not.

**With `--diagram`**, also write `_knowledge/wiring.mmd` — a Mermaid flowchart of the
connections. The grading must survive into the picture: solid edges for evidenced links,
dashed for claimed-but-unconfirmed, and a distinct style for references to repos that are
absent. Label each edge with its evidence (`package.json:11`, `both bind :3001`). Leave
"merely similar" clusters out of the graph entirely and note them underneath — drawing
them makes the map busier and mean less.

A diagram that renders all three grades as the same arrow is worse than no diagram: it is
more persuasive than prose, and nobody re-reads a diagram skeptically.

No personal identifiers anywhere: no account names, emails, or remote URLs containing them.
