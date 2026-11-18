import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gradeCitations,
  gradeCrossRepo,
  gradeOrdersApi,
  gradePrivacy,
  splitQuarantine,
} from '../evals/graders.js';

/**
 * The eval's graders, graded. A grader that passes a wrong answer makes the whole eval a
 * green light that means nothing, so each is checked against a good run and a bad one.
 */

const GOOD_INTERFACES = `# Interfaces

## HTTP routes
| Method | Path | Defined at |
| --- | --- | --- |
| GET | \`/health\` | \`src/server.js:5\` |
| POST | \`/orders\` | \`src/server.js:6\` — a stub: always returns \`{ id: 'ord_1' }\` |
| GET | \`/orders/:id\` | \`src/server.js:7\` — echoes the id back |

## Environment variables
- \`PORT\` (default 4000) — \`src/server.js:3\`

## Documented but not implemented
- \`DELETE /orders/:id\` — claimed in README.md:9, no handler exists
- \`POST /refunds\` — claimed in README.md:10, no handler exists
- JWT auth and rate limiting (README.md:13): \`jsonwebtoken\` and \`express-rate-limit\`
  are declared in package.json:8-9 but never imported.
`;

/** A run that summarised the README instead of reading the code. */
const README_SUMMARY = `# Interfaces

## HTTP routes
- GET /health
- POST /orders — creates an order
- GET /orders/:id — fetches an order
- DELETE /orders/:id — cancels an order
- POST /refunds — issues a refund

All routes are protected by JWT auth (jsonwebtoken) and rate limited (express-rate-limit).
`;

describe('gradeOrdersApi', () => {
  it('passes a run that read the code', () => {
    const grades = gradeOrdersApi({ 'interfaces.md': GOOD_INTERFACES, 'card.md': 'Orders API.' });
    expect(grades.filter((g) => !g.pass).map((g) => `${g.id}: ${g.detail}`)).toEqual([]);
  });

  it('fails a run that summarised the README, on every count', () => {
    const grades = gradeOrdersApi({ 'interfaces.md': README_SUMMARY });
    const failed = grades.filter((g) => !g.pass).map((g) => g.id);
    expect(failed).toEqual(['routes', 'phantoms', 'security-theatre', 'stubs']);
  });

  it('fails a run that dropped the phantom endpoints instead of quarantining them', () => {
    const dropped = GOOD_INTERFACES.split('## Documented but not implemented')[0] ?? '';
    const phantoms = gradeOrdersApi({ 'interfaces.md': dropped }).find((g) => g.id === 'phantoms');
    expect(phantoms?.pass).toBe(false);
  });

  it('wants each route cited to its own line, not just named', () => {
    const uncited = GOOD_INTERFACES.replace('`src/server.js:6`', 'the server');
    const routes = gradeOrdersApi({ 'interfaces.md': uncited }).find((g) => g.id === 'routes');
    expect(routes?.pass).toBe(false);
    expect(routes?.detail).toContain('POST /orders');
  });

  it('accepts one range citation that covers all three route lines', () => {
    const ranged = GOOD_INTERFACES.replace(/`src\/server\.js:[567]`/g, '`src/server.js:5-7`');
    expect(gradeOrdersApi({ 'interfaces.md': ranged }).find((g) => g.id === 'routes')?.pass).toBe(
      true,
    );
  });
});

describe('splitQuarantine', () => {
  it('splits at the "Documented but not implemented" heading, at any level', () => {
    const { implemented, quarantined } = splitQuarantine(
      '# A\nreal\n### Documented but not implemented\nfake',
    );
    expect(implemented).toBe('# A\nreal');
    expect(quarantined).toContain('fake');
  });
});

describe('gradeCrossRepo', () => {
  const GOOD_MAP = `## Connected
**order-worker → orders-api.** order-worker polls \`\${ORDERS_URL}/orders/pending\`
(order-worker/src/worker.js:1, :4 — default http://localhost:4000), and orders-api listens on
PORT || 4000 (orders-api/src/server.js:3, orders-api/src/server.js:9). No import or package
dependency: the link is two matching defaults. /orders/pending is not a route; it matches
\`/orders/:id\` and gets a 200 with \`{ id: "pending" }\`, which the worker discards.`;

  it('passes a map that grades the link Connected with both sides cited, and finds the no-op', () => {
    const grades = gradeCrossRepo(GOOD_MAP.replace(':4 —', 'order-worker/src/worker.js:4 —'));
    expect(grades.map((g) => [g.id, g.pass])).toEqual([
      ['cross-repo-link', true],
      ['silent-no-op', true],
    ]);
  });

  it('fails a map that calls the repos merely similar', () => {
    const grades = gradeCrossRepo('## Merely similar\norder-worker and orders-api both use Node.');
    expect(grades.find((g) => g.id === 'cross-repo-link')?.pass).toBe(false);
  });

  const SIDES = 'order-worker/src/worker.js:1 and orders-api/src/server.js:3';
  const pass = (map: string, id: string) => gradeCrossRepo(map).find((g) => g.id === id)?.pass;

  it('takes Connected only as a grade the map gives, never from prose or "not connected"', () => {
    expect(pass(`## Connected\nThe shared port: ${SIDES}.`, 'cross-repo-link')).toBe(true);
    expect(pass(`| link | **Connected** | ${SIDES} |`, 'cross-repo-link')).toBe(true);
    expect(pass(`## Not connected\nOnly a shared port: ${SIDES}.`, 'cross-repo-link')).toBe(false);
    expect(
      pass(`This map separates what is connected from the rest.\n\n${SIDES}`, 'cross-repo-link'),
    ).toBe(false);
  });

  it('wants the evidence for both sides under the grade, not elsewhere in the map', () => {
    const map = `## Connected\nNothing.\n\n## Merely similar\nThe shared port: ${SIDES}.`;
    expect(pass(map, 'cross-repo-link')).toBe(false);
  });

  it('finds the no-op when the map says /orders/:id answers /orders/pending, however phrased', () => {
    const found = [
      'GET /orders/pending is answered by `/orders/:id`, which returns `{ "id": "pending" }`.',
      'Express treats `pending` as the `:id` of /orders/pending, so the worker gets a 200 — not a 404.',
      'The worker polls /orders/pending; `/orders/:id` matches it and answers HTTP 200.',
    ];
    for (const map of found) expect(pass(map, 'silent-no-op'), map).toBe(true);
  });

  it('fails the no-op when the map says /orders/pending would 404, whatever else it says', () => {
    const missed = [
      'There is no /orders/pending route, so every poll would 404. Routes: /orders/:id.',
      'GET /orders/pending falls through to the default 404 handler; /orders/:id is unrelated.',
      'Calling /orders/pending gets a 404, though `/orders/:id` would return { id: "pending" } for other ids.',
    ];
    for (const map of missed) expect(pass(map, 'silent-no-op'), map).toBe(false);
  });
});

/**
 * The cross-repo maps that four real runs of the curator wrote for the fixture (November
 * 2026, claude-sonnet-5). The grader passed all four. Three say /orders/pending would 404,
 * and SDqCkT grades the link "Claimed but unconfirmed" and the shared port "merely similar":
 * a grader that passes those is a green light that means nothing.
 */
describe('gradeCrossRepo on maps real runs wrote', () => {
  const TRIALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval-trials');
  const grade = (trial: string, id: string) =>
    gradeCrossRepo(fs.readFileSync(path.join(TRIALS, `${trial}-cross-repo-map.md`), 'utf8')).find(
      (g) => g.id === id,
    )?.pass;

  it.each(['0iTIbQ', '241LJq', 'SDqCkT'])(
    'fails the no-op in %s, which says /orders/pending would 404',
    (trial) => {
      expect(grade(trial, 'silent-no-op')).toBe(false);
    },
  );

  it('passes the no-op in u5rzDU, which sees /orders/:id answer it with { id: "pending" }', () => {
    expect(grade('u5rzDU', 'silent-no-op')).toBe(true);
  });

  it('fails the link in SDqCkT, which never grades it Connected', () => {
    expect(grade('SDqCkT', 'cross-repo-link')).toBe(false);
  });

  it.each(['0iTIbQ', '241LJq', 'u5rzDU'])(
    'passes the link in %s, which grades it Connected with both sides cited',
    (trial) => {
      expect(grade(trial, 'cross-repo-link')).toBe(true);
    },
  );
});

describe('gradeCitations and gradePrivacy', () => {
  it('passes only when there are citations and all of them resolve', () => {
    expect(gradeCitations([{ checked: 5, broken: [] }]).pass).toBe(true);
    expect(gradeCitations([{ checked: 0, broken: [] }]).pass).toBe(false);
    expect(
      gradeCitations([
        { checked: 5, broken: [{ doc: 'map.md', citation: 'x.js:9', reason: 'no such file' }] },
      ]).pass,
    ).toBe(false);
  });

  it('fails on an email address anywhere in the docs', () => {
    expect(gradePrivacy('written by the sole author').pass).toBe(true);
    expect(gradePrivacy('commits by fixture@example.invalid').pass).toBe(false);
  });
});
