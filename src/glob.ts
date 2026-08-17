/**
 * The little glob dialect the refresh fast path uses to decide "only docs changed",
 * matched against repo-relative, forward-slash paths as `git diff --name-only` prints
 * them. Deliberately small: `**` (any depth), `*` (within one segment), `?` (one char),
 * and gitignore's rule that a pattern with no slash matches at any depth. Nothing else.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;

  // A pattern without a slash is meant for a basename anywhere (gitignore semantics).
  const anchored = pattern.includes('/') ? pattern : `**/${pattern}`;
  let re = '';
  for (let i = 0; i < anchored.length; i++) {
    const c = anchored[i]!;
    if (c === '*') {
      if (anchored[i + 1] === '*') {
        // `**/` → zero or more whole segments; a trailing `**` → anything at all.
        if (anchored[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesAnyGlob(relPath: string, patterns: readonly string[]): boolean {
  const p = relPath.replace(/\\/g, '/');
  return patterns.some((g) => globToRegExp(g).test(p));
}
