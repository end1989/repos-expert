import { describe, it, expect } from 'vitest';
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
