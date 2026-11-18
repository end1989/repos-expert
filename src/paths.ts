import fs from 'node:fs';
import path from 'node:path';

/**
 * True when `candidate` is `root` or something beneath it. Both must already be
 * absolute. `path.relative` does the comparison the platform's way — case-insensitive
 * on Windows, and a different drive comes back absolute — which a string prefix test
 * gets wrong in both directions.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Whether a repo-relative path names something inside `.git` — git's own data, never
 * source, and where a remote URL can carry a token. On Windows a name loses trailing dots
 * and spaces and a `:` opens an alternate stream, so `.git.`, `.GIT ` and
 * `.git::$INDEX_ALLOCATION` all name `.git` too; such paths are refused outright.
 */
export function namesGitDir(
  relPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return relPath.split(/[\\/]/).some((segment) => {
    if (platform !== 'win32') return segment.toLowerCase() === '.git';
    if (segment.includes(':')) return true;
    // Windows drops trailing dots and spaces, and gives .git an 8.3 short name such as
    // GIT~1 — so `GIT~1.` names it too.
    const name = segment.replace(/[. ]+$/, '').toLowerCase();
    return name === '.git' || /^git~\d+$/.test(name);
  });
}

/**
 * A file a person may have edited, as text. Notepad and Windows PowerShell 5 can start
 * UTF-8 with a byte-order mark, which JSON.parse rejects, and Windows PowerShell 5.1's `>`
 * writes UTF-16. (Line-based files such as repos.txt need nothing for the mark: their lines
 * are trimmed, and trim() removes it.)
 */
export function readTextFile(file: string): string {
  return decodeText(fs.readFileSync(file)).replace(/^\uFEFF/, '');
}

/** UTF-16 when the bytes start with its byte-order mark (FF FE, or FE FF); otherwise UTF-8. */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const even = bytes.length - (bytes.length % 2);
    return Buffer.from(bytes.subarray(2, even)).swap16().toString('utf16le');
  }
  return bytes.toString('utf8');
}

/** `C:foo` on Windows: relative to the current folder of drive C, wherever that is. */
export function isDriveRelative(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(p);
}

/**
 * The real location of `p` with links followed, even when its tail does not exist yet:
 * the deepest existing ancestor is resolved and the rest is appended. Following links
 * is the point — a link inside a repository that leads out of it must be judged by
 * where it lands, not by where it sits.
 */
export function resolveReal(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
