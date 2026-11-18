# Cross-Repo Relationship Map

Two repositories were available to analyze: `orders-api` and `order-worker`. This document distinguishes what is actually connected in code from what is merely similar in convention, and from what is claimed but not backed by evidence.

## Claimed but unconfirmed: order-worker → orders-api runtime link

`order-worker/src/worker.js` polls a URL built from `ORDERS_URL` (default `http://localhost:4000`) and requests `GET /orders/pending`:

```
const BASE = process.env.ORDERS_URL || 'http://localhost:4000';
...
const res = await fetch(`${BASE}/orders/pending`);
```
(`order-worker/src/worker.js:1,4`)

`orders-api/src/server.js` listens on port `4000` by default (`const PORT = process.env.PORT || 4000;`, `orders-api/src/server.js:3`), which matches `order-worker`'s default base URL.

However, **`orders-api` does not define a `GET /orders/pending` route.** Its full route table is:
```
app.get('/health', ...)
app.post('/orders', ...)
app.get('/orders/:id', ...)
```
(`orders-api/src/server.js:5-7`)

There is no `/orders/pending` path anywhere in `orders-api`. If `order-worker` pointed at `orders-api` as-is, the request would fall through to Express's default 404 handler (no matching route), so `res.json()` in `pollOrders()` would fail to parse a JSON order list.

**Conclusion:** the matching default port (`4000`) and the shared "orders" naming suggest the two repos were *designed* to work together, but the code does not actually support that integration today — the consumer (`order-worker`) calls an endpoint the producer (`orders-api`) never implements. This is a claimed/intended relationship, not a verified one. No import, shared package, shared config file, or committed environment file ties the two repos together either — `ORDERS_URL` is read from the environment at runtime in `order-worker` but is not set, referenced, or documented in `orders-api` (no `.env`, no README cross-reference).

## Merely similar: conventions, not code sharing

- **Same runtime/stack**: both repos are plain Node.js/CommonJS with no framework abstraction shared between them. `order-worker` has zero dependencies (`order-worker/package.json` declares only `name`, `version`, `main` — no `dependencies` field at all). `orders-api` depends on `express`, `jsonwebtoken`, and `express-rate-limit` (`orders-api/package.json`), none of which `order-worker` uses or imports.
- **Same default port number (4000)** appears on both sides (client default base URL in `order-worker/src/worker.js:1`; server listen default in `orders-api/src/server.js:3`). This is circumstantial support for an intended pairing, already covered above — it is not independent evidence of a working connection, since the path requested doesn't exist on the server.
- **No shared package, no shared repo, no monorepo tooling**: there is no `node_modules` workspace link, no npm-published shared library, no lockfile referencing the sibling repo, and no `package.json` field (e.g., `file:../orders-api`) pointing from one repo at the other.

## No evidence found

- No queue, message broker, database table, or shared file path connects the two repos — `orders-api` has no persistence layer at all (no DB client, no ORM, no file writes), and `order-worker` never writes its polled data anywhere, so there is no data store either side could be sharing.
- No CI/CD configuration in either repo references the other (no CI files exist in either repo).
- `orders-api`'s README (`orders-api/README.md`) does not mention `order-worker`, any other repository, or any consumer by name. `order-worker` has no README at all. Neither repo's card or source contains a link, name, or identifier pointing at a sibling project beyond the generic, unverified assumption (stated directly in the `order-worker` card) that some external "orders" service exists at `localhost:4000` — an assumption this review confirms does not currently resolve against `orders-api`'s actual routes.

## Summary table

| Relationship | Status | Evidence |
|---|---|---|
| `order-worker` calls an `orders-api`-hosted endpoint | **Claimed but unconfirmed** | Matching default port (4000) in both; but `orders-api` has no `/orders/pending` route (`orders-api/src/server.js:5-7` vs. `order-worker/src/worker.js:4`) |
| Shared stack/runtime conventions | **Merely similar** | Both plain Node.js; no shared package or import |
| Shared data store, queue, or shared package | **No evidence** | Neither repo has persistence, messaging, or a shared dependency |
