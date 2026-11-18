The `cross-repo-map.md` that four real curator runs wrote for `agent-kit/test-fixture`
(`claude-sonnet-5`, November 2026), named by the eval's trial folder. They are kept as
answers the graders must judge correctly (`tests/eval-graders.test.ts`), not as examples of
good output:

- `0iTIbQ`, `241LJq`, `SDqCkT` say `GET /orders/pending` would get a 404. It does not:
  `GET /orders/:id` answers it with a 200 and `{ "id": "pending" }` (EXPECTED.md §6).
  `SDqCkT` also grades the link "Claimed but unconfirmed" rather than Connected (§5).
- `u5rzDU` sees `/orders/:id` answer the poll.
