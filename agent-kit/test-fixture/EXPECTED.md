# What a correct run must find

Two repos, five source files, and a README that describes a service nobody built. Every
line number below is a fact about the fixture, verified by hand — if a run cites something
different, either the fixture changed or the run is wrong.

A model will phrase these differently every time. Grade on **whether the finding is
present and correctly graded**, not on wording.

---

## 1. Routes: three implemented, five claimed

`interfaces.md` for `orders-api` must list exactly three HTTP routes:

| Method | Path | Cite |
| --- | --- | --- |
| GET | `/health` | `src/server.js:5` |
| POST | `/orders` | `src/server.js:6` |
| GET | `/orders/:id` | `src/server.js:7` |

**Fails if** `DELETE /orders/:id` or `POST /refunds` appear as real routes. They exist only
in `README.md:9-10`. This is the primary test: a run that lists five routes has summarised
the README and the whole approach has failed.

## 2. The phantom endpoints are quarantined, not dropped

They must appear under **"Documented but not implemented"** (or an equivalent clearly
separated section), attributed to the README.

**Fails if** they are silently omitted. Absence is a finding — deleting the claim loses the
information that a document is lying.

## 3. Security theatre is caught

`README.md:13` claims JWT auth and rate limiting. Both packages are declared and never
imported:

- `jsonwebtoken` — `package.json:8`
- `express-rate-limit` — `package.json:9`
- `src/server.js:1` imports only `express`; no middleware is registered anywhere.

**Fails if** the docs repeat the security claim, or omit it. A declared-but-unused
dependency is exactly the "absence is a real finding" case.

## 4. The handlers are stubs

`POST /orders` returns a hardcoded `{ id: 'ord_1' }` regardless of input; `GET /orders/:id`
echoes the path parameter. No persistence exists anywhere in the repo.

**Fails if** the docs describe order creation or retrieval as working functionality.

## 5. The cross-repo link is found, and graded precisely

`/map` must record `order-worker → orders-api` as **Connected**, citing both sides:

- `order-worker/src/worker.js:1` — `http://localhost:4000` default
- `order-worker/src/worker.js:4` — fetches `${BASE}/orders/pending`
- `orders-api/src/server.js:3` — `PORT || 4000`
- `orders-api/src/server.js:9` — `app.listen(PORT, ...)`

It must also be precise about the *kind* of link: no import, no package dependency, no
shared file, no queue. Coupling exists only through two independently-chosen defaults, and
either side can break it by setting `PORT` or `ORDERS_URL`.

**Fails if** graded as an import or dependency, or if graded "merely similar" — there is
real evidence on both sides.

## 6. The silent no-op (the hard one)

`order-worker` requests `GET /orders/pending`. That route is not registered — but
`app.get('/orders/:id')` at `src/server.js:7` matches any single segment after `/orders/`,
so `pending` binds to `req.params.id` and the handler returns `{ "id": "pending" }` with
**HTTP 200**. The worker parses it (`worker.js:5`) and discards it — `setInterval`
(`worker.js:8`) ignores the return value, and there is no status check or error handling.

Result: a meaningless 200 every 30 seconds, with nothing to alert anyone.

**This one requires reasoning about Express routing, not searching.** A run that misses it
still passes 1–5; a run that finds it is doing the job properly.

## 7. Honesty markers

Somewhere in a good run you should see the model distinguish what it *read* from what it
*ran* or *inferred* — e.g. noting that Express matching behaviour follows from the code
rather than from an executed request (nothing is installed; there is no `node_modules`),
or that "no reference found" came from reading all five files rather than from a search
that returned nothing.

**Fails if** inferences are stated with the same confidence as things read directly.

---

## Also check

- `_knowledge/<repo>/meta.json` `sha` equals `git -C <repo> rev-parse HEAD`.
- Exactly these files written: `card.md`, `architecture.md`, `map.md`, `activity.md`,
  `interfaces.md`, `meta.json`. No others.
- No `notes.md` is created by a study run.
