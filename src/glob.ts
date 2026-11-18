/**
 * The glob dialect used in two places: the refresh fast path deciding "only docs
 * changed", and the `glob`/`pattern` arguments of the MCP search tools. Matched against
 * repo-relative, forward-slash paths. Supports `**` (any depth), `*` (within one
 * segment), `?` (one character), `[abc]` / `[a-z]` / `[!abc]` classes, `{a,b}`
 * alternatives (not nested), and gitignore's anchoring: a pattern with no slash, or only a
 * trailing one, matches at any depth. A backslash is read as a folder separator, the
 * Windows habit, so there are no escapes; no file name on Windows needs one.
 *
 * Patterns arrive from MCP clients, so matching must stay cheap whatever the pattern.
 * No regular expression is built: a path is matched segment by segment (memoised, so a
 * run of `**` costs nothing extra), and each segment with the linear two-pointer wildcard
 * algorithm. A backtracking regex compiled from `**\/**\/…` or `*a*a*a…` could stall the
 * single Node thread — and with it every client of the server — for minutes.
 */

/** `{a,b}{c,d}…` multiplies; a glob that would expand to more alternatives is refused. */
const MAX_ALTERNATIVES = 64;

/** Compiled patterns kept for reuse; past this many the cache starts over. */
const MAX_CACHED = 256;

type Atom =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; c: string }
  | { kind: 'class'; negate: boolean; items: (string | [string, string])[] };

/** One path segment's atoms, or `**` for any number of whole segments. */
type Segment = Atom[] | '**';

interface Compiled {
  /** Each `{a,b}` alternative as a list of path segments. */
  alternatives: Segment[][];
}

const cache = new Map<string, Compiled>();

/**
 * `{a,b}` alternatives, expanded. Groups multiply, so the product is built one group at a
 * time and refused the moment it would pass MAX_ALTERNATIVES — never generated first and
 * counted after: twelve groups of ten, in 252 characters, would be 10^12 alternatives.
 * Nested groups are refused rather than misread, since this matcher does not expand them
 * (ripgrep does). A `{` with no closing `}` is an ordinary character.
 */
function expandBraces(pattern: string): string[] {
  let expanded = [''];
  let at = 0;
  for (;;) {
    const open = pattern.indexOf('{', at);
    const close = open === -1 ? -1 : pattern.indexOf('}', open);
    if (close === -1) break;
    const inner = pattern.slice(open + 1, close);
    if (inner.includes('{')) {
      throw new Error(
        `Nested {…} groups are not supported in a glob: write {a,b,c} rather than {a,{b,c}}. Got ${JSON.stringify(pattern)}.`,
      );
    }
    const alternatives = inner.split(',');
    if (expanded.length * alternatives.length > MAX_ALTERNATIVES) {
      throw new Error(
        `The glob ${JSON.stringify(pattern)} expands to more than ${MAX_ALTERNATIVES} alternatives; use fewer {…} groups.`,
      );
    }
    const literal = pattern.slice(at, open);
    expanded = expanded.flatMap((prefix) => alternatives.map((alt) => prefix + literal + alt));
    at = close + 1;
  }
  const rest = pattern.slice(at);
  return expanded.map((prefix) => prefix + rest);
}

function compileSegment(segment: string): Atom[] {
  const atoms: Atom[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? '';
    if (c === '*') {
      if (atoms.at(-1)?.kind !== 'star') atoms.push({ kind: 'star' }); // `**` inside a segment is `*`
    } else if (c === '?') {
      atoms.push({ kind: 'any' });
    } else if (c === '[' && segment.indexOf(']', i + 2) !== -1) {
      const end = segment.indexOf(']', i + 2);
      let body = segment.slice(i + 1, end);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      const items: (string | [string, string])[] = [];
      for (let k = 0; k < body.length; k++) {
        const from = body[k] ?? '';
        if (body[k + 1] === '-' && k + 2 < body.length) {
          items.push([from, body[k + 2] ?? '']);
          k += 2;
        } else {
          items.push(from);
        }
      }
      atoms.push({ kind: 'class', negate, items });
      i = end;
    } else {
      atoms.push({ kind: 'char', c });
    }
  }
  return atoms;
}

function atomMatches(atom: Atom, ch: string): boolean {
  if (atom.kind === 'any') return true;
  if (atom.kind === 'char') return atom.c === ch;
  if (atom.kind === 'class') {
    // A reversed range such as [z-a] simply matches nothing.
    const hit = atom.items.some((it) =>
      typeof it === 'string' ? it === ch : it[0] <= ch && ch <= it[1],
    );
    return hit !== atom.negate;
  }
  return false; // a star is handled by the caller, never matched character by character
}

/** Wildcard match of one segment: O(pattern × text) at worst, never exponential. */
function matchSegment(atoms: readonly Atom[], text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const atom = atoms[p];
    if (atom !== undefined && atom.kind === 'star') {
      starP = p++;
      starT = t;
    } else if (atom !== undefined && atomMatches(atom, text[t] ?? '')) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (atoms[p]?.kind === 'star') p++;
  return p === atoms.length;
}

/** Path match over segments, memoised on (pattern position, path position). */
function matchSegments(pattern: readonly Segment[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    const seg = pattern[i];
    if (seg === undefined) {
      result = j === path.length;
    } else if (seg === '**') {
      if (i === pattern.length - 1) {
        result = j < path.length; // a trailing `**` needs something beneath it
      } else {
        result = false;
        for (let k = j; k <= path.length && !result; k++) result = go(i + 1, k);
      }
    } else {
      const part = path[j];
      result = part !== undefined && matchSegment(seg, part) && go(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function compile(pattern: string): Compiled {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  const alternatives = expandBraces(pattern).map((alt) => {
    let p = alt.replace(/\\/g, '/');
    // gitignore's anchoring, decided on the pattern as written: a slash at the start or in
    // the middle ties it to the root; with none, or only a trailing one, it matches at any
    // depth. A trailing slash means "this folder and everything in it".
    const rooted = p.startsWith('/') || p.startsWith('./');
    p = p.replace(/^\.\//, '').replace(/^\/+/, '');
    const folder = p.endsWith('/');
    p = p.replace(/\/+$/, '');
    if (!rooted && !p.includes('/')) p = `**/${p}`;
    if (folder) p += '/**';
    const segments: Segment[] = [];
    for (const part of p.split('/')) {
      if (part === '**') {
        if (segments.at(-1) !== '**') segments.push('**'); // `**/**` is one `**`
      } else {
        segments.push(compileSegment(part));
      }
    }
    return segments;
  });
  const compiled = { alternatives };
  // Patterns come from clients: a cache that only grows is a slow memory leak.
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
}

function segmentsOf(relPath: string): string[] {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
}

/** Why `pattern` cannot be used as a glob — nested or too many `{…}` alternatives — or null. */
export function globProblem(pattern: string): string | null {
  try {
    compile(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  const path = segmentsOf(relPath);
  return compile(pattern).alternatives.some((alt) => matchSegments(alt, path));
}

/**
 * Whether `pattern` could match some path whose last segment is `name`, wherever that path
 * is. In ripgrep a glob that matches a folder lets the search into it, so this judges a glob
 * by the folders it could open. A trailing `**` matches whatever lies beneath, so it always
 * could. Throws, like `matchesGlob`, on a pattern `globProblem` reports.
 */
export function couldMatchFolder(pattern: string, name: string): boolean {
  return compile(pattern).alternatives.some((alt) => {
    const last = alt.at(-1);
    return last === '**' || (last !== undefined && matchSegment(last, name));
  });
}

export function matchesAnyGlob(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((g) => matchesGlob(g, relPath));
}

export interface PathFilterOptions {
  /**
   * The paths are in a folder of repositories (`repo/src/x.ts`): also match the glob
   * against each path below its first segment, so `src/**` means "src in any repo".
   */
  belowTopLevel?: boolean;
}

/**
 * A predicate for a client-supplied glob. A path matches when the glob matches it or one
 * of its parent folders — so "docs" selects everything under a docs folder, as it would
 * in ripgrep. A leading `!` inverts it. No glob keeps everything.
 */
export function pathFilter(
  glob: string | undefined,
  opts: PathFilterOptions = {},
): (relPath: string) => boolean {
  if (glob === undefined || glob.length === 0) return () => true;
  const negate = glob.startsWith('!');
  const { alternatives } = compile(negate ? glob.slice(1) : glob);
  // "matches the path or a parent" is "matches the path, or matches with `/**` appended".
  const patterns = alternatives.flatMap((alt) => [alt, [...alt, '**' as const]]);
  const hits = (segments: readonly string[]) => patterns.some((p) => matchSegments(p, segments));
  return (relPath) => {
    const segments = segmentsOf(relPath);
    const hit =
      hits(segments) ||
      (opts.belowTopLevel === true && segments.length > 1 && hits(segments.slice(1)));
    return hit !== negate;
  };
}
