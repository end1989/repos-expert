# Cross-Repo Relationship Map

## Summary

This folder contains two repositories, `orders-api` and `order-worker`. There is a **plausible but only partially-confirmed** relationship between them, based on networking convention rather than verified, working integration. No shared packages, shared code, or workspace/monorepo tooling exist between them.

## Claimed vs. Verified Connection

**Claimed (in cards/README):** `order-worker`'s card states it polls "an external 'orders' HTTP service," and `orders-api`'s README calls itself a "Production order service," implying `order-worker` is the client of `orders-api`.

**What the code actually shows:**

- `order-worker/src/worker.js:1` sets its target base URL to `process.env.ORDERS_URL || 'http://localhost:4000'`.
- `order-worker/src/worker.js:4` requests `GET ${BASE}/orders/pending`.
- `orders-api/src/server.js:3` defaults its listen port to `process.env.PORT || 4000` — the **same default port** (4000) that `order-worker` targets by default.
- However, `orders-api/src/server.js:5-7` only defines three routes: `GET /health`, `POST /orders`, and `GET /orders/:id`. **There is no `/orders/pending` route** in `orders-api`'s implementation, nor is it mentioned in `orders-api/README.md`'s endpoint list (lines 6-10).

**Conclusion — Connected, but broken/unconfirmed in practice:** The shared default port (4000) is concrete evidence that these two services were designed to talk to each other locally out of the box. But the specific endpoint `order-worker` calls (`/orders/pending`) does not exist anywhere in `orders-api`'s current code or documented API. If both services were run together as-is, every poll from `order-worker` would receive a 404 from `orders-api` (Express's default behavior for an unmatched route). So: port convention = connected by evidence; functional data flow = unconfirmed, and what evidence exists (the route list) suggests it would currently fail.

## Shared Libraries / Code

None. `order-worker/package.json` declares zero dependencies. `orders-api/package.json` declares `express`, `jsonwebtoken`, and `express-rate-limit`, none of which are shared with or imported by `order-worker`. There is no shared internal package, no monorepo/workspaces configuration (no `workspaces` field, no `lerna.json`, no `pnpm-workspace.yaml`), and no shared config or lint/test setup.

## Shared Conventions (Merely Similar, Not Connected)

- Both repos use plain Node.js with no framework-level build step and no TypeScript — `order-worker` has zero dependencies (`order-worker/package.json`), while `orders-api` uses Express (`orders-api/package.json:7`). This is convergent tooling choice (both are Node projects by the same author), not a code or data relationship.
- Both repos follow a `src/<entry>.js` file layout (`order-worker/src/worker.js`, `orders-api/src/server.js`) — a shared authoring convention, not a dependency.
- Both repos are single-commit stubs with no tests/CI — a shared stage of development, not a relationship.

## Claimed-but-Unconfirmed Items Worth Flagging

- `orders-api/README.md:9-10` lists `DELETE /orders/:id` (cancel) and `POST /refunds` as endpoints, and line 13 claims "All routes are protected by JWT auth middleware, and rate limited to 100 req/min." None of this exists in `orders-api/src/server.js` (only `/health`, `POST /orders`, `GET /orders/:id` are implemented; `jsonwebtoken` and `express-rate-limit` are declared as dependencies in `orders-api/package.json:8-9` but never `require`d in the source). This is a documentation/manifest-vs-code mismatch internal to `orders-api`, not a cross-repo issue, but it affects how much weight the "producer" side of the order-worker ↔ orders-api relationship should be given — the service `order-worker` appears designed to consume is itself not fully built.
- No other repo in this folder references, imports, or links to either `orders-api` or `order-worker` by name, URL, or package reference.

## Data Flow Diagram (as designed, not as working)

```
order-worker  --(GET http://localhost:4000/orders/pending, every 30s)-->  orders-api (port 4000 default)
                                                                            ^
                                                                            |  route does not exist — would 404
```
