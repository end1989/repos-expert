# Cross-Repo Relationships

## Summary

There are only two repositories to relate: `order-worker` and `orders-api`. The relationship between them is **partial and unconfirmed at the API level**, though there is a genuine, citable convention match on host/port defaults.

## Connected — evidenced in code

**Shared default port (4000), by convention, not by configuration file or shared package:**
- `order-worker/src/worker.js:1` — `const BASE = process.env.ORDERS_URL || 'http://localhost:4000';`
- `orders-api/src/server.js:3` — `const PORT = process.env.PORT || 4000;`

Both repos independently default to port `4000`. There is no shared config file, `.env`, Docker Compose file, or any other artifact that ties these two values together — each is a hardcoded literal in its own source file. This is best described as a **coincidental or intentional convention match**, not a hard dependency: nothing in either repo's code or manifest references the other repo by name, path, or URL. If `orders-api` were run on its default port, `order-worker`'s default `ORDERS_URL` would point at it without extra configuration — but this is an artifact of two identical literals, not a declared link.

## Claimed but unconfirmed — the actual endpoint does not exist

`order-worker`'s only operation is `GET {ORDERS_URL}/orders/pending` (`order-worker/src/worker.js:4`). This implies an expectation that whatever service answers at `ORDERS_URL` exposes a route `GET /orders/pending`.

I checked `orders-api/src/server.js` for this route and did not find it. The only routes `orders-api` implements are:
- `GET /health` (`orders-api/src/server.js:5`)
- `POST /orders` (`orders-api/src/server.js:6`)
- `GET /orders/:id` (`orders-api/src/server.js:7`)

There is no `/orders/pending` route, and `GET /orders/:id` would not correctly serve that request semantically (it would treat `pending` as an `:id` value and return `{ id: "pending" }`, not a list of pending orders). So even though `order-worker` appears purpose-built to poll something very like `orders-api`, and the two repos' port defaults line up, **I looked for the specific endpoint the worker depends on and it does not exist in `orders-api`'s code.** The two repos are a plausible pairing by naming and domain ("orders"), but not a working, verified integration as of the current code.

Additionally, `orders-api`'s own README claims routes (`DELETE /orders/:id`, `POST /refunds`) and security behavior (JWT auth, rate limiting) that are likewise absent from `src/server.js` — so the README cannot be used as evidence of what the service actually does; only the source file can.

## Merely similar — shared tooling, no data/code flow

- Both repos use plain Node.js with no build step and no test framework — a convergent minimalism rather than a shared template or scaffold (there's no shared config, lint rules, or generator referenced by either).
- `orders-api` uses Express; `order-worker` uses the Node global `fetch`. These are unrelated libraries serving unrelated roles (server vs. client) and do not constitute a shared dependency — there is no shared package, no monorepo tooling, and no package in common between the two `package.json` files.

## Not found

- No shared npm package (private or published) between the two repos — `order-worker/package.json` declares zero dependencies; `orders-api/package.json` declares `express`, `jsonwebtoken`, and `express-rate-limit`, none of which appear in `order-worker`.
- No shared repo, queue name, database, or file path referenced by both.
- No README, comment, or manifest in either repo names the other repo.
- No CI/CD config, Docker Compose, or infra-as-code file anywhere in the workspace that wires the two together.

## Conclusion

The only defensible link between `order-worker` and `orders-api` is that they default to the same port number and operate in the same "orders" domain — a weak, convention-level signal, not a proven integration. The specific HTTP call `order-worker` makes (`GET /orders/pending`) has no corresponding route in `orders-api` as currently implemented, so treat any assumption that these two repos form a working pipeline as **unconfirmed**.
