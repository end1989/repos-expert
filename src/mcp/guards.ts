import fs from 'node:fs';
import path from 'node:path';
import { isInside, resolveReal } from '../paths.js';

/**
 * One read is at most this many lines or bytes, whichever comes first. The byte cap keeps
 * a single result under the ~50,000 characters MCP clients accept inline; past that,
 * Claude Code moves the result out of the conversation. A capped read always ends by
 * saying which line to continue from.
 */
export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 48 * 1024;

/** Refused outright: past this, even paging through a file is the wrong tool. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A NUL byte in the first stretch of a file is how git and ripgrep tell binary from text. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Where `relPath` really is, provided it is inside `rootDir`: first by the path as written,
 * then by where it lands once links are followed (and, on Windows, short names expanded).
 */
export function resolveWithin(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  if (!isInside(root, abs)) {
    throw new Error(`Path escapes repository: ${relPath}`);
  }
  const real = resolveReal(abs);
  if (!isInside(resolveReal(root), real)) {
    throw new Error(`Path escapes repository: ${relPath}`);
  }
  return real;
}

export { namesGitDir } from '../paths.js';

/**
 * Reads `absPath` from `startLine` (1-based, inclusive) to `endLine`, within the caps.
 * Cuts only at a line boundary, so "continue with startLine N" picks up exactly where
 * the text stopped.
 */
export function readFileCapped(absPath: string, startLine?: number, endLine?: number): string {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${absPath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File too large to read (over 5 MB). Search it with search_code instead.');
  }
  const buffer = fs.readFileSync(absPath);
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return `Binary file (${buffer.length} bytes) — not shown.`;
  }
  const all = buffer.toString('utf8').split(/\r?\n/);
  if (all.length > 1 && all.at(-1) === '') all.pop(); // a final newline ends a line; it does not start one

  const first = startLine ?? 1;
  const last = Math.min(endLine ?? all.length, all.length);
  if (endLine !== undefined && endLine < first) {
    throw new Error(`endLine (${endLine}) is before startLine (${first}).`);
  }
  if (first > all.length) {
    throw new Error(`The file has ${all.length} lines; startLine ${first} is past the end.`);
  }

  const shown: string[] = [];
  let bytes = 0;
  for (let n = first; n <= last && shown.length < MAX_READ_LINES; n++) {
    const line = all[n - 1] ?? '';
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + cost > MAX_READ_BYTES) {
      if (shown.length === 0) {
        // One line longer than the whole cap: show its start rather than nothing.
        const cut = Buffer.from(line, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
        return `${cut}\n… line ${n} is longer than the ${MAX_READ_BYTES / 1024} KB read cap and was cut.${
          n < all.length ? ` Continue with startLine: ${n + 1}.` : ''
        }`;
      }
      break;
    }
    shown.push(line);
    bytes += cost;
  }

  const lastShown = first + shown.length - 1;
  const text = shown.join('\n');
  if (lastShown >= last) return text;
  return `${text}\n… showing lines ${first}–${lastShown} of ${all.length}. Continue with startLine: ${lastShown + 1}.`;
}
