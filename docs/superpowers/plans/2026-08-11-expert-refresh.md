# `expert refresh` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command — `expert refresh [repo...]` — that syncs the mirrors, re-curates stale docs (or the named repos unconditionally), runs the portfolio pass, and guards against concurrent runs with a lockfile.

**Architecture:** A new `runRefresh` orchestrator in `src/cli/refresh.ts` with injectable deps (sync/curate/portfolio/registry), a shared curate-loop helper extracted to `src/cli/curate-many.ts` (used by both `curate` and `refresh`), an `only` filter added to `syncRepos`, and CLI wiring plus a README overhaul (usage, machine transfer, AI-client connection). Spec: `docs/superpowers/specs/2026-08-10-expert-refresh-design.md`.

**Tech Stack:** Existing project conventions — TypeScript strict, NodeNext ESM (`.js` import extensions), vitest, commander. No new dependencies.

## Global Constraints

- No-args refresh curates **stale only**; uncurated repos are reported, never auto-curated. Named repos are curated **unconditionally**.
- Lockfile `<knowledgeDir>/.refresh.lock`, created with flag `'wx'`, removed in `finally`; collision message: `Another refresh appears to be running (started <ts>). If that is stale, delete <path> and retry.`
- Per-repo failures collected, run continues; exit code 1 if any stage failed.
- All subprocesses stay behind existing wrappers (`src/git.ts`); no new spawning.
- MCP server stdout discipline unchanged (refresh is CLI-only and may print).
- TypeScript strict; `npx tsc --noEmit` clean before every commit.
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Tests: `npx vitest run tests/<file>.test.ts` focused, `npx vitest run` full suite before each commit.
- The initial curation batch has finished; `npm run build` is safe to run again (Task 4 does).

---

### Task 1: `syncRepos` gains an `only` filter

**Files:**
- Modify: `src/cli/sync.ts` (the `syncRepos` function)
- Test: `tests/sync.test.ts` (append one test)

**Interfaces:**
- Consumes: existing `syncRepos(cfg: ExpertConfig, deps: SyncDeps = realDeps): Promise<SyncResult>` and the test file's existing `makeCfg`/`remote` helpers (`tests/sync.test.ts:1-40`).
- Produces: `syncRepos(cfg: ExpertConfig, deps?: SyncDeps, only?: string[]): Promise<SyncResult>` — when `only` is given, the remote list is filtered to those names and every name absent from the remote list lands in `result.failed` with error `'not found on GitHub account'`. Task 3 calls it as `syncRepos(cfg, undefined, names)`.

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('syncRepos', ...)` block in `tests/sync.test.ts`:

```ts
  it('with only, syncs just the named repos and fails unknown names', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    const calls: string[] = [];
    const deps: SyncDeps = {
      listRemote: async () => [remote('alpha'), remote('beta')],
      clone: async (_url, dest) => {
        calls.push(`clone:${path.basename(dest)}`);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async () => {},
    };
    const res = await syncRepos(cfg, deps, ['alpha', 'ghost']);
    expect(calls).toEqual(['clone:alpha']);
    expect(res.synced).toEqual(['alpha']);
    expect(res.failed).toEqual([{ name: 'ghost', error: 'not found on GitHub account' }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — the new test's `res.failed` is `[]` (no `only` support yet) and `calls` includes `clone:beta`.

- [ ] **Step 3: Implement** — in `src/cli/sync.ts`, change the `syncRepos` signature and insert the filter between `listRemote` and the loop:

```ts
export async function syncRepos(
  cfg: ExpertConfig,
  deps: SyncDeps = realDeps,
  only?: string[],
): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [] };
  let remote = await deps.listRemote(cfg.githubUser);
  if (only !== undefined) {
    for (const name of only) {
      if (!remote.some((r) => r.name === name)) {
        result.failed.push({ name, error: 'not found on GitHub account' });
      }
    }
    remote = remote.filter((r) => only.includes(r.name));
  }
  fs.mkdirSync(cfg.reposDir, { recursive: true });
  // ...existing loop unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync.test.ts` (3 passing), then `npx vitest run` (full suite green) and `npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit**

```bash
git add src/cli/sync.ts tests/sync.test.ts
git commit -m "feat: syncRepos only-filter for named-repo refresh"
```

---

### Task 2: Extract `curateMany` and refactor the `curate` action

**Files:**
- Create: `src/cli/curate-many.ts`
- Modify: `src/cli/index.ts` (the `curate` action's `--all/--stale` loop)
- Test: `tests/curate-many.test.ts`

**Interfaces:**
- Consumes: `curateRepo(cfg, status)` from `../curator/curator.js`; `ExpertConfig`; `RepoStatus`.
- Produces (from `src/cli/curate-many.ts`):
  - `type CurateOne = (cfg: ExpertConfig, status: RepoStatus) => Promise<void>`
  - `interface CurateFailure { name: string; error: string }`
  - `curateMany(cfg: ExpertConfig, statuses: RepoStatus[], curateOne?: CurateOne): Promise<CurateFailure[]>` — sequential loop, prints `curated <name>` / `FAILED <name>: <error>`, collects failures, continues. Task 3 injects its own `curateOne`.

- [ ] **Step 1: Write the failing test** — create `tests/curate-many.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RepoStatus } from '../src/registry.js';
import { curateMany } from '../src/cli/curate-many.js';
import { makeTempDir } from './helpers.js';

function makeCfg(root: string): ExpertConfig {
  return {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
  };
}

const status = (name: string): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: null,
  curatedAt: null,
  state: 'uncurated',
});

describe('curateMany', () => {
  it('curates each status, collects failures, and continues', async () => {
    const cfg = makeCfg(makeTempDir('expert-cm-'));
    const seen: string[] = [];
    const failures = await curateMany(cfg, [status('a'), status('bad'), status('c')], async (_cfg, s) => {
      seen.push(s.name);
      if (s.name === 'bad') throw new Error('boom');
    });
    expect(seen).toEqual(['a', 'bad', 'c']);
    expect(failures).toEqual([{ name: 'bad', error: 'boom' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/curate-many.test.ts`
Expected: FAIL — cannot resolve `../src/cli/curate-many.js`.

- [ ] **Step 3: Implement `src/cli/curate-many.ts`**

```ts
import type { ExpertConfig } from '../config.js';
import type { RepoStatus } from '../registry.js';
import { curateRepo } from '../curator/curator.js';

export type CurateOne = (cfg: ExpertConfig, status: RepoStatus) => Promise<void>;

export interface CurateFailure {
  name: string;
  error: string;
}

export async function curateMany(
  cfg: ExpertConfig,
  statuses: RepoStatus[],
  curateOne: CurateOne = curateRepo,
): Promise<CurateFailure[]> {
  const failures: CurateFailure[] = [];
  for (const status of statuses) {
    try {
      await curateOne(cfg, status);
      console.log(`curated ${status.name}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ name: status.name, error });
      console.error(`FAILED ${status.name}: ${error}`);
    }
  }
  return failures;
}
```

- [ ] **Step 4: Refactor the `curate` action in `src/cli/index.ts`** — replace the inline `--all/--stale` loop body (the `for (const status of targets) { try { await curateRepo(...) ... } }` block and its `failures` counting) with:

```ts
    } else if (opts.all || opts.stale) {
      const statuses = await listRepoStatuses(cfg);
      const targets = opts.stale ? statuses.filter((s) => s.state !== 'fresh') : statuses;
      if (targets.length === 0) console.log('Nothing to curate — everything is fresh.');
      failures += (await curateMany(cfg, targets)).length;
    }
```

Add the import: `import { curateMany } from './curate-many.js';` — and remove the now-unused direct `curateRepo` import from `index.ts` if nothing else in the file uses it (the single-repo branch `await curateRepo(cfg, await getRepoStatus(cfg, repoArg))` still does — keep it).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/curate-many.test.ts` (1 passing), `npx vitest run` (full suite green — the curate action refactor changes no behavior), `npx tsc --noEmit` (clean), and smoke `npx tsx src/cli/index.ts curate` with no args (prints the "Specify a repo" error, exit 1 — wiring intact).

- [ ] **Step 6: Commit**

```bash
git add src/cli/curate-many.ts src/cli/index.ts tests/curate-many.test.ts
git commit -m "refactor: extract shared curate loop into curateMany"
```

---

### Task 3: `runRefresh` with lockfile

**Files:**
- Create: `src/cli/refresh.ts`
- Test: `tests/refresh.test.ts`

**Interfaces:**
- Consumes: `syncRepos(cfg, deps?, only?)` + `SyncResult` from `./sync.js` (Task 1); `curateMany`, `CurateOne`, `CurateFailure` from `./curate-many.js` (Task 2); `curatePortfolio` from `../curator/curator.js`; `listRepoStatuses`, `getRepoStatus`, `RepoStatus` from `../registry.js`.
- Produces (from `src/cli/refresh.ts`):
  - `interface RefreshDeps { sync(cfg: ExpertConfig, only?: string[]): Promise<SyncResult>; curateOne: CurateOne; portfolio(cfg: ExpertConfig): Promise<void>; listStatuses(cfg: ExpertConfig): Promise<RepoStatus[]>; getStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus>; }`
  - `interface RefreshResult { synced: number; syncFailed: CurateFailure[]; curated: number; curateFailed: CurateFailure[]; uncurated: string[]; portfolioOk: boolean; portfolioError: string | null; }`
  - `runRefresh(cfg: ExpertConfig, names?: string[], deps?: RefreshDeps): Promise<RefreshResult>`
  - `refreshLockPath(knowledgeDir: string): string` (exported for tests; returns `<knowledgeDir>/.refresh.lock`)

- [ ] **Step 1: Write the failing tests** — create `tests/refresh.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RepoStatus } from '../src/registry.js';
import { runRefresh, refreshLockPath, type RefreshDeps } from '../src/cli/refresh.js';
import { makeTempDir } from './helpers.js';

function makeCfg(root: string): ExpertConfig {
  return {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
  };
}

const status = (name: string, state: RepoStatus['state']): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'a'.repeat(40),
  curatedSha: state === 'uncurated' ? null : 'b'.repeat(40),
  curatedAt: state === 'uncurated' ? null : '2026-08-10T00:00:00Z',
  state,
});

function makeDeps(overrides: Partial<RefreshDeps> = {}): { deps: RefreshDeps; calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = { sync: [], curate: [], portfolio: [], getStatus: [] };
  const deps: RefreshDeps = {
    sync: async (_cfg, only) => {
      calls.sync.push(only === undefined ? '(all)' : only.join(','));
      return { synced: ['x'], skipped: [], failed: [] };
    },
    curateOne: async (_cfg, s) => {
      calls.curate.push(s.name);
    },
    portfolio: async () => {
      calls.portfolio.push('yes');
    },
    listStatuses: async () => [status('fresh1', 'fresh'), status('stale1', 'stale'), status('new1', 'uncurated')],
    getStatus: async (_cfg, name) => {
      calls.getStatus.push(name);
      if (name === 'ghost') throw new Error('Invalid repo name: ghost');
      return status(name, 'fresh');
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('runRefresh', () => {
  it('no-args: curates stale only, reports uncurated, runs portfolio', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, undefined, deps);
    expect(calls.sync).toEqual(['(all)']);
    expect(calls.curate).toEqual(['stale1']);
    expect(res.uncurated).toEqual(['new1']);
    expect(calls.portfolio).toEqual(['yes']);
    expect(res.curated).toBe(1);
    expect(res.curateFailed).toEqual([]);
    expect(res.portfolioOk).toBe(true);
  });

  it('named mode: passes only to sync and curates named repos even when fresh', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, ['alpha', 'beta'], deps);
    expect(calls.sync).toEqual(['alpha,beta']);
    expect(calls.curate).toEqual(['alpha', 'beta']);
    expect(res.uncurated).toEqual([]);
    expect(res.curated).toBe(2);
  });

  it('named mode: unknown name fails but the rest continue and portfolio runs', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps, calls } = makeDeps();
    const res = await runRefresh(cfg, ['ghost', 'alpha'], deps);
    expect(calls.curate).toEqual(['alpha']);
    expect(res.curateFailed).toEqual([{ name: 'ghost', error: 'Invalid repo name: ghost' }]);
    expect(calls.portfolio).toEqual(['yes']);
  });

  it('curate failure is collected, portfolio failure is reported', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const { deps } = makeDeps({
      curateOne: async () => {
        throw new Error('agent exploded');
      },
      portfolio: async () => {
        throw new Error('portfolio exploded');
      },
    });
    const res = await runRefresh(cfg, undefined, deps);
    expect(res.curateFailed).toEqual([{ name: 'stale1', error: 'agent exploded' }]);
    expect(res.portfolioOk).toBe(false);
    expect(res.portfolioError).toBe('portfolio exploded');
  });

  it('refuses to run when the lockfile exists, and names the path', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: '2026-08-11T00:00:00Z' }));
    const { deps, calls } = makeDeps();
    await expect(runRefresh(cfg, undefined, deps)).rejects.toThrow(/Another refresh appears to be running \(started 2026-08-11T00:00:00Z\)/);
    expect(calls.sync).toEqual([]);
    fs.rmSync(lock);
  });

  it('removes the lock after success and after a thrown stage', async () => {
    const cfg = makeCfg(makeTempDir('expert-rf-'));
    const lock = refreshLockPath(cfg.knowledgeDir);
    const { deps } = makeDeps();
    await runRefresh(cfg, undefined, deps);
    expect(fs.existsSync(lock)).toBe(false);
    const { deps: badDeps } = makeDeps({
      sync: async () => {
        throw new Error('network gone');
      },
    });
    await expect(runRefresh(cfg, undefined, badDeps)).rejects.toThrow('network gone');
    expect(fs.existsSync(lock)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/refresh.test.ts`
Expected: FAIL — cannot resolve `../src/cli/refresh.js`.

- [ ] **Step 3: Implement `src/cli/refresh.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../config.js';
import { listRepoStatuses, getRepoStatus, type RepoStatus } from '../registry.js';
import { curatePortfolio } from '../curator/curator.js';
import { syncRepos, type SyncResult } from './sync.js';
import { curateMany, type CurateOne, type CurateFailure } from './curate-many.js';

export interface RefreshDeps {
  sync(cfg: ExpertConfig, only?: string[]): Promise<SyncResult>;
  curateOne: CurateOne;
  portfolio(cfg: ExpertConfig): Promise<void>;
  listStatuses(cfg: ExpertConfig): Promise<RepoStatus[]>;
  getStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus>;
}

const realDeps: RefreshDeps = {
  sync: (cfg, only) => syncRepos(cfg, undefined, only),
  curateOne: undefined as unknown as CurateOne, // curateMany's default (curateRepo) is used below
  portfolio: (cfg) => curatePortfolio(cfg),
  listStatuses: listRepoStatuses,
  getStatus: getRepoStatus,
};

export interface RefreshResult {
  synced: number;
  syncFailed: CurateFailure[];
  curated: number;
  curateFailed: CurateFailure[];
  uncurated: string[];
  portfolioOk: boolean;
  portfolioError: string | null;
}

export function refreshLockPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.refresh.lock');
}

function acquireLock(knowledgeDir: string): string {
  const p = refreshLockPath(knowledgeDir);
  fs.mkdirSync(knowledgeDir, { recursive: true });
  try {
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let startedAt = 'an unknown time';
    try {
      startedAt = (JSON.parse(fs.readFileSync(p, 'utf8')) as { startedAt?: string }).startedAt ?? startedAt;
    } catch {
      // corrupted lock — the generic message still names the path
    }
    throw new Error(
      `Another refresh appears to be running (started ${startedAt}). If that is stale, delete ${p} and retry.`,
    );
  }
  return p;
}

export async function runRefresh(
  cfg: ExpertConfig,
  names?: string[],
  deps: RefreshDeps = realDeps,
): Promise<RefreshResult> {
  const lock = acquireLock(cfg.knowledgeDir);
  try {
    const sync = await deps.sync(cfg, names);
    const result: RefreshResult = {
      synced: sync.synced.length,
      syncFailed: sync.failed,
      curated: 0,
      curateFailed: [],
      uncurated: [],
      portfolioOk: false,
      portfolioError: null,
    };

    const targets: RepoStatus[] = [];
    if (names !== undefined) {
      for (const name of names) {
        try {
          targets.push(await deps.getStatus(cfg, name));
        } catch (err) {
          result.curateFailed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      const statuses = await deps.listStatuses(cfg);
      targets.push(...statuses.filter((s) => s.state === 'stale'));
      result.uncurated = statuses.filter((s) => s.state === 'uncurated').map((s) => s.name);
    }

    const failures =
      deps.curateOne === realDeps.curateOne
        ? await curateMany(cfg, targets)
        : await curateMany(cfg, targets, deps.curateOne);
    result.curateFailed.push(...failures);
    result.curated = targets.length - failures.length;

    try {
      await deps.portfolio(cfg);
      result.portfolioOk = true;
    } catch (err) {
      result.portfolioError = err instanceof Error ? err.message : String(err);
    }
    return result;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
```

Note on `realDeps.curateOne`: the `undefined as unknown as CurateOne` placeholder plus the equality branch is ugly. Implement it the clean way instead if you prefer — make `curateOne` optional in `RefreshDeps` (`curateOne?: CurateOne`) and call `curateMany(cfg, targets, deps.curateOne)` unconditionally (passing `undefined` selects `curateMany`'s default `curateRepo`). If you do, drop the placeholder from `realDeps` entirely and keep the tests as written (they always inject `curateOne`). Either implementation must pass the same tests; prefer the optional-field version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/refresh.test.ts` (6 passing), `npx vitest run` (full suite), `npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit**

```bash
git add src/cli/refresh.ts tests/refresh.test.ts
git commit -m "feat: runRefresh orchestrator with stale-only default and lockfile"
```

---

### Task 4: CLI wiring, README overhaul, build + smoke

**Files:**
- Modify: `src/cli/index.ts` (add `refresh` subcommand)
- Modify: `README.md` (usage line, machine-transfer section, AI-clients section)
- Test: existing suite (wiring is thin; logic was tested in Task 3)

**Interfaces:**
- Consumes: `runRefresh`, `RefreshResult` from `./refresh.js` (Task 3).
- Produces: `expert refresh [repos...]` CLI; README sections the spec mandates.

- [ ] **Step 1: Add the subcommand to `src/cli/index.ts`** (import `runRefresh` from `./refresh.js` at the top with the other imports):

```ts
program
  .command('refresh')
  .description('Sync mirrors, re-curate stale docs (or the named repos), then the portfolio')
  .argument('[repos...]', 'limit to these repos and curate them unconditionally')
  .action(async (repos: string[]) => {
    const cfg = loadConfig();
    const res = await runRefresh(cfg, repos.length > 0 ? repos : undefined);
    console.log(
      `sync: ${res.synced} ok, ${res.syncFailed.length} failed | curate: ${res.curated} ok, ${res.curateFailed.length} failed | portfolio: ${res.portfolioOk ? 'ok' : 'FAILED'}`,
    );
    if (res.uncurated.length > 0) {
      console.log(
        `uncurated (not auto-curated — add with \`expert refresh <name>\`): ${res.uncurated.join(', ')}`,
      );
    }
    for (const f of [...res.syncFailed, ...res.curateFailed]) {
      console.error(`  FAILED ${f.name}: ${f.error}`);
    }
    if (res.portfolioError !== null) console.error(`  FAILED portfolio: ${res.portfolioError}`);
    if (res.syncFailed.length + res.curateFailed.length > 0 || !res.portfolioOk) {
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 2: Rewrite `README.md`** with these exact sections (keep the existing overview paragraph and Setup section; replace Use and everything after with):

````markdown
## Use

    node dist/cli/index.js sync             # mirror all repos from GitHub
    node dist/cli/index.js status           # fresh / stale / uncurated per repo
    node dist/cli/index.js refresh          # sync + re-curate stale docs + portfolio (the maintenance one-liner)
    node dist/cli/index.js refresh <name>…  # pull + curate specific repos (adds them if never curated)
    node dist/cli/index.js curate --all     # curate EVERY mirror (slow, uses the model — deliberate act)

`refresh` with no arguments never curates repos that have no docs yet — with a large
account that could be hours of model time. Add repos to the knowledge base explicitly:
`refresh <name>`. Only one refresh can run at a time (lockfile in `knowledge/`; the
error message tells you where if a crashed run leaves it behind).

## Connect your AI tools

All clients run the same local command: `node <project>\dist\cli\index.js mcp`
(substitute `<project>` with your clone's absolute path, e.g. `C:\dev\repos\ai_github_repos_expert`).

**Claude Code (CLI):**

    claude mcp add repos-expert -- node <project>\dist\cli\index.js mcp

**Claude Desktop:** add to `claude_desktop_config.json` (Windows:
`%APPDATA%\Claude\claude_desktop_config.json`; macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart the app:

    {
      "mcpServers": {
        "repos-expert": {
          "command": "node",
          "args": ["<project>/dist/cli/index.js", "mcp"]
        }
      }
    }

**GitHub Copilot (VS Code, agent mode):** create `.vscode/mcp.json` in any workspace
where you want the tools (or add to your user configuration):

    {
      "servers": {
        "repos-expert": {
          "type": "stdio",
          "command": "node",
          "args": ["<project>/dist/cli/index.js", "mcp"]
        }
      }
    }

Copilot lists the tools in agent mode; check VS Code's MCP docs if the setting names
have moved.

**Microsoft Copilot (M365 / Copilot Studio):** not directly connectable today — it only
consumes remote (HTTP) MCP servers, and this server is a local stdio process. Connecting
it would mean hosting the server behind an HTTP/SSE MCP transport (or a bridge like an
MCP remote proxy). Out of scope for now.

## Moving to another computer

The committed `knowledge/` folder IS the knowledge base — it travels with the repo.
`repos/` mirrors are disposable and regenerate.

1. Push this project to a private GitHub repo (one-time):
   `gh repo create repos-expert --private --source . --push`
2. On the new machine: `gh auth login`, clone the project, then
   `npm install && npm run build && node dist/cli/index.js sync`
3. Register with your AI tools (section above).
4. From then on, `node dist/cli/index.js refresh` is the only maintenance command.

## Curator smoke test (manual, uses the API)

    node dist/cli/index.js refresh git-practice-2

Inspect `knowledge/repos/git-practice-2/` — the four docs should read like someone
actually explored the code, and `status` should show the repo `fresh`.
````

- [ ] **Step 3: Build and smoke**

Run: `npx vitest run` (full suite green), `npx tsc --noEmit`, `npm run build`, then `node dist/cli/index.js refresh --help` (shows the argument and description) and `node dist/cli/index.js --help` (five subcommands: sync, status, curate, mcp, refresh).
Do NOT smoke a real no-args `refresh` here — with 77 uncurated mirrors it is correctly a no-op for them, but any genuinely stale repo would trigger paid curation; the paid smoke is the README's manual one.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts README.md
git commit -m "feat: expert refresh command, README for transfer and AI clients"
```

---

## Manual verification (after all tasks)

1. `node dist/cli/index.js refresh ghost-repo-that-does-not-exist` → exit 1, `not found on GitHub account`, portfolio still attempted.
2. `node dist/cli/index.js refresh git-practice-2` → pulls + re-curates one repo (paid, ~2 min), portfolio refreshes, exit 0.
3. Create `knowledge/.refresh.lock` by hand, run `refresh` → immediate "Another refresh appears to be running" error naming the path; delete the lock.
