# Test fixture

A regression test for the kit's prompts. Two small repos with known traps, and
`EXPECTED.md` listing what a correct run must find.

Run this after editing `CLAUDE.md` or `curator.md`. Prompt changes are easy to make and
hard to evaluate — this turns "seems fine" into a pass or fail against fixed line numbers.

    ./build.sh /tmp/kit-test
    cd /tmp/kit-test
    claude

Then `/study orders-api`, `/study order-worker`, `/map`, and grade against `EXPECTED.md`.

## What the fixture contains

**`orders-api`** — a README describing a service that was never built. It advertises five
endpoints; three exist. It claims JWT auth and rate limiting; both packages are declared in
`package.json` and never imported. The two order handlers are stubs with no persistence
behind them.

**`order-worker`** — nine lines that fetch `GET /orders/pending` from `localhost:4000`
every thirty seconds and discard the result. `orders-api` listens on 4000 by default, so
the link is real — but `/orders/pending` isn't a registered route. It matches
`/orders/:id`, returns HTTP 200 with a meaningless body, and nothing notices.

## Why these traps

Each one targets a specific rule in `CLAUDE.md`:

| Trap | Rule under test |
| --- | --- |
| 5 documented routes, 3 real | Read the implementation, not the README |
| Auth claimed, never imported | Absence is a real finding |
| Declared-but-unused dependencies | Same, from the manifest side |
| Real link via matching default ports | Connected, cited on both sides |
| `/orders/pending` silently matching `:id` | Reasoning beyond search |
| Nothing installed, nothing runnable | Distinguish inferred from executed |

A run that reports five endpoints has summarised documentation instead of reading code,
which is the exact failure this whole approach exists to prevent. That is the test.

## Cost

Three model runs, a few minutes each. Studying `orders-api` alone covers most of it —
sections 1 through 4 of `EXPECTED.md` — if you want a quick check after a small edit.

## Keeping it honest

`EXPECTED.md` cites exact line numbers. If you edit the fixture sources, update those
citations in the same commit, or the test starts failing for the wrong reason.
