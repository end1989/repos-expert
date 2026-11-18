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

/** A markdown document's sections: each heading with what follows it, up to the next one. */
function sections(md: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of md.split('\n')) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      out.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  out.push(current.join('\n'));
  return out;
}

const NOT_CONNECTED = /\b(?:not|never|no|nothing)\s+connected\b|n['’]t\s+connected\b/i;

/**
 * Whether a section grades something Connected. A map states its grades in headings, bold
 * labels and table cells; prose that merely uses the word — an introduction promising to
 * separate "what is connected" from the rest — grades nothing, and nor does "Not connected".
 */
function gradesConnected(section: string): boolean {
  const lines = section.split('\n');
  const labels = [
    ...lines.filter((l) => /^#{1,6}\s/.test(l)),
    ...(section.match(/\*\*[^*\n]+\*\*/g) ?? []),
    ...lines
      .filter((l) => l.trimStart().startsWith('|'))
      .flatMap((row) => row.split('|'))
      .map((cell) => cell.replace(/[*`_]/g, '').trim())
      .filter((cell) => /^connected\b/i.test(cell)),
  ];
  return labels.some((l) => /\bconnected\b/i.test(l) && !NOT_CONNECTED.test(l));
}

/** A status right after a negation ("not a 404", "rather than a 404") is not stated. */
const NEGATED =
  /(?:\b(?:not|never|no|rather than|instead of)|n['’]t)(?:\s+(?:a|an|the|any|get|gets|return|returns|be|with))*\s*[`'"(]*$/i;
/** Nor is one that is only expected ("you might expect a 404"). */
const HEDGED =
  /\b(?:expect(?:s|ed)?|assum(?:e|es|ed)|might|seem(?:s|ed)?|appear(?:s|ed)?|looks? like)\b[^.\n]{0,25}$/i;

/** Whether `text` states the HTTP status `code` as what happens. */
function statesStatus(text: string, code: RegExp): boolean {
  for (const m of text.matchAll(code)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATED.test(before) && !HEDGED.test(before)) return true;
  }
  return false;
}

/** `pending` taken for the id: the response it gets, or the parameter it binds to. */
const PENDING_AS_ID = [
  /\{\s*["'`]?id["'`]?\s*:\s*["'`]pending["'`]\s*\}/i,
  /\bpending\b[^.\n]{0,60}\b(?:as|into|to)\b[^.\n]{0,25}(?::id\b|req\.params\.id)/i,
];

/** Whether the map sees /orders/:id answer the worker's request. */
function seesIdRouteAnswer(map: string): boolean {
  if (PENDING_AS_ID.some((re) => re.test(map))) return true;
  return map
    .split(/(?<=[.!?])\s+|\n/)
    .some((sentence) => /:id\b|pending/i.test(sentence) && statesStatus(sentence, /\b200\b/g));
}

/** Cites both ends of the link: the worker's default URL or fetch, and the API's port. */
function citesBothSides(text: string): boolean {
  return (
    (cites(text, 'worker.js', 1) || cites(text, 'worker.js', 4)) &&
    (cites(text, 'server.js', 3) || cites(text, 'server.js', 9))
  );
}

/** Grades cross-repo-map.md against EXPECTED.md sections 5 and 6. */
export function gradeCrossRepo(crossRepoMap: string): Grade[] {
  const connected = sections(crossRepoMap).some((s) => gradesConnected(s) && citesBothSides(s));

  // Where the map discusses the worker's poll, it must not say the poll gets a 404: it gets a
  // 200 from /orders/:id. A 404 said of some other route elsewhere is no concern of this grade.
  const aboutThePoll = crossRepoMap.split(/\n\s*\n/).filter((p) => /pending|\bpoll/i.test(p));
  const says404 = aboutThePoll.some((p) => statesStatus(p, /\b404\b/g));
  const sees = /\/orders\/pending/.test(crossRepoMap) && seesIdRouteAnswer(crossRepoMap);
  const noOp = sees && !says404;
  return [
    {
      id: 'cross-repo-link',
      title:
        'order-worker → orders-api is graded Connected, with both sides cited under that grade',
      required: true,
      pass: connected,
      detail: connected
        ? 'graded Connected with evidence on both sides'
        : 'no section grades the link Connected and cites both sides',
    },
    {
      id: 'silent-no-op',
      title:
        '(stretch) /orders/pending is seen to reach /orders/:id — a 200 with { id: "pending" }, not a 404',
      required: false,
      pass: noOp,
      detail: noOp
        ? 'found'
        : says404
          ? 'says the poll gets a 404 — /orders/:id answers it with a 200'
          : 'not found — reasoning about Express routing, not search',
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
