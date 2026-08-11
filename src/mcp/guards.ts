import fs from 'node:fs';
import path from 'node:path';

export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 200 * 1024;

export function resolveWithin(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repository: ${relPath}`);
  }
  return abs;
}

export function readFileCapped(absPath: string, startLine?: number, endLine?: number): string {
  const stat = fs.statSync(absPath);
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error('File too large to read (over 5 MB).');
  }
  let lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
  if (startLine !== undefined || endLine !== undefined) {
    const from = Math.max((startLine ?? 1) - 1, 0);
    const to = endLine ?? lines.length;
    lines = lines.slice(from, to);
  }
  let truncated = false;
  if (lines.length > MAX_READ_LINES) {
    lines = lines.slice(0, MAX_READ_LINES);
    truncated = true;
  }
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
    truncated = true;
  }
  return truncated ? `${text}\n… truncated (2,000-line / 200 KB cap).` : text;
}
