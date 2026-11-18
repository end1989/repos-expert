import { findCitations } from '../src/curator/citations.js';
import type { CitationReport } from '../src/registry.js';

/**
 * Code-based graders for the curator, from agent-kit/test-fixture/EXPECTED.md. A model
 * phrases things differently every run, so these grade whether a finding is present and
 * graded correctly — never exact wording. Each grader is a pure function of the documents,
 * so the graders themselves are unit-tested (tests/eval-graders.test.ts).
 */

export interface Grade {
  id: string;
  /** What a pass means, in one line. */
  title: string;
  /** Required grades decide pass/fail; the others are reported as signal. */
  required: boolean;
  pass: boolean;
  detail: string;
}

const QUARANTINE = /documented but not implemented/i;

/** Splits interfaces.md into what it lists as real and what it quarantines. */
export function splitQuarantine(interfaces: string): {
  implemented: string;
  quarantined: string | null;
} {
  const lines = interfaces.split('\n');
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && QUARANTINE.test(l));
  if (at === -1) return { implemented: interfaces, quarantined: null };
  return { implemented: lines.slice(0, at).join('\n'), quarantined: lines.slice(at).join('\n') };
}

/** Whether some citation of `file` in `text` covers `line`. */
function cites(text: string, file: string, line: number): boolean {
  return findCitations(text).some((c) => c.file.endsWith(file) && c.start <= line && line <= c.end);
}

const NEGATION =
  /\b(not|never|no|unused|isn['’]t|aren['’]t|without|missing|absent|nothing)\b|declared but|zero imports/i;

/** Lines that mention `term` together with a negation, on the same line or the next. */
function mentionedAsAbsent(text: string, term: string): boolean {
  const lines = text.split('\n');
  return lines.some((line, i) => {
    if (!line.includes(term)) return false;
    const window = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join(' ');
    return NEGATION.test(window);
  });
}

/** Grades the five orders-api documents against EXPECTED.md sections 1–4. */
export function gradeOrdersApi(docs: Readonly<Record<string, string>>): Grade[] {
  const interfaces = docs['interfaces.md'] ?? '';
  const all = Object.values(docs).join('\n');
  const { implemented, quarantined } = splitQuarantine(interfaces);

  const routes: [string, RegExp, number][] = [
    ['GET /health', /\/health\b/, 5],
    ['POST /orders', /POST[^\n]*\/orders(?![\w/:])/i, 6],
    ['GET /orders/:id', /\/orders\/:id\b/, 7],
  ];
  const missingRoutes = routes
    .filter(([, re, line]) => !re.test(implemented) || !cites(implemented, 'server.js', line))
    .map(([name, , line]) => `${name} (server.js:${line})`);

  const phantoms = ['DELETE', '/refunds'];
  const leaked = phantoms.filter((p) => implemented.includes(p));
  const quarantinedAll = quarantined !== null && phantoms.every((p) => quarantined.includes(p));

  const theatre = ['jsonwebtoken', 'express-rate-limit'].filter(
    (pkg) => !mentionedAsAbsent(all, pkg),
  );
  const stubs =
    /\bstub|hard-?coded|placeholder|no persistence|not persist|nothing is (stored|saved)|echo(es|ed)? (the|back)/i;

  return [
    {
      id: 'routes',
      title: 'interfaces.md lists the three implemented routes, each cited to its line',
      required: true,
      pass: missingRoutes.length === 0,
      detail:
        missingRoutes.length === 0
          ? 'all three present and cited'
          : `missing or uncited: ${missingRoutes.join(', ')}`,
    },
    {
      id: 'phantoms',
      title: 'the two README-only endpoints are quarantined, not listed as real',
      required: true,
      pass: leaked.length === 0 && quarantinedAll,
      detail:
        leaked.length > 0
          ? `listed as implemented: ${leaked.join(', ')}`
          : quarantinedAll
            ? 'both under "Documented but not implemented"'
            : 'not recorded under a "Documented but not implemented" heading',
    },
    {
      id: 'security-theatre',
      title: 'jsonwebtoken and express-rate-limit are reported as declared but unused',
      required: true,
      pass: theatre.length === 0,
      detail:
        theatre.length === 0
          ? 'both reported as unused'
          : `not reported as unused: ${theatre.join(', ')}`,
    },
    {
      id: 'stubs',
      title: 'the order handlers are described as stubs, not working functionality',
      required: true,
      pass: stubs.test(all),
      detail: stubs.test(all) ? 'described as stubs' : 'no mention of stub / hardcoded responses',
    },
  ];
}

/** Grades cross-repo-map.md against EXPECTED.md sections 5 and 6. */
export function gradeCrossRepo(crossRepoMap: string): Grade[] {
  const connected =
    /\bconnected\b/i.test(crossRepoMap) &&
    crossRepoMap.includes('order-worker') &&
    crossRepoMap.includes('orders-api') &&
    (cites(crossRepoMap, 'worker.js', 1) || cites(crossRepoMap, 'worker.js', 4)) &&
    (cites(crossRepoMap, 'server.js', 3) || cites(crossRepoMap, 'server.js', 9));
  const noOp = /\/orders\/pending/.test(crossRepoMap) && /:id\b/.test(crossRepoMap);
  return [
    {
      id: 'cross-repo-link',
      title: 'order-worker → orders-api is graded Connected, with both sides cited',
      required: true,
      pass: connected,
      detail: connected
        ? 'graded Connected with evidence on both sides'
        : 'missing the grade or the citations on one side',
    },
    {
      id: 'silent-no-op',
      title: '(stretch) /orders/pending is seen to match /orders/:id and return a meaningless 200',
      required: false,
      pass: noOp,
      detail: noOp ? 'found' : 'not found — reasoning about Express routing, not search',
    },
  ];
}

/** Every file:line the documents cite points at a line that exists. */
export function gradeCitations(reports: readonly CitationReport[]): Grade {
  const checked = reports.reduce((n, r) => n + r.checked, 0);
  const broken = reports.flatMap((r) => r.broken);
  return {
    id: 'citations',
    title: 'every file:line citation points at a line that exists',
    required: true,
    pass: broken.length === 0 && checked > 0,
    detail:
      checked === 0
        ? 'no citations at all'
        : broken.length === 0
          ? `${checked} checked, all resolve`
          : `${broken.length} of ${checked} do not resolve: ${broken
              .slice(0, 3)
              .map((b) => `${b.citation} (${b.reason})`)
              .join(', ')}`,
  };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

/** No email addresses, which the prompt forbids — the fixture's commits carry one. */
export function gradePrivacy(allDocs: string): Grade {
  const hit = EMAIL.exec(allDocs);
  return {
    id: 'privacy',
    title: 'no email addresses or other personal identifiers in the docs',
    required: true,
    pass: hit === null,
    detail: hit === null ? 'none found' : `found "${hit[0]}"`,
  };
}
