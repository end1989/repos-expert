# Cross-Repo Relationship Map

## Summary

This portfolio contains two repos, `order-worker` and `orders-api`. They *look* like a client/server pair, but inspecting the code shows the relationship is only partially backed by evidence, and one key piece (the specific endpoint the client calls) does not exist on the server side as implemented.

## What is Connected (evidenced in code)

- **Default host:port convergence.** `order-worker/src/worker.js:1` defaults its target to `http://localhost:4000` (`ORDERS_URL` env var), and `orders-api/src/server.js:3,9` defaults to listening on port `4000` (`process.env.PORT || 4000`). If both are run locally with defaults, `order-worker` would be pointed at the host:port `orders-api` listens on. This is a real, citable coincidence of configuration defaults — not an import or a shared package, but a concrete match of values in both manifests/code.

## Claimed but Unconfirmed

- **The specific endpoint `order-worker` calls does not exist in `orders-api`.** `order-worker/src/worker.js:4` fetches `` `${BASE}/orders/pending` `` — i.e. `GET /orders/pending`. The only routes implemented in `orders-api/src/server.js:5-7` are:
  - `GET /health`
  - `POST /orders`
  - `GET /orders/:id`

  There is no `/orders/pending` route (and no query-parameter-based "pending" filter) anywhere in `orders-api`. So while the two services agree on a default port, the one HTTP call `order-worker` actually makes would 404 against this exact version of `orders-api`. I looked for this route and did not find it — the connection implied by the matching port number is not fully realized by the code on the server side.
- **`orders-api`'s README overstates its own implementation**, which in turn weakens any inferred link. The README (`orders-api/README.md:6-10`) advertises `DELETE /orders/:id` (cancel), `POST /refunds`, JWT auth, and rate limiting. None of these exist in `orders-api/src/server.js`: the file has no `DELETE` or `/refunds` route, and the declared dependencies `jsonwebtoken` and `express-rate-limit` (`orders-api/package.json`) are never `require`d or used in `server.js`. This means even the service `order-worker` might be aimed at is itself a stub well short of its documented behavior.
- **No file in either repo names the other.** `order-worker`'s own documentation/card notes the `/orders/pending` target "implies a companion orders service... No such repo is present here, and no name/URL for it appears anywhere in this repository." `orders-api`'s card likewise states "No [related repos] referenced in any file in this repository." Neither repo's manifest (`package.json`) lists the other as a dependency, and neither contains a URL, package name, or path pointing at the other's repo.

## Merely Similar (convergent tooling, not a relationship)

- Both repos use plain Node.js with npm `package.json` manifests and no framework beyond Express in `orders-api`. This is shared tooling convention, not evidence of data or code flowing between them.
- Both repos follow the same minimal-scaffold shape: a single entry-point file, one git commit, no tests/CI. This is a shared authoring pattern (consistent with a single contributor sketching out both repos in the same style) rather than a functional dependency.

## Net Assessment

There is **no confirmed, working integration** between `order-worker` and `orders-api`. The only concrete evidence of a relationship is the matching default port (`4000`) between `order-worker`'s `ORDERS_URL` default and `orders-api`'s `PORT` default — a configuration coincidence, not a verified data flow, since the specific path `order-worker` polls (`/orders/pending`) is not implemented by `orders-api`. If these two repos are meant to work together, that integration has not yet been built on the `orders-api` side.
