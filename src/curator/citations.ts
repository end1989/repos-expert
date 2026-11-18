import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../paths.js';
import type { BrokenCitation, CitationReport } from '../registry.js';

export type { BrokenCitation, CitationReport };

/**
 * A mechanical check on what the curator wrote. The prompt requires every interface to
 * cite the file:line that defines it; this confirms each citation points at a file that
 * exists and a line that file actually has. It cannot tell whether the line says what the
 * document claims — but a citation to a line that is not there is certainly wrong, and
 * costs nothing to catch.
 */

export interface Citation {
  /** As written in the document, e.g. "src/server.js:5-7". */
  text: string;
  /** Repo-relative, forward slashes. */
  file: string;
  start: number;
  end: number;
}

/**
 * `path/to/name.ext:12`, `name.ext:12-30` (hyphen or en dash), optionally `./`-prefixed.
 * The filename needs an extension; a character before the path that could belong to a URL
 * or another word rules the match out, so `http://localhost:4000` is never a citation.
 */
const CITATION =
  /(?<![\w/.:@-])((?:\.\.?\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)(?:\s*[-–]\s*(\d+))?(?!\w|\.\w)/g;

export function findCitations(text: string): Citation[] {
  const found: Citation[] = [];
  for (const m of text.matchAll(CITATION)) {
    const raw = (m[1] ?? '').replace(/\\/g, '/');
    const start = Number(m[2]);
    const end = m[3] === undefined ? start : Number(m[3]);
    found.push({ text: m[0], file: raw.replace(/^\.\//, ''), start, end });
  }
  return found;
}

function lineCount(file: string): number {
  const body = fs.readFileSync(file, 'utf8');
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/).length;
  return body.endsWith('\n') ? lines - 1 : lines;
}

/** Checks every citation in `docs` against the repository at `root`. */
export function checkCitations(
  root: string,
  docs: Readonly<Record<string, string>>,
): CitationReport {
  const realRoot = path.resolve(root);
  const report: CitationReport = { checked: 0, broken: [] };
  const counts = new Map<string, number>();

  for (const [doc, body] of Object.entries(docs)) {
    const seen = new Set<string>();
    for (const c of findCitations(body)) {
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      const abs = path.resolve(realRoot, c.file);
      const broken = (reason: string) => report.broken.push({ doc, citation: c.text, reason });

      if (!isInside(realRoot, abs)) {
        report.checked++;
        broken('outside the repository');
        continue;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        // A bare "name.ext:N" that resolves to nothing is as likely a host and port as a
        // file, so it is not counted. A path with a folder in it is clearly meant as a file.
        if (!c.file.includes('/')) continue;
        report.checked++;
        broken('no such file');
        continue;
      }
      report.checked++;
      let lines = counts.get(abs);
      if (lines === undefined) {
        lines = lineCount(abs);
        counts.set(abs, lines);
      }
      if (c.end < c.start) broken('the range ends before it starts');
      else if (c.start < 1 || c.end > lines) broken(`the file has ${lines} lines`);
    }
  }
  return report;
}
