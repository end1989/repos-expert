import { DEFAULT_REFRESH_IGNORE, type ExpertConfig } from '../config.js';
import { changedFilesSince } from '../git.js';
import { matchesAnyGlob } from '../glob.js';
import { markVerified, type RepoStatus } from '../registry.js';

/**
 * The trivial-change fast path.
 *
 * A repo is "stale" the moment HEAD moves past the commit its docs were written at.
 * But the docs describe the code, and a great many commits touch none of it — a
 * README edit, a CI tweak, a lockfile bump. Paying two to four minutes of model time
 * to re-read an unchanged codebase is waste, and stamping the docs "written at HEAD"
 * afterwards would be a small lie. So the automatic sweep asks git which paths
 * changed since curation; if every one of them is on the ignore list, the repo is
 * re-verified — its meta records that the code is unchanged through HEAD — and the
 * curator is not called. Named repos (`refresh <name>`) never take this path: naming a
 * repo means "study it, whatever git says".
 */

export interface ReverifyDeps {
  /** Paths changed since a commit, or null when the history cannot answer (rewritten branch, missing sha). */
  changedFiles(status: RepoStatus): Promise<string[] | null>;
}

const realDeps: ReverifyDeps = {
  changedFiles: async (status) => {
    if (status.curatedSha === null) return null;
    try {
      return await changedFilesSince(status.path, status.curatedSha);
    } catch {
      return null;
    }
  },
};

/** True when nothing changed, or everything that changed is on the ignore list. */
export function isTrivialChange(files: readonly string[], ignore: readonly string[]): boolean {
  if (files.length === 0) return true;
  if (ignore.length === 0) return false;
  return files.every((f) => matchesAnyGlob(f, ignore));
}

export interface Partition {
  /** Still need the model. */
  curate: RepoStatus[];
  /** Re-verified without it, in input order. */
  reverified: string[];
}

/**
 * Splits candidates into "curate" and "re-verified". Only `stale` repos are eligible;
 * everything else passes through to `curate` untouched.
 */
export async function partitionStale(
  cfg: ExpertConfig,
  candidates: RepoStatus[],
  deps: ReverifyDeps = realDeps,
  /** 'dry-run' classifies without recording anything — for `--dry-run`. */
  mode: 'apply' | 'dry-run' = 'apply',
): Promise<Partition> {
  const ignore = cfg.refreshIgnore ?? DEFAULT_REFRESH_IGNORE;
  const out: Partition = { curate: [], reverified: [] };
  for (const s of candidates) {
    if (s.state !== 'stale' || s.curatedSha === null) {
      out.curate.push(s);
      continue;
    }
    const files = await deps.changedFiles(s);
    if (files !== null && isTrivialChange(files, ignore)) {
      if (mode === 'apply') markVerified(cfg.knowledgeDir, s.name, s.currentSha);
      out.reverified.push(s.name);
    } else {
      out.curate.push(s);
    }
  }
  return out;
}
