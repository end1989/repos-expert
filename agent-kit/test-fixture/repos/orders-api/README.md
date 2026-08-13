# Orders API

Production order service.

## Endpoints
- `GET  /health`        liveness probe
- `POST /orders`        create an order
- `GET  /orders/:id`    fetch one order
- `DELETE /orders/:id`  cancel an order
- `POST /refunds`       issue a refund

## Security
All routes are protected by JWT auth middleware, and rate limited to 100 req/min.
