# repos-expert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `repos-expert` — a TypeScript CLI (`expert sync|curate|status|mcp`) plus MCP server that maintains an agent-curated markdown knowledge base over ~20 GitHub repo mirrors and serves it to Claude Code.

**Architecture:** Three parts sharing one config: (1) `expert sync` mirrors all GitHub repos into `repos/` via `gh`+`git`; (2) `expert curate` runs a read-only Claude agent (Agent SDK) per repo that returns four markdown docs which the CLI writes into `knowledge/` and stamps with the HEAD SHA; (3) `expert mcp` serves seven tools (curated docs + live ripgrep search) over stdio, flagging stale docs. Spec: `docs/superpowers/specs/2026-08-10-repos-expert-design.md`.

**Tech Stack:** Node 20+, TypeScript (strict, ESM), commander, @modelcontextprotocol/sdk + zod v3, @anthropic-ai/claude-agent-sdk, @vscode/ripgrep, vitest.

## Global Constraints

- Node >= 20, `"type": "module"`, TypeScript `strict: true`, module `NodeNext`.
- Package name `repos-expert`, CLI binary `expert` (bin → `dist/cli/index.js`).
- ALL subprocesses via `execFile`/`execFileSync` with args arrays — never a shell string.
- Caps (from spec): search results max **100** matches; file reads max **2,000 lines / 200 KB**; curator timeout **10 min** with **one retry**; default model `claude-sonnet-5`.
- `repos/` is a disposable read-only mirror (gitignored); `knowledge/` is committed markdown.
- The MCP server must never write to stdout except protocol messages (no `console.log` in server paths; use `console.error`).
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Run tests from repo root: `npx vitest run` (all) or `npx vitest run tests/<file>.test.ts` (one file).

---

### Task 1: Project scaffold + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `interface ExpertConfig { githubUser: string; reposDir: string; knowledgeDir: string; model: string; excludeRepos: string[]; includeArchived: boolean }` and `function loadConfig(configPath?: string): ExpertConfig` (paths returned **absolute**, resolved against the config file's directory). Every later task imports `ExpertConfig` from `../config.js` (note `.js` extensions in imports — NodeNext ESM).

- [ ] **Step 1: Scaffold the project**

Create `package.json`:

```json
{
  "name": "repos-expert",
  "version": "0.1.0",
  "type": "module",
  "bin": { "expert": "dist/cli/index.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 20_000 },
});
```

Install dependencies:

```bash
npm install commander zod@^3 @modelcontextprotocol/sdk @anthropic-ai/claude-agent-sdk @vscode/ripgrep
npm install -D typescript tsx vitest @types/node
```

- [ ] **Step 2: Write the failing config test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-cfg-'));
  const p = path.join(dir, 'expert.config.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('loadConfig', () => {
  it('applies defaults and resolves paths against the config directory', () => {
    const p = writeConfig({ githubUser: 'example-user' });
    const cfg = loadConfig(p);
    expect(cfg.githubUser).toBe('example-user');
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './repos'));
    expect(cfg.knowledgeDir).toBe(path.resolve(path.dirname(p), './knowledge'));
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.excludeRepos).toEqual([]);
    expect(cfg.includeArchived).toBe(false);
  });

  it('honors explicit values', () => {
    const p = writeConfig({
      githubUser: 'x',
      reposDir: './mirrors',
      model: 'claude-haiku-4-5-20251001',
      excludeRepos: ['dotfiles'],
      includeArchived: true,
    });
    const cfg = loadConfig(p);
    expect(cfg.reposDir).toBe(path.resolve(path.dirname(p), './mirrors'));
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.excludeRepos).toEqual(['dotfiles']);
    expect(cfg.includeArchived).toBe(true);
  });

  it('throws when githubUser is missing', () => {
    const p = writeConfig({});
    expect(() => loadConfig(p)).toThrow(/githubUser/);
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig('C:/nope/expert.config.json')).toThrow(/not found/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface ExpertConfig {
  githubUser: string;
  reposDir: string;
  knowledgeDir: string;
  model: string;
  excludeRepos: string[];
  includeArchived: boolean;
}

const DEFAULTS = {
  reposDir: './repos',
  knowledgeDir: './knowledge',
  model: 'claude-sonnet-5',
  excludeRepos: [] as string[],
  includeArchived: false,
};

export function loadConfig(
  configPath: string = path.resolve('expert.config.json'),
): ExpertConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  if (typeof raw.githubUser !== 'string' || raw.githubUser.length === 0) {
    throw new Error('expert.config.json: "githubUser" (string) is required');
  }
  const merged = { ...DEFAULTS, ...raw } as typeof DEFAULTS & { githubUser: string };
  const base = path.dirname(configPath);
  return {
    githubUser: merged.githubUser,
    reposDir: path.resolve(base, merged.reposDir),
    knowledgeDir: path.resolve(base, merged.knowledgeDir),
    model: merged.model,
    excludeRepos: merged.excludeRepos,
    includeArchived: Boolean(merged.includeArchived),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold and config loader"
```

---

### Task 2: Git and gh helpers

**Files:**
- Create: `src/git.ts`
- Create: `tests/helpers.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all exported from `src/git.ts`):
  - `interface RemoteRepo { name: string; url: string; defaultBranch: string; isArchived: boolean }`
  - `parseRepoList(json: string): RemoteRepo[]`
  - `listGithubRepos(user: string): Promise<RemoteRepo[]>`
  - `cloneRepo(url: string, dest: string): Promise<void>`
  - `updateMirror(dir: string, defaultBranch: string): Promise<void>`
  - `revParseHead(dir: string): Promise<string>`
  - `gitLogOneline(dir: string, limit?: number): Promise<string>`
  - `gitLogRangeStat(dir: string, fromSha: string): Promise<string>`
  - `listBranches(dir: string): Promise<string>`
- Also produces test helpers in `tests/helpers.ts`: `makeTempDir(prefix: string): string`, `initGitRepo(dir: string): void`, `commitFile(dir: string, rel: string, content: string, message?: string): string` (returns the new HEAD SHA). Later test tasks reuse these.

- [ ] **Step 1: Write test helpers**

Create `tests/helpers.ts`:

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
}

export function commitFile(
  dir: string,
  rel: string,
  content: string,
  message = 'commit',
): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('add', '.');
  git('commit', '-m', message);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/git.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseRepoList, revParseHead, gitLogOneline, listBranches } from '../src/git.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

describe('parseRepoList', () => {
  it('maps gh JSON to RemoteRepo, defaulting branch to main when null', () => {
    const json = JSON.stringify([
      {
        name: 'alpha',
        url: 'https://github.com/u/alpha',
        defaultBranchRef: { name: 'master' },
        isArchived: false,
      },
      { name: 'empty', url: 'https://github.com/u/empty', defaultBranchRef: null, isArchived: true },
    ]);
    const repos = parseRepoList(json);
    expect(repos).toEqual([
      { name: 'alpha', url: 'https://github.com/u/alpha', defaultBranch: 'master', isArchived: false },
      { name: 'empty', url: 'https://github.com/u/empty', defaultBranch: 'main', isArchived: true },
    ]);
  });
});

describe('git inspection helpers', () => {
  it('reads HEAD, log, and branches from a real repo', async () => {
    const dir = path.join(makeTempDir('expert-git-'), 'repo');
    initGitRepo(dir);
    const sha = commitFile(dir, 'a.txt', 'hello', 'first commit');
    expect(await revParseHead(dir)).toBe(sha);
    expect(await gitLogOneline(dir)).toContain('first commit');
    expect(await listBranches(dir)).toContain('main');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL — cannot resolve `../src/git.js`.

- [ ] **Step 4: Implement `src/git.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OPTS = { maxBuffer: 10 * 1024 * 1024 };

export interface RemoteRepo {
  name: string;
  url: string;
  defaultBranch: string;
  isArchived: boolean;
}

interface GhRepoJson {
  name: string;
  url: string;
  defaultBranchRef: { name: string } | null;
  isArchived: boolean;
}

export function parseRepoList(json: string): RemoteRepo[] {
  const items = JSON.parse(json) as GhRepoJson[];
  return items.map((i) => ({
    name: i.name,
    url: i.url,
    defaultBranch: i.defaultBranchRef?.name ?? 'main',
    isArchived: i.isArchived,
  }));
}

export async function listGithubRepos(user: string): Promise<RemoteRepo[]> {
  const { stdout } = await run(
    'gh',
    ['repo', 'list', user, '--limit', '200', '--json', 'name,url,defaultBranchRef,isArchived'],
    OPTS,
  );
  return parseRepoList(stdout);
}

export async function cloneRepo(url: string, dest: string): Promise<void> {
  await run('git', ['clone', url, dest], OPTS);
}

export async function updateMirror(dir: string, defaultBranch: string): Promise<void> {
  await run('git', ['fetch', 'origin'], { ...OPTS, cwd: dir });
  await run('git', ['reset', '--hard', `origin/${defaultBranch}`], { ...OPTS, cwd: dir });
}

export async function revParseHead(dir: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogOneline(dir: string, limit = 30): Promise<string> {
  const { stdout } = await run('git', ['log', '--oneline', `-${limit}`], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function gitLogRangeStat(dir: string, fromSha: string): Promise<string> {
  const { stdout } = await run('git', ['log', `${fromSha}..HEAD`, '--stat'], { ...OPTS, cwd: dir });
  return stdout.trim();
}

export async function listBranches(dir: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '-a'], { ...OPTS, cwd: dir });
  return stdout.trim();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/git.test.ts`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add src/git.ts tests/git.test.ts tests/helpers.ts
git commit -m "feat: git and gh subprocess helpers"
```

---

### Task 3: Registry and staleness

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `revParseHead` from `./git.js`; `ExpertConfig` from `./config.js`; test helpers from Task 2.
- Produces (all exported from `src/registry.ts`):
  - `type RepoState = 'fresh' | 'stale' | 'uncurated'`
  - `interface RepoMeta { sha: string; curatedAt: string; model: string; docVersion: number }`
  - `interface RepoStatus { name: string; path: string; currentSha: string; curatedSha: string | null; curatedAt: string | null; state: RepoState }`
  - `readMeta(knowledgeDir: string, name: string): RepoMeta | null`
  - `writeMeta(knowledgeDir: string, name: string, meta: RepoMeta): void`
  - `getRepoStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus>`
  - `listRepoStatuses(cfg: ExpertConfig): Promise<RepoStatus[]>` (scans `cfg.reposDir` for dirs containing `.git`, sorted by name)
  - `stalenessBanner(status: RepoStatus): string` — `''` for fresh; for stale: `⚠ docs curated at <sha7>, repo now at <sha7> — trust live search over summaries.` followed by a blank line; for uncurated: `⚠ repo "<name>" has no curated docs yet — only live code search is available.` followed by a blank line.

- [ ] **Step 1: Write the failing tests**

Create `tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import {
  getRepoStatus,
  listRepoStatuses,
  readMeta,
  writeMeta,
  stalenessBanner,
} from '../src/registry.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

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

describe('registry', () => {
  let cfg: ExpertConfig;
  let freshSha: string;

  beforeAll(() => {
    const root = makeTempDir('expert-reg-');
    cfg = makeCfg(root);
    // fresh: meta.sha === HEAD
    const fresh = path.join(cfg.reposDir, 'fresh-repo');
    initGitRepo(fresh);
    freshSha = commitFile(fresh, 'a.txt', 'a');
    writeMeta(cfg.knowledgeDir, 'fresh-repo', {
      sha: freshSha,
      curatedAt: '2026-08-10T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: 1,
    });
    // stale: meta.sha differs from HEAD
    const stale = path.join(cfg.reposDir, 'stale-repo');
    initGitRepo(stale);
    commitFile(stale, 'a.txt', 'a');
    writeMeta(cfg.knowledgeDir, 'stale-repo', {
      sha: '0000000000000000000000000000000000000000',
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: 1,
    });
    // uncurated: no meta.json
    const bare = path.join(cfg.reposDir, 'bare-repo');
    initGitRepo(bare);
    commitFile(bare, 'a.txt', 'a');
  });

  it('round-trips meta', () => {
    expect(readMeta(cfg.knowledgeDir, 'fresh-repo')?.sha).toBe(freshSha);
    expect(readMeta(cfg.knowledgeDir, 'nope')).toBeNull();
  });

  it('computes fresh, stale, and uncurated states', async () => {
    expect((await getRepoStatus(cfg, 'fresh-repo')).state).toBe('fresh');
    expect((await getRepoStatus(cfg, 'stale-repo')).state).toBe('stale');
    expect((await getRepoStatus(cfg, 'bare-repo')).state).toBe('uncurated');
  });

  it('lists all mirrored repos sorted by name', async () => {
    const names = (await listRepoStatuses(cfg)).map((s) => s.name);
    expect(names).toEqual(['bare-repo', 'fresh-repo', 'stale-repo']);
  });

  it('builds staleness banners', async () => {
    expect(stalenessBanner(await getRepoStatus(cfg, 'fresh-repo'))).toBe('');
    expect(stalenessBanner(await getRepoStatus(cfg, 'stale-repo'))).toContain(
      'trust live search over summaries',
    );
    expect(stalenessBanner(await getRepoStatus(cfg, 'bare-repo'))).toContain(
      'no curated docs yet',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { revParseHead } from './git.js';
import type { ExpertConfig } from './config.js';

export type RepoState = 'fresh' | 'stale' | 'uncurated';

export interface RepoMeta {
  sha: string;
  curatedAt: string;
  model: string;
  docVersion: number;
}

export interface RepoStatus {
  name: string;
  path: string;
  currentSha: string;
  curatedSha: string | null;
  curatedAt: string | null;
  state: RepoState;
}

function metaPath(knowledgeDir: string, name: string): string {
  return path.join(knowledgeDir, 'repos', name, 'meta.json');
}

export function readMeta(knowledgeDir: string, name: string): RepoMeta | null {
  const p = metaPath(knowledgeDir, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as RepoMeta;
}

export function writeMeta(knowledgeDir: string, name: string, meta: RepoMeta): void {
  const p = metaPath(knowledgeDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

export async function getRepoStatus(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  const repoPath = path.join(cfg.reposDir, name);
  const currentSha = await revParseHead(repoPath);
  const meta = readMeta(cfg.knowledgeDir, name);
  const state: RepoState = meta === null ? 'uncurated' : meta.sha === currentSha ? 'fresh' : 'stale';
  return {
    name,
    path: repoPath,
    currentSha,
    curatedSha: meta?.sha ?? null,
    curatedAt: meta?.curatedAt ?? null,
    state,
  };
}

export async function listRepoStatuses(cfg: ExpertConfig): Promise<RepoStatus[]> {
  if (!fs.existsSync(cfg.reposDir)) return [];
  const names = fs
    .readdirSync(cfg.reposDir)
    .filter((n) => fs.existsSync(path.join(cfg.reposDir, n, '.git')))
    .sort();
  const out: RepoStatus[] = [];
  for (const name of names) out.push(await getRepoStatus(cfg, name));
  return out;
}

export function stalenessBanner(status: RepoStatus): string {
  if (status.state === 'fresh') return '';
  if (status.state === 'uncurated') {
    return `⚠ repo "${status.name}" has no curated docs yet — only live code search is available.\n\n`;
  }
  return `⚠ docs curated at ${status.curatedSha!.slice(0, 7)}, repo now at ${status.currentSha.slice(0, 7)} — trust live search over summaries.\n\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat: repo registry with staleness computation and banners"
```

---

### Task 4: `expert sync` + `expert status` CLI

**Files:**
- Create: `src/cli/sync.ts`, `src/cli/status.ts`, `src/cli/index.ts`
- Test: `tests/sync.test.ts`, `tests/status.test.ts`

**Interfaces:**
- Consumes: `listGithubRepos`, `cloneRepo`, `updateMirror`, `RemoteRepo` from `../git.js`; `ExpertConfig`, `loadConfig`; `listRepoStatuses`, `RepoStatus`.
- Produces:
  - `src/cli/sync.ts`: `interface SyncDeps { listRemote(user: string): Promise<RemoteRepo[]>; clone(url: string, dest: string): Promise<void>; update(dir: string, branch: string): Promise<void> }`, `interface SyncResult { synced: string[]; skipped: string[]; failed: { name: string; error: string }[] }`, `syncRepos(cfg: ExpertConfig, deps?: SyncDeps): Promise<SyncResult>`
  - `src/cli/status.ts`: `formatStatus(statuses: RepoStatus[]): string`
  - `src/cli/index.ts`: commander program with `sync` and `status` subcommands (`curate` and `mcp` are added in Tasks 8 and 10).

- [ ] **Step 1: Write the failing sync tests**

Create `tests/sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import type { RemoteRepo } from '../src/git.js';
import { syncRepos, type SyncDeps } from '../src/cli/sync.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

function makeCfg(root: string, extra: Partial<ExpertConfig> = {}): ExpertConfig {
  return {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
    ...extra,
  };
}

const remote = (name: string, isArchived = false): RemoteRepo => ({
  name,
  url: `https://github.com/u/${name}`,
  defaultBranch: 'main',
  isArchived,
});

describe('syncRepos', () => {
  it('clones missing repos, updates existing ones, skips excluded and archived', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root, { excludeRepos: ['skip-me'] });
    const existing = path.join(cfg.reposDir, 'have-it');
    initGitRepo(existing);
    commitFile(existing, 'a.txt', 'a');

    const calls: string[] = [];
    const deps: SyncDeps = {
      listRemote: async () => [remote('new-one'), remote('have-it'), remote('skip-me'), remote('old', true)],
      clone: async (_url, dest) => {
        calls.push(`clone:${path.basename(dest)}`);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async (dir) => {
        calls.push(`update:${path.basename(dir)}`);
      },
    };

    const res = await syncRepos(cfg, deps);
    expect(calls.sort()).toEqual(['clone:new-one', 'update:have-it']);
    expect(res.synced.sort()).toEqual(['have-it', 'new-one']);
    expect(res.skipped.sort()).toEqual(['old', 'skip-me']);
    expect(res.failed).toEqual([]);
  });

  it('collects per-repo failures and continues the batch', async () => {
    const root = makeTempDir('expert-sync-');
    const cfg = makeCfg(root);
    const deps: SyncDeps = {
      listRemote: async () => [remote('bad'), remote('good')],
      clone: async (_url, dest) => {
        if (dest.endsWith('bad')) throw new Error('network down');
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      },
      update: async () => {},
    };
    const res = await syncRepos(cfg, deps);
    expect(res.synced).toEqual(['good']);
    expect(res.failed).toEqual([{ name: 'bad', error: 'network down' }]);
  });
});
```

- [ ] **Step 2: Write the failing status test**

Create `tests/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatStatus } from '../src/cli/status.js';
import type { RepoStatus } from '../src/registry.js';

const status = (name: string, state: RepoStatus['state']): RepoStatus => ({
  name,
  path: `/repos/${name}`,
  currentSha: 'abcdef1234567890',
  curatedSha: state === 'uncurated' ? null : 'fedcba0987654321',
  curatedAt: state === 'uncurated' ? null : '2026-08-10T00:00:00Z',
  state,
});

describe('formatStatus', () => {
  it('renders one line per repo with state, head, and curated sha', () => {
    const out = formatStatus([status('alpha', 'fresh'), status('beta', 'uncurated')]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('fresh');
    expect(lines[0]).toContain('alpha');
    expect(lines[0]).toContain('abcdef1');
    expect(lines[1]).toContain('uncurated');
    expect(lines[1]).toContain('-');
  });

  it('tells the user to sync when there are no repos', () => {
    expect(formatStatus([])).toContain('expert sync');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/sync.test.ts tests/status.test.ts`
Expected: FAIL — cannot resolve `../src/cli/sync.js` / `../src/cli/status.js`.

- [ ] **Step 4: Implement `src/cli/sync.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { listGithubRepos, cloneRepo, updateMirror, type RemoteRepo } from '../git.js';
import type { ExpertConfig } from '../config.js';

export interface SyncDeps {
  listRemote(user: string): Promise<RemoteRepo[]>;
  clone(url: string, dest: string): Promise<void>;
  update(dir: string, branch: string): Promise<void>;
}

const realDeps: SyncDeps = {
  listRemote: listGithubRepos,
  clone: cloneRepo,
  update: updateMirror,
};

export interface SyncResult {
  synced: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

export async function syncRepos(cfg: ExpertConfig, deps: SyncDeps = realDeps): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [] };
  const remote = await deps.listRemote(cfg.githubUser);
  fs.mkdirSync(cfg.reposDir, { recursive: true });
  for (const repo of remote) {
    if (cfg.excludeRepos.includes(repo.name) || (repo.isArchived && !cfg.includeArchived)) {
      result.skipped.push(repo.name);
      continue;
    }
    const dest = path.join(cfg.reposDir, repo.name);
    try {
      if (fs.existsSync(path.join(dest, '.git'))) {
        await deps.update(dest, repo.defaultBranch);
      } else {
        await deps.clone(repo.url, dest);
      }
      result.synced.push(repo.name);
    } catch (err) {
      result.failed.push({ name: repo.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
```

- [ ] **Step 5: Implement `src/cli/status.ts`**

```ts
import type { RepoStatus } from '../registry.js';

export function formatStatus(statuses: RepoStatus[]): string {
  if (statuses.length === 0) return 'No repos mirrored yet. Run `expert sync` first.';
  return statuses
    .map((s) => {
      const curated = s.curatedSha ? s.curatedSha.slice(0, 7) : '-';
      return `${s.state.padEnd(10)} ${s.name.padEnd(32)} head ${s.currentSha.slice(0, 7)}  curated ${curated}`;
    })
    .join('\n');
}
```

- [ ] **Step 6: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses } from '../registry.js';

const program = new Command();

program.name('expert').description('Agent-curated expert on all your GitHub repos').version('0.1.0');

program
  .command('sync')
  .description('Clone or update all GitHub repos into the mirror folder')
  .action(async () => {
    const cfg = loadConfig();
    const res = await syncRepos(cfg);
    console.log(`synced ${res.synced.length}, skipped ${res.skipped.length}, failed ${res.failed.length}`);
    for (const f of res.failed) console.error(`  FAILED ${f.name}: ${f.error}`);
    if (res.failed.length > 0) process.exitCode = 1;
  });

program
  .command('status')
  .description('Show curation status for every mirrored repo')
  .action(async () => {
    const cfg = loadConfig();
    console.log(formatStatus(await listRepoStatuses(cfg)));
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/sync.test.ts tests/status.test.ts`
Expected: 4 passing. Also smoke-check the CLI parses: `npx tsx src/cli/index.ts --help` prints the two subcommands.

- [ ] **Step 8: Commit**

```bash
git add src/cli/ tests/sync.test.ts tests/status.test.ts
git commit -m "feat: expert sync and expert status commands"
```

---

### Task 5: Ripgrep wrapper

**Files:**
- Create: `src/rg.ts`
- Test: `tests/rg.test.ts`

**Interfaces:**
- Consumes: `rgPath` from `@vscode/ripgrep`.
- Produces (exported from `src/rg.ts`):
  - `const MAX_MATCHES = 100`
  - `searchText(root: string, query: string, glob?: string): Promise<string>` — runs rg with `cwd: root` so match paths are relative; returns `'No matches.'` on rg exit code 1; caps output at `MAX_MATCHES` lines and appends `… truncated to first 100 results.` when capped. Query is treated as a regex by rg; invalid patterns reject with rg's stderr in the error.
  - `listFiles(root: string, pattern: string): Promise<string>` — `rg --files -g <pattern>`, same capping, `'No matches.'` when empty.

- [ ] **Step 1: Write the failing tests**

Create `tests/rg.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchText, listFiles, MAX_MATCHES } from '../src/rg.js';
import { makeTempDir } from './helpers.js';

describe('ripgrep wrapper', () => {
  let root: string;

  beforeAll(() => {
    root = makeTempDir('expert-rg-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'function login() {}\n');
    fs.writeFileSync(path.join(root, 'readme.md'), 'docs about login flows\n');
    const many = Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n');
    fs.writeFileSync(path.join(root, 'big.txt'), many + '\n');
  });

  it('finds matches with relative paths and line numbers', async () => {
    const out = await searchText(root, 'login');
    expect(out).toContain('auth.ts');
    expect(out).toContain('readme.md');
    expect(out).toMatch(/auth\.ts:1:/);
  });

  it('filters with a glob', async () => {
    const out = await searchText(root, 'login', '*.ts');
    expect(out).toContain('auth.ts');
    expect(out).not.toContain('readme.md');
  });

  it('returns "No matches." on zero hits', async () => {
    expect(await searchText(root, 'zebra-unicorn')).toBe('No matches.');
  });

  it('caps results at MAX_MATCHES lines', async () => {
    const out = await searchText(root, 'needle');
    const lines = out.split('\n');
    expect(lines.length).toBe(MAX_MATCHES + 1);
    expect(lines.at(-1)).toContain('truncated');
  });

  it('lists files by glob', async () => {
    const out = await listFiles(root, '*.ts');
    expect(out).toContain(path.join('src', 'auth.ts'));
    expect(out).not.toContain('readme.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rg.test.ts`
Expected: FAIL — cannot resolve `../src/rg.js`.

- [ ] **Step 3: Implement `src/rg.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';

const run = promisify(execFile);
export const MAX_MATCHES = 100;

function capLines(text: string): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length <= MAX_MATCHES) return lines.join('\n');
  return lines.slice(0, MAX_MATCHES).join('\n') + `\n… truncated to first ${MAX_MATCHES} results.`;
}

async function rg(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run(rgPath, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    if (e.code === 1) return ''; // rg exit 1 = no matches
    throw new Error(`ripgrep failed: ${e.stderr ?? String(err)}`);
  }
}

export async function searchText(root: string, query: string, glob?: string): Promise<string> {
  const args = ['-n', '--no-heading', '-S', '--max-columns', '250'];
  if (glob) args.push('-g', glob);
  args.push('--', query, '.');
  const out = await rg(args, root);
  return out.length === 0 ? 'No matches.' : capLines(out);
}

export async function listFiles(root: string, pattern: string): Promise<string> {
  const out = await rg(['--files', '-g', pattern], root);
  return out.length === 0 ? 'No matches.' : capLines(out);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rg.test.ts`
Expected: 5 passing. (Windows note: rg emits `.\src\auth.ts`-style relative paths; the tests only assert substrings, which is why they pass on both separators.)

- [ ] **Step 5: Commit**

```bash
git add src/rg.ts tests/rg.test.ts
git commit -m "feat: capped ripgrep search wrapper"
```

---

### Task 6: Read guards (path traversal + caps)

**Files:**
- Create: `src/mcp/guards.ts`
- Test: `tests/guards.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (exported from `src/mcp/guards.ts`):
  - `const MAX_READ_LINES = 2000`, `const MAX_READ_BYTES = 200 * 1024`
  - `resolveWithin(rootDir: string, relPath: string): string` — resolves and throws `Error('Path escapes repository: <relPath>')` if the result leaves `rootDir`.
  - `readFileCapped(absPath: string, startLine?: number, endLine?: number): string` — 1-based inclusive line range; enforces both caps; appends `… truncated (2,000-line / 200 KB cap).` when truncated; throws on files over 5 MB.

- [ ] **Step 1: Write the failing tests**

Create `tests/guards.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin, readFileCapped, MAX_READ_LINES } from '../src/mcp/guards.js';
import { makeTempDir } from './helpers.js';

describe('resolveWithin', () => {
  const root = 'C:/some/repo';
  it('resolves paths inside the root', () => {
    expect(resolveWithin(root, 'src/index.ts')).toBe(path.resolve(root, 'src/index.ts'));
  });
  it('rejects traversal outside the root', () => {
    expect(() => resolveWithin(root, '../secrets.txt')).toThrow(/escapes/);
    expect(() => resolveWithin(root, 'src/../../other')).toThrow(/escapes/);
  });
  it('rejects absolute paths outside the root', () => {
    expect(() => resolveWithin(root, 'C:/windows/system32')).toThrow(/escapes/);
  });
});

describe('readFileCapped', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir('expert-guard-');
    fs.writeFileSync(path.join(dir, 'small.txt'), 'one\ntwo\nthree\n');
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), big);
  });

  it('reads whole small files without a truncation notice', () => {
    const out = readFileCapped(path.join(dir, 'small.txt'));
    expect(out).toContain('two');
    expect(out).not.toContain('truncated');
  });

  it('honors a 1-based inclusive line range', () => {
    const out = readFileCapped(path.join(dir, 'small.txt'), 2, 3);
    expect(out.startsWith('two')).toBe(true);
    expect(out).toContain('three');
    expect(out).not.toContain('one');
  });

  it('caps at MAX_READ_LINES and appends a notice', () => {
    const out = readFileCapped(path.join(dir, 'big.txt'));
    const lines = out.split('\n');
    expect(lines.length).toBe(MAX_READ_LINES + 1);
    expect(lines.at(-1)).toContain('truncated');
    expect(lines[0]).toBe('line 1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/guards.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/guards.js`.

- [ ] **Step 3: Implement `src/mcp/guards.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/guards.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/guards.ts tests/guards.test.ts
git commit -m "feat: path-traversal guard and capped file reads"
```

---

### Task 7: MCP server — knowledge tools

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp-knowledge.test.ts`, plus shared fixture builder `tests/mcp-fixture.ts`

**Interfaces:**
- Consumes: `ExpertConfig`; `listRepoStatuses`, `getRepoStatus`, `stalenessBanner`, `writeMeta`, `RepoStatus`; test helpers.
- Produces: `createServer(cfg: ExpertConfig): McpServer` from `src/mcp/server.ts`, registering (in this task) `portfolio_overview`, `list_repos`, `get_repo_knowledge`. Task 8 extends the same file with the four search/read tools and `startMcp`. Internal helpers this task defines and Task 8 reuses: `text(t: string)` (returns `{ content: [{ type: 'text', text: t }] }`) and `requireRepo(cfg, name): Promise<RepoStatus>` (throws `Error('Unknown repo "<name>" — call list_repos to see what exists.')` if `<reposDir>/<name>/.git` is missing).
- Fixture builder produces: `makeFixture(): Promise<{ cfg: ExpertConfig; client: Client }>` — a temp project with repos `alpha` (fresh, curated), `beta` (stale, curated), `gamma` (uncurated), knowledge docs, and a connected MCP client over `InMemoryTransport`.

- [ ] **Step 1: Write the fixture builder**

Create `tests/mcp-fixture.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExpertConfig } from '../src/config.js';
import { writeMeta } from '../src/registry.js';
import { createServer } from '../src/mcp/server.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

function writeKnowledge(cfg: ExpertConfig, repo: string, docs: Record<string, string>): void {
  const dir = path.join(cfg.knowledgeDir, 'repos', repo);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

export async function makeFixture(): Promise<{ cfg: ExpertConfig; client: Client }> {
  const root = makeTempDir('expert-mcp-');
  const cfg: ExpertConfig = {
    githubUser: 'u',
    reposDir: path.join(root, 'repos'),
    knowledgeDir: path.join(root, 'knowledge'),
    model: 'claude-sonnet-5',
    excludeRepos: [],
    includeArchived: false,
  };

  // alpha: fresh (meta.sha === HEAD)
  const alpha = path.join(cfg.reposDir, 'alpha');
  initGitRepo(alpha);
  const alphaSha = commitFile(alpha, 'src/hello.ts', 'export const greet = () => "hi";\n');
  writeKnowledge(cfg, 'alpha', {
    'card.md': '# alpha\n\nA tiny greeting library.\n',
    'architecture.md': '# Architecture\n\nSingle module in src/hello.ts.\n',
    'map.md': '# Map\n\n- src/ — the code\n',
    'activity.md': '# Activity\n\nQuiet.\n',
  });
  writeMeta(cfg.knowledgeDir, 'alpha', {
    sha: alphaSha,
    curatedAt: '2026-08-10T00:00:00Z',
    model: 'claude-sonnet-5',
    docVersion: 1,
  });

  // beta: stale (meta.sha differs)
  const beta = path.join(cfg.reposDir, 'beta');
  initGitRepo(beta);
  commitFile(beta, 'main.py', 'print("beta")\n');
  writeKnowledge(cfg, 'beta', {
    'card.md': '# beta\n\nA Python script.\n',
    'architecture.md': '# Architecture\n\nJust main.py.\n',
    'map.md': '# Map\n\n- main.py — everything\n',
    'activity.md': '# Activity\n\nUnknown.\n',
  });
  writeMeta(cfg.knowledgeDir, 'beta', {
    sha: '0000000000000000000000000000000000000000',
    curatedAt: '2026-08-01T00:00:00Z',
    model: 'claude-sonnet-5',
    docVersion: 1,
  });

  // gamma: uncurated
  const gamma = path.join(cfg.reposDir, 'gamma');
  initGitRepo(gamma);
  commitFile(gamma, 'notes.txt', 'todo: everything\n');

  // portfolio docs
  fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.knowledgeDir, 'portfolio.md'), '# Portfolio\n\nalpha, beta, gamma.\n');
  fs.writeFileSync(path.join(cfg.knowledgeDir, 'cross-repo-map.md'), '# Cross-repo\n\nNo links yet.\n');

  const server = createServer(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { cfg, client };
}

export function resultText(res: { content?: unknown }): string {
  const content = res.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}
```

- [ ] **Step 2: Write the failing knowledge-tool tests**

Create `tests/mcp-knowledge.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';

describe('MCP knowledge tools', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('portfolio_overview returns portfolio docs and a staleness summary', async () => {
    const res = await client.callTool({ name: 'portfolio_overview', arguments: {} });
    const text = resultText(res);
    expect(text).toContain('alpha, beta, gamma');
    expect(text).toContain('No links yet');
    expect(text).toContain('stale: beta');
    expect(text).toContain('uncurated: gamma');
  });

  it('list_repos shows every repo with state and one-line summary', async () => {
    const text = resultText(await client.callTool({ name: 'list_repos', arguments: {} }));
    expect(text).toContain('alpha [fresh] — A tiny greeting library.');
    expect(text).toContain('beta [stale]');
    expect(text).toContain('gamma [uncurated]');
  });

  it('get_repo_knowledge returns card by default and honors doc param', async () => {
    const card = resultText(
      await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'alpha' } }),
    );
    expect(card).toContain('greeting library');
    expect(card).not.toContain('⚠');
    const arch = resultText(
      await client.callTool({
        name: 'get_repo_knowledge',
        arguments: { repo: 'alpha', doc: 'architecture' },
      }),
    );
    expect(arch).toContain('src/hello.ts');
  });

  it('prefixes stale repo docs with the staleness banner', async () => {
    const text = resultText(
      await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'beta' } }),
    );
    expect(text).toContain('trust live search over summaries');
    expect(text).toContain('A Python script');
  });

  it('errors on unknown repos', async () => {
    const res = await client.callTool({ name: 'get_repo_knowledge', arguments: { repo: 'nope' } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown repo');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-knowledge.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/server.js`.

- [ ] **Step 4: Implement `src/mcp/server.ts` (knowledge tools only)**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExpertConfig } from '../config.js';
import {
  getRepoStatus,
  listRepoStatuses,
  stalenessBanner,
  type RepoStatus,
} from '../registry.js';

export function text(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: t }] };
}

export async function requireRepo(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  if (!fs.existsSync(path.join(cfg.reposDir, name, '.git'))) {
    throw new Error(`Unknown repo "${name}" — call list_repos to see what exists.`);
  }
  return getRepoStatus(cfg, name);
}

function knowledgeFile(cfg: ExpertConfig, ...segments: string[]): string | null {
  const p = path.join(cfg.knowledgeDir, ...segments);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function cardSummary(cfg: ExpertConfig, name: string): string {
  const card = knowledgeFile(cfg, 'repos', name, 'card.md');
  if (card === null) return '(uncurated)';
  const line = card
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return (line ?? '(empty card)').slice(0, 120);
}

export function createServer(cfg: ExpertConfig): McpServer {
  const server = new McpServer({ name: 'repos-expert', version: '0.1.0' });

  server.registerTool(
    'portfolio_overview',
    {
      description:
        'The whole portfolio: what repos exist, how they fit together, and which docs are stale.',
      inputSchema: {},
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      const stale = statuses.filter((s) => s.state === 'stale').map((s) => s.name);
      const uncurated = statuses.filter((s) => s.state === 'uncurated').map((s) => s.name);
      const parts: string[] = [];
      parts.push(
        knowledgeFile(cfg, 'portfolio.md') ??
          '(portfolio.md not yet curated — run `expert curate --portfolio`)',
      );
      parts.push(
        knowledgeFile(cfg, 'cross-repo-map.md') ??
          '(cross-repo-map.md not yet curated — run `expert curate --portfolio`)',
      );
      parts.push(
        [
          `Repos: ${statuses.length}`,
          `stale: ${stale.length > 0 ? stale.join(', ') : 'none'}`,
          `uncurated: ${uncurated.length > 0 ? uncurated.join(', ') : 'none'}`,
        ].join('\n'),
      );
      return text(parts.join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'list_repos',
    {
      description: 'List every mirrored repo with curation state and a one-line summary.',
      inputSchema: {},
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      if (statuses.length === 0) return text('No repos mirrored. Run `expert sync` first.');
      const lines = statuses.map((s) => `${s.name} [${s.state}] — ${cardSummary(cfg, s.name)}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_repo_knowledge',
    {
      description:
        'Curated knowledge docs for one repo: card (default), architecture, map, or activity.',
      inputSchema: {
        repo: z.string(),
        doc: z.enum(['card', 'architecture', 'map', 'activity']).optional(),
      },
    },
    async ({ repo, doc }) => {
      const status = await requireRepo(cfg, repo);
      const file = `${doc ?? 'card'}.md`;
      const content = knowledgeFile(cfg, 'repos', repo, file);
      if (content === null) {
        return text(`No curated ${file} for "${repo}" yet — run \`expert curate ${repo}\`.`);
      }
      return text(stalenessBanner(status) + content);
    },
  );

  return server;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp-knowledge.test.ts`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp-fixture.ts tests/mcp-knowledge.test.ts
git commit -m "feat: MCP server with portfolio and knowledge tools"
```

---

### Task 8: MCP server — search/read tools + `expert mcp`

**Files:**
- Modify: `src/mcp/server.ts` (add four tools inside `createServer`, before `return server;`; add `startMcp` export)
- Modify: `src/cli/index.ts` (add `mcp` subcommand)
- Test: `tests/mcp-search.test.ts`

**Interfaces:**
- Consumes: `searchText`, `listFiles` from `../rg.js`; `resolveWithin`, `readFileCapped` from `./guards.js`; `text`, `requireRepo`, fixture from Task 7.
- Produces: tools `search_knowledge`, `search_code`, `find_files`, `read_repo_file`; `startMcp(cfg: ExpertConfig): Promise<void>` exported from `src/mcp/server.ts`; `expert mcp` CLI subcommand.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp-search.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeFixture, resultText } from './mcp-fixture.js';

describe('MCP search and read tools', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await makeFixture());
  });

  it('search_code searches all repos, or one repo with a banner when stale', async () => {
    const all = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'greet' } }),
    );
    expect(all).toContain('hello.ts');

    const one = resultText(
      await client.callTool({ name: 'search_code', arguments: { query: 'beta', repo: 'beta' } }),
    );
    expect(one).toContain('main.py');
    expect(one).toContain('trust live search over summaries');
  });

  it('search_knowledge searches the curated docs', async () => {
    const out = resultText(
      await client.callTool({ name: 'search_knowledge', arguments: { query: 'greeting library' } }),
    );
    expect(out).toContain('card.md');
  });

  it('find_files globs within one repo', async () => {
    const out = resultText(
      await client.callTool({ name: 'find_files', arguments: { pattern: '*.ts', repo: 'alpha' } }),
    );
    expect(out).toContain('hello.ts');
    expect(out).not.toContain('main.py');
  });

  it('read_repo_file returns content and honors line ranges', async () => {
    const out = resultText(
      await client.callTool({
        name: 'read_repo_file',
        arguments: { repo: 'alpha', path: 'src/hello.ts' },
      }),
    );
    expect(out).toContain('export const greet');
  });

  it('read_repo_file blocks path traversal', async () => {
    const res = await client.callTool({
      name: 'read_repo_file',
      arguments: { repo: 'alpha', path: '../beta/main.py' },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('escapes');
  });

  it('search_code errors on unknown repo', async () => {
    const res = await client.callTool({
      name: 'search_code',
      arguments: { query: 'x', repo: 'nope' },
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-search.test.ts`
Expected: FAIL — tools not found (`search_code` not registered).

- [ ] **Step 3: Add the four tools to `createServer` in `src/mcp/server.ts`**

Add imports at the top:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { searchText, listFiles } from '../rg.js';
import { resolveWithin, readFileCapped } from './guards.js';
```

Insert before `return server;`:

```ts
  server.registerTool(
    'search_knowledge',
    {
      description: 'Full-text search across all curated knowledge docs.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => text(await searchText(cfg.knowledgeDir, query)),
  );

  server.registerTool(
    'search_code',
    {
      description:
        'Live ripgrep over the repo mirrors. Searches all repos unless "repo" is given. "glob" filters file names (e.g. *.ts).',
      inputSchema: { query: z.string(), repo: z.string().optional(), glob: z.string().optional() },
    },
    async ({ query, repo, glob }) => {
      if (repo === undefined) return text(await searchText(cfg.reposDir, query, glob));
      const status = await requireRepo(cfg, repo);
      return text(stalenessBanner(status) + (await searchText(status.path, query, glob)));
    },
  );

  server.registerTool(
    'find_files',
    {
      description: 'List files matching a glob pattern, in one repo or all mirrors.',
      inputSchema: { pattern: z.string(), repo: z.string().optional() },
    },
    async ({ pattern, repo }) => {
      const root = repo === undefined ? cfg.reposDir : (await requireRepo(cfg, repo)).path;
      return text(await listFiles(root, pattern));
    },
  );

  server.registerTool(
    'read_repo_file',
    {
      description:
        'Read one file from a repo mirror (max 2,000 lines / 200 KB). Lines are 1-based inclusive.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
    },
    async ({ repo, path: relPath, startLine, endLine }) => {
      const status = await requireRepo(cfg, repo);
      const abs = resolveWithin(status.path, relPath);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found in "${repo}": ${relPath}`);
      }
      return text(stalenessBanner(status) + readFileCapped(abs, startLine, endLine));
    },
  );
```

Add after `createServer`:

```ts
export async function startMcp(cfg: ExpertConfig): Promise<void> {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Add the `mcp` subcommand to `src/cli/index.ts`**

Add import:

```ts
import { startMcp } from '../mcp/server.js';
```

Add before `program.parseAsync()`:

```ts
program
  .command('mcp')
  .description('Start the MCP server on stdio (for `claude mcp add`)')
  .action(async () => {
    const cfg = loadConfig();
    await startMcp(cfg);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp-search.test.ts tests/mcp-knowledge.test.ts`
Expected: all passing (search tests plus the Task 7 suite still green).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/cli/index.ts tests/mcp-search.test.ts
git commit -m "feat: MCP search/read tools and expert mcp command"
```

---

### Task 9: Curation prompts and doc parsing

**Files:**
- Create: `src/curator/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (exported from `src/curator/prompts.ts`):
  - `const DOC_FILES = ['card.md', 'architecture.md', 'map.md', 'activity.md'] as const`
  - `interface RepoContext { name: string; gitLog: string; branches: string; previousDocs?: Record<string, string>; changesSincePrevious?: string }`
  - `buildRepoPrompt(ctx: RepoContext): string`
  - `interface PortfolioContext { cards: Record<string, string>; manifests: Record<string, string> }`
  - `buildPortfolioPrompt(ctx: PortfolioContext): string`
  - `parseCuratedDocs(output: string, expected: readonly string[]): Record<string, string>` — splits on `===FILE: <name>===` marker lines; throws `Error('Curator output missing docs: <names>')` listing every expected doc that is absent or empty.

- [ ] **Step 1: Write the failing tests**

Create `tests/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DOC_FILES,
  buildRepoPrompt,
  buildPortfolioPrompt,
  parseCuratedDocs,
} from '../src/curator/prompts.js';

describe('parseCuratedDocs', () => {
  it('extracts docs delimited by FILE markers', () => {
    const output = [
      'Some preamble the model wrote.',
      '===FILE: card.md===',
      '# card',
      'body',
      '===FILE: architecture.md===',
      '# arch',
    ].join('\n');
    const docs = parseCuratedDocs(output, ['card.md', 'architecture.md']);
    expect(docs['card.md']).toBe('# card\nbody');
    expect(docs['architecture.md']).toBe('# arch');
  });

  it('throws listing every missing or empty doc', () => {
    const output = '===FILE: card.md===\n# card\n===FILE: map.md===\n\n';
    expect(() => parseCuratedDocs(output, DOC_FILES)).toThrow(
      /architecture\.md.*map\.md.*activity\.md|missing docs/,
    );
  });
});

describe('buildRepoPrompt', () => {
  it('includes name, git context, templates, and marker instructions', () => {
    const p = buildRepoPrompt({ name: 'alpha', gitLog: 'abc first', branches: '* main' });
    expect(p).toContain('"alpha"');
    expect(p).toContain('abc first');
    expect(p).toContain('===FILE: card.md===');
    expect(p).toContain('architecture.md');
    expect(p).not.toContain('Previous docs');
  });

  it('switches to update mode when previous docs exist', () => {
    const p = buildRepoPrompt({
      name: 'alpha',
      gitLog: 'abc first',
      branches: '* main',
      previousDocs: { 'card.md': 'old card body' },
      changesSincePrevious: 'abc..def 3 files changed',
    });
    expect(p).toContain('Previous docs');
    expect(p).toContain('old card body');
    expect(p).toContain('3 files changed');
  });
});

describe('buildPortfolioPrompt', () => {
  it('includes every card and manifest and asks for the two portfolio docs', () => {
    const p = buildPortfolioPrompt({
      cards: { alpha: 'alpha card' },
      manifests: { 'alpha/package.json': '{"name":"alpha"}' },
    });
    expect(p).toContain('alpha card');
    expect(p).toContain('"name":"alpha"');
    expect(p).toContain('===FILE: portfolio.md===');
    expect(p).toContain('cross-repo-map.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — cannot resolve `../src/curator/prompts.js`.

- [ ] **Step 3: Implement `src/curator/prompts.ts`**

```ts
export const DOC_FILES = ['card.md', 'architecture.md', 'map.md', 'activity.md'] as const;

export interface RepoContext {
  name: string;
  gitLog: string;
  branches: string;
  previousDocs?: Record<string, string>;
  changesSincePrevious?: string;
}

export interface PortfolioContext {
  cards: Record<string, string>;
  manifests: Record<string, string>;
}

const TEMPLATES = `Required sections per document:
- card.md: Purpose · Tech stack · Status (active/dormant/archived) · Entry points · How to run · Related repos
- architecture.md: Overview · Key modules (with paths) · Data flow · External dependencies/services · Design decisions & conventions
- map.md: Annotated directory tree — for each significant directory/file, one line on what happens there
- activity.md: Recent focus (from git log) · Open branches and what they contain · Apparent unfinished work / TODOs`;

const OUTPUT_RULES = (files: readonly string[]) => `Output ONLY the documents, each preceded by its marker line, nothing after the last document:
${files.map((f) => `===FILE: ${f}===`).join('\n[document content]\n')}
[document content]`;

export function buildRepoPrompt(ctx: RepoContext): string {
  const parts: string[] = [];
  parts.push(
    `You are curating an expert knowledge-base entry for the repository "${ctx.name}".`,
    `Explore the repository with your Read, Glob, and Grep tools until you understand what it does, how it is built, and where things happen. Be concrete: cite real paths.`,
    TEMPLATES,
    `Git context (pre-computed for you):\n\nRecent commits:\n${ctx.gitLog}\n\nBranches:\n${ctx.branches}`,
  );
  if (ctx.previousDocs !== undefined) {
    const prev = Object.entries(ctx.previousDocs)
      .map(([file, body]) => `--- ${file} ---\n${body}`)
      .join('\n\n');
    parts.push(
      `Previous docs exist. UPDATE them rather than rewriting from scratch — preserve still-valid insight, revise what changed.\n\nChanges since last curation:\n${ctx.changesSincePrevious ?? '(none recorded)'}\n\nPrevious docs:\n${prev}`,
    );
  }
  parts.push(OUTPUT_RULES(DOC_FILES));
  return parts.join('\n\n');
}

export function buildPortfolioPrompt(ctx: PortfolioContext): string {
  const cards = Object.entries(ctx.cards)
    .map(([name, body]) => `--- card: ${name} ---\n${body}`)
    .join('\n\n');
  const manifests = Object.entries(ctx.manifests)
    .map(([name, body]) => `--- manifest: ${name} ---\n${body}`)
    .join('\n\n');
  return [
    `You are curating the portfolio-level knowledge for a collection of repositories owned by one developer.`,
    `Write two documents:
- portfolio.md: what repos exist, what each is for (one line each), how they group into themes, overall status of the portfolio.
- cross-repo-map.md: dependencies and relationships between the repos — shared libraries, one repo consuming another, shared patterns or conventions, data flowing between them. Cite evidence from the cards and manifests.`,
    `Repo cards:\n\n${cards}`,
    `Manifests:\n\n${manifests}`,
    OUTPUT_RULES(['portfolio.md', 'cross-repo-map.md']),
  ].join('\n\n');
}

export function parseCuratedDocs(
  output: string,
  expected: readonly string[],
): Record<string, string> {
  const re = /^===FILE: (.+?)===\r?$/gm;
  const markers: { name: string; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    markers.push({ name: m[1].trim(), contentStart: m.index + m[0].length });
  }
  const docs: Record<string, string> = {};
  markers.forEach((marker, i) => {
    const next = markers[i + 1];
    const end = next === undefined ? output.length : output.lastIndexOf('===FILE:', next.contentStart);
    docs[marker.name] = output.slice(marker.contentStart, end).trim();
  });
  const missing = expected.filter((f) => docs[f] === undefined || docs[f].length === 0);
  if (missing.length > 0) {
    throw new Error(`Curator output missing docs: ${missing.join(', ')}`);
  }
  return docs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prompts.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/curator/prompts.ts tests/prompts.test.ts
git commit -m "feat: curation prompt builders and doc parser"
```

---

### Task 10: Curator runner + `expert curate`

**Files:**
- Create: `src/curator/curator.ts`
- Modify: `src/cli/index.ts` (add `curate` subcommand)
- Test: `tests/curator.test.ts`

**Interfaces:**
- Consumes: `buildRepoPrompt`, `buildPortfolioPrompt`, `parseCuratedDocs`, `DOC_FILES`, `RepoContext`; `gitLogOneline`, `gitLogRangeStat`, `listBranches`; `writeMeta`, `getRepoStatus`, `listRepoStatuses`, `RepoStatus`; `ExpertConfig`.
- Produces (exported from `src/curator/curator.ts`):
  - `interface RunOpts { cwd: string; model: string; timeoutMs: number }`
  - `type AgentRunner = (prompt: string, opts: RunOpts) => Promise<string>`
  - `const runClaudeAgent: AgentRunner` — real Agent SDK runner (read-only tools, abort on timeout)
  - `const DOC_VERSION = 1`, `const CURATE_TIMEOUT_MS = 600_000`
  - `curateRepo(cfg: ExpertConfig, status: RepoStatus, runner?: AgentRunner): Promise<void>`
  - `curatePortfolio(cfg: ExpertConfig, runner?: AgentRunner): Promise<void>`
- CLI: `expert curate [repo] [--all] [--stale] [--portfolio]`. `--all`/`--stale` curate the matching repos sequentially (per-repo try/catch: report, continue, exit code 1 on any failure) then run the portfolio pass; a bare `[repo]` curates that one repo only; `--portfolio` alone runs only the portfolio pass.

- [ ] **Step 1: Write the failing tests (fake runner — no API calls)**

Create `tests/curator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpertConfig } from '../src/config.js';
import { getRepoStatus, readMeta, writeMeta } from '../src/registry.js';
import { curateRepo, curatePortfolio, DOC_VERSION } from '../src/curator/curator.js';
import { makeTempDir, initGitRepo, commitFile } from './helpers.js';

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

const fourDocs = [
  '===FILE: card.md===\n# card body',
  '===FILE: architecture.md===\n# arch body',
  '===FILE: map.md===\n# map body',
  '===FILE: activity.md===\n# activity body',
].join('\n');

describe('curateRepo', () => {
  it('writes all four docs and stamps meta with HEAD sha', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const sha = commitFile(repo, 'a.ts', 'x', 'init');
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return fourDocs;
    });
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    expect(fs.readFileSync(path.join(dir, 'card.md'), 'utf8')).toContain('card body');
    expect(fs.readFileSync(path.join(dir, 'activity.md'), 'utf8')).toContain('activity body');
    const meta = readMeta(cfg.knowledgeDir, 'alpha');
    expect(meta?.sha).toBe(sha);
    expect(meta?.docVersion).toBe(DOC_VERSION);
    expect(prompts[0]).toContain('"alpha"');
    expect(prompts[0]).not.toContain('Previous docs');
  });

  it('passes previous docs and change log in incremental mode', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const firstSha = commitFile(repo, 'a.ts', 'x', 'init');
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'OLD CARD CONTENT');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha: firstSha,
      curatedAt: '2026-08-01T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    commitFile(repo, 'b.ts', 'y', 'second commit');
    const prompts: string[] = [];
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async (prompt) => {
      prompts.push(prompt);
      return fourDocs;
    });
    expect(prompts[0]).toContain('OLD CARD CONTENT');
    expect(prompts[0]).toContain('second commit');
  });

  it('retries once, then leaves the repo uncurated on repeated failure', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    commitFile(repo, 'a.ts', 'x');
    let attempts = 0;
    await expect(
      curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
        attempts += 1;
        throw new Error('agent exploded');
      }),
    ).rejects.toThrow('agent exploded');
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).toBeNull();
  });

  it('succeeds when the retry succeeds', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    commitFile(repo, 'a.ts', 'x');
    let attempts = 0;
    await curateRepo(cfg, await getRepoStatus(cfg, 'alpha'), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return fourDocs;
    });
    expect(attempts).toBe(2);
    expect(readMeta(cfg.knowledgeDir, 'alpha')).not.toBeNull();
  });
});

describe('curatePortfolio', () => {
  it('writes portfolio docs from cards and manifests and stamps portfolio-meta', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    const repo = path.join(cfg.reposDir, 'alpha');
    initGitRepo(repo);
    const sha = commitFile(repo, 'package.json', '{"name":"alpha-pkg"}');
    const dir = path.join(cfg.knowledgeDir, 'repos', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.md'), 'alpha does things');
    writeMeta(cfg.knowledgeDir, 'alpha', {
      sha,
      curatedAt: '2026-08-10T00:00:00Z',
      model: 'claude-sonnet-5',
      docVersion: DOC_VERSION,
    });
    const prompts: string[] = [];
    await curatePortfolio(cfg, async (prompt) => {
      prompts.push(prompt);
      return '===FILE: portfolio.md===\nthe portfolio\n===FILE: cross-repo-map.md===\nthe map';
    });
    expect(prompts[0]).toContain('alpha does things');
    expect(prompts[0]).toContain('alpha-pkg');
    expect(fs.readFileSync(path.join(cfg.knowledgeDir, 'portfolio.md'), 'utf8')).toContain(
      'the portfolio',
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(cfg.knowledgeDir, 'portfolio-meta.json'), 'utf8'),
    );
    expect(meta.repos.alpha).toBe(sha);
  });

  it('throws when no repos are curated yet', async () => {
    const root = makeTempDir('expert-cur-');
    const cfg = makeCfg(root);
    fs.mkdirSync(cfg.reposDir, { recursive: true });
    await expect(curatePortfolio(cfg, async () => '')).rejects.toThrow(/curate --all/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/curator.test.ts`
Expected: FAIL — cannot resolve `../src/curator/curator.js`.

- [ ] **Step 3: Implement `src/curator/curator.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ExpertConfig } from '../config.js';
import { gitLogOneline, gitLogRangeStat, listBranches } from '../git.js';
import {
  listRepoStatuses,
  writeMeta,
  type RepoStatus,
} from '../registry.js';
import {
  DOC_FILES,
  buildRepoPrompt,
  buildPortfolioPrompt,
  parseCuratedDocs,
  type RepoContext,
} from './prompts.js';

export const DOC_VERSION = 1;
export const CURATE_TIMEOUT_MS = 600_000;

export interface RunOpts {
  cwd: string;
  model: string;
  timeoutMs: number;
}

export type AgentRunner = (prompt: string, opts: RunOpts) => Promise<string>;

export const runClaudeAgent: AgentRunner = async (prompt, opts) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  try {
    const stream = query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        abortController: abort,
      },
    });
    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') return message.result;
        throw new Error(`Curator agent failed: ${message.subtype}`);
      }
    }
    throw new Error('Curator agent produced no result message');
  } finally {
    clearTimeout(timer);
  }
};

async function onceWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

function readExistingDocs(knowledgeDir: string, name: string): Record<string, string> | undefined {
  const dir = path.join(knowledgeDir, 'repos', name);
  const docs: Record<string, string> = {};
  for (const file of DOC_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) docs[file] = fs.readFileSync(p, 'utf8');
  }
  return Object.keys(docs).length > 0 ? docs : undefined;
}

export async function curateRepo(
  cfg: ExpertConfig,
  status: RepoStatus,
  runner: AgentRunner = runClaudeAgent,
): Promise<void> {
  const ctx: RepoContext = {
    name: status.name,
    gitLog: await gitLogOneline(status.path, 30),
    branches: await listBranches(status.path),
  };
  if (status.curatedSha !== null) {
    ctx.previousDocs = readExistingDocs(cfg.knowledgeDir, status.name);
    ctx.changesSincePrevious = await gitLogRangeStat(status.path, status.curatedSha);
  }
  const prompt = buildRepoPrompt(ctx);
  const docs = await onceWithRetry(async () => {
    const output = await runner(prompt, {
      cwd: status.path,
      model: cfg.model,
      timeoutMs: CURATE_TIMEOUT_MS,
    });
    return parseCuratedDocs(output, DOC_FILES);
  });
  const dir = path.join(cfg.knowledgeDir, 'repos', status.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(dir, file), content + '\n');
  }
  writeMeta(cfg.knowledgeDir, status.name, {
    sha: status.currentSha,
    curatedAt: new Date().toISOString(),
    model: cfg.model,
    docVersion: DOC_VERSION,
  });
}

const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

export async function curatePortfolio(
  cfg: ExpertConfig,
  runner: AgentRunner = runClaudeAgent,
): Promise<void> {
  const statuses = await listRepoStatuses(cfg);
  const curated = statuses.filter((s) => s.curatedSha !== null);
  if (curated.length === 0) {
    throw new Error('No curated repos yet — run `expert curate --all` first.');
  }
  const cards: Record<string, string> = {};
  const manifests: Record<string, string> = {};
  for (const s of curated) {
    cards[s.name] = fs.readFileSync(path.join(cfg.knowledgeDir, 'repos', s.name, 'card.md'), 'utf8');
    for (const mf of MANIFEST_FILES) {
      const p = path.join(s.path, mf);
      if (fs.existsSync(p)) manifests[`${s.name}/${mf}`] = fs.readFileSync(p, 'utf8').slice(0, 4000);
    }
  }
  const prompt = buildPortfolioPrompt({ cards, manifests });
  const docs = await onceWithRetry(async () => {
    const output = await runner(prompt, {
      cwd: cfg.reposDir,
      model: cfg.model,
      timeoutMs: CURATE_TIMEOUT_MS,
    });
    return parseCuratedDocs(output, ['portfolio.md', 'cross-repo-map.md']);
  });
  fs.mkdirSync(cfg.knowledgeDir, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(cfg.knowledgeDir, file), content + '\n');
  }
  const repoShas: Record<string, string> = {};
  for (const s of curated) repoShas[s.name] = s.curatedSha as string;
  fs.writeFileSync(
    path.join(cfg.knowledgeDir, 'portfolio-meta.json'),
    JSON.stringify({ curatedAt: new Date().toISOString(), repos: repoShas }, null, 2),
  );
}
```

- [ ] **Step 4: Add the `curate` subcommand to `src/cli/index.ts`**

Add imports:

```ts
import { curateRepo, curatePortfolio } from '../curator/curator.js';
import { getRepoStatus } from '../registry.js';
```

(Adjust the existing registry import to include `getRepoStatus` alongside `listRepoStatuses`.)

Add before `program.parseAsync()`:

```ts
program
  .command('curate')
  .description('Run the curator agent to (re)write knowledge docs')
  .argument('[repo]', 'curate a single repo')
  .option('--all', 'curate every mirrored repo, then the portfolio')
  .option('--stale', 'curate only stale/uncurated repos, then the portfolio')
  .option('--portfolio', 'run only the portfolio pass')
  .action(async (repoArg: string | undefined, opts: { all?: boolean; stale?: boolean; portfolio?: boolean }) => {
    const cfg = loadConfig();
    let failures = 0;

    if (repoArg !== undefined) {
      await curateRepo(cfg, await getRepoStatus(cfg, repoArg));
      console.log(`curated ${repoArg}`);
    } else if (opts.all || opts.stale) {
      const statuses = await listRepoStatuses(cfg);
      const targets = opts.stale ? statuses.filter((s) => s.state !== 'fresh') : statuses;
      if (targets.length === 0) console.log('Nothing to curate — everything is fresh.');
      for (const status of targets) {
        try {
          await curateRepo(cfg, status);
          console.log(`curated ${status.name}`);
        } catch (err) {
          failures += 1;
          console.error(`FAILED ${status.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (!opts.portfolio) {
      console.error('Specify a repo, --all, --stale, or --portfolio.');
      process.exitCode = 1;
      return;
    }

    if (opts.all || opts.stale || opts.portfolio) {
      try {
        await curatePortfolio(cfg);
        console.log('curated portfolio');
      } catch (err) {
        failures += 1;
        console.error(`FAILED portfolio: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures > 0) process.exitCode = 1;
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/curator.test.ts`
Expected: 6 passing. Then run the full suite: `npx vitest run` — everything green.

- [ ] **Step 6: Commit**

```bash
git add src/curator/curator.ts src/cli/index.ts tests/curator.test.ts
git commit -m "feat: curator agent runner and expert curate command"
```

---

### Task 11: Build, README, MCP registration, smoke checklist

**Files:**
- Create: `README.md`, `expert.config.json`
- Modify: none (build output only)

**Interfaces:**
- Consumes: everything — this task verifies the assembled system.
- Produces: buildable package, user-facing docs, registered MCP server.

- [ ] **Step 1: Build and verify the binary**

```bash
npm run build
node dist/cli/index.js --help
```

Expected: help text listing `sync`, `status`, `curate`, `mcp`.

- [ ] **Step 2: Create the real config**

Create `expert.config.json`:

```json
{
  "githubUser": "<your-github-username>",
  "reposDir": "./repos",
  "knowledgeDir": "./knowledge",
  "model": "claude-sonnet-5",
  "excludeRepos": [],
  "includeArchived": false
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# repos-expert

An agent-curated expert on all your GitHub repos, served to Claude Code over MCP.

`expert sync` mirrors every repo from your GitHub account into `repos/`.
`expert curate` sends a read-only Claude agent into each mirror to write
markdown knowledge docs (`knowledge/`). `expert mcp` serves those docs plus
live code search as MCP tools. Docs are stamped with the commit they were
written at; anything stale is flagged so the client trusts live search over
summaries.

## Setup

    npm install
    npm run build
    gh auth status        # needs an authenticated GitHub CLI
    # edit expert.config.json (githubUser, model, excludeRepos)

## Use

    node dist/cli/index.js sync            # mirror all repos
    node dist/cli/index.js curate --all    # curate everything + portfolio (slow, uses the model)
    node dist/cli/index.js status          # fresh / stale / uncurated per repo
    node dist/cli/index.js curate --stale  # refresh only what changed

## Register with Claude Code

    claude mcp add repos-expert -- node C:\dev\repos\ai_github_repos_expert\dist\cli\index.js mcp

Then ask Claude Code things like "which of my repos handle auth, and how
do they differ?" — it will consult `portfolio_overview`, `get_repo_knowledge`,
and `search_code`.

## Curator smoke test (manual, uses the API)

    node dist/cli/index.js sync
    node dist/cli/index.js curate <small-repo-name>
    node dist/cli/index.js status          # repo should now be "fresh"

Inspect `knowledge/repos/<small-repo-name>/` — card, architecture, map,
activity should read like they were written by someone who actually
explored the code. Then `curate --portfolio` and read `portfolio.md`.

## Maintenance loop

    node dist/cli/index.js sync && node dist/cli/index.js status
    node dist/cli/index.js curate --stale
```

- [ ] **Step 4: Run the full test suite one final time**

Run: `npx vitest run`
Expected: all suites passing.

- [ ] **Step 5: Register the MCP server**

```bash
claude mcp add repos-expert -- node C:\dev\repos\ai_github_repos_expert\dist\cli\index.js mcp
```

Expected: `claude mcp list` shows `repos-expert`.

- [ ] **Step 6: Commit**

```bash
git add README.md expert.config.json
git commit -m "docs: README, config, and MCP registration"
```

---

## Manual verification (after all tasks)

1. `node dist/cli/index.js sync` — mirrors your real repos; failures reported per repo.
2. `node dist/cli/index.js curate <one-small-repo>` — the curator smoke test from the README.
3. Restart Claude Code, then ask it: *"Using repos-expert, what's in my portfolio?"* — it should call `portfolio_overview` / `list_repos`.
4. Touch a commit in one repo, `sync`, confirm `status` flips it to stale and MCP responses carry the banner.
