import fs from 'node:fs';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isExcluded, type ExpertConfig } from '../config.js';
import { resolveReal } from '../paths.js';
import {
  getRepoStatus,
  isValidRepoName,
  listRepoStatuses,
  portfolioDrift,
  stalenessBanner,
  type RepoStatus,
} from '../registry.js';
import { searchText, listFiles } from '../rg.js';
import { VERSION } from '../version.js';
import { namesGitDir, resolveWithin, readFileCapped } from './guards.js';

export function text(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: t }] };
}

/**
 * The gate every per-repo tool goes through: a valid name, a repo that is really there,
 * and one the config has not excluded — an excluded repo is absent, not hidden.
 */
export async function requireRepo(cfg: ExpertConfig, name: string): Promise<RepoStatus> {
  const unknown = new Error(`Unknown repo "${name}" — call list_repos to see what exists.`);
  if (!isValidRepoName(name) || isExcluded(cfg, name)) throw unknown;
  if (!fs.existsSync(path.join(cfg.reposDir, name, '.git'))) throw unknown;
  return getRepoStatus(cfg, name);
}

function knowledgeFile(cfg: ExpertConfig, ...segments: string[]): string | null {
  const p = path.join(cfg.knowledgeDir, ...segments);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function portfolioStalenessBanner(cfg: ExpertConfig, statuses: RepoStatus[]): string {
  const changed = portfolioDrift(cfg.knowledgeDir, statuses);
  if (changed === null || changed.length === 0) return '';
  return `⚠ portfolio docs are out of date (changed since: ${changed.join(', ')}) — run \`expert curate --portfolio\`.\n\n`;
}

const NO_DOCS_YET =
  'No written docs yet — run `expert refresh <repo>` to study a repository. search_code, find_files and read_repo_file read the source directly in the meantime.';

/**
 * Every tool degrades to "here is what I can still do" rather than an error:
 * an empty folder is a setup step, not a broken install.
 */
export function noReposHint(cfg: ExpertConfig): string {
  const dirExists = fs.existsSync(cfg.reposDir);
  return [
    dirExists
      ? `No git repositories found in ${cfg.reposDir}.`
      : `The repos folder does not exist yet: ${cfg.reposDir}.`,
    'Put repo folders there (clone or copy them in) and they are analyzable immediately —',
    'code search and file reading need nothing else. Run `expert curate --stale` to add written docs.',
    `To have them cloned instead, list git URLs in ${cfg.reposListFile} and run \`expert sync\`.`,
    cfg.githubUser === null
      ? 'A GitHub account is not configured, and is not required.'
      : `\`expert sync\` also pulls everything from the GitHub account "${cfg.githubUser}".`,
  ].join('\n');
}

/** Reminds the client, at the point of use, that this was written — and is checkable. */
export function provenanceFooter(status: RepoStatus): string {
  const written =
    status.curatedSha === null ? 'not yet written' : `written at ${status.curatedSha.slice(0, 7)}`;
  const verified =
    typeof status.verifiedThrough === 'string' && status.verifiedThrough !== status.curatedSha
      ? ` (only docs, CI or lockfiles changed since — code confirmed unchanged through ${status.verifiedThrough.slice(0, 7)})`
      : '';
  return `\n\n---\nSummary ${written}${verified}; the repo is at ${status.currentSha.slice(0, 7)}. Read the source with search_code / read_repo_file on "${status.name}" to confirm anything specific.`;
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

/**
 * Sent to the client once at connect. The knowledge docs are a model's written
 * summary, not ground truth, and the client is holding tools that can check them —
 * saying so is what keeps a stale sentence from becoming a confident wrong answer.
 */
export const SERVER_INSTRUCTIONS = `This server answers questions about a collection of code repositories.

Two kinds of information, and they are not equally authoritative:

1. Written knowledge (portfolio_overview, list_repos, get_repo_knowledge,
   search_knowledge). Documents an AI agent wrote after reading each repository:
   purpose, architecture, directory map, recent activity, and interfaces. They carry
   understanding you cannot get from grep — why a project exists, how repos relate —
   but they are a snapshot, written at a specific commit, and code moves on.

2. The actual source code (search_code, find_files, read_repo_file). Always current,
   always literal.

Use the documents to orient and to answer conceptual and cross-repo questions. Then:

- The repositories are open to you through the read tools, which have no side effects and
  always show the current code. If something in a document looks wrong, contradicts
  itself, or does not match what the user is describing, the code is where to settle it.
- Verify what matters, not everything. Re-checking every sentence wastes the point of
  having summaries. Do check before stating something the user will act on: an exact
  endpoint, a function signature, a file path, whether a feature actually exists.
- A ⚠ banner means the documents are older than the code. Treat those claims as leads to
  confirm, not as facts.
- interfaces.md is the verified contract surface (routes, commands, exports, env vars,
  data models). It separates what the code implements from what is only described in
  documentation — respect that distinction when you quote it.
- If the documents and the code disagree, the code wins. Say so plainly to the user, and
  mention that re-running \`expert refresh <repo>\` will bring the documents back in line.

The same documents are also available as resources — expert://portfolio,
expert://cross-repo-map, and expert://repos/{repo}/{doc} — for clients that attach
context rather than call tools. They carry the same banners and footers.`;

/**
 * What every tool says when there is no usable config. An MCP client that cannot
 * start a server shows a red light and a stack trace in a log nobody opens; a server
 * that starts and explains itself is repairable by the person holding the chat window.
 */
export function setupInstructions(reason: string): string {
  return [
    'repos-expert is installed but not set up yet, so there is nothing to search.',
    '',
    `Reason: ${reason}`,
    '',
    'To fix it, in a terminal:',
    '  expert init          # asks where your projects are, writes the config',
    '  expert add <url>     # add a project (or copy folders into that directory)',
    '  expert refresh <name>  # study one, so there is something to answer from',
    '',
    'Tell the user this — they have to run it; you cannot. Nothing else here will work',
    'until they do, so do not retry these tools in the meantime.',
  ].join('\n');
}

/**
 * A server that answers honestly instead of failing to start. Deliberately exposes
 * the same tool names as the real one so the client's tool list does not change shape
 * between "set up" and "not set up".
 */
export function createUnconfiguredServer(reason: string): McpServer {
  const server = new McpServer(
    { name: 'repos-expert', version: VERSION },
    { instructions: setupInstructions(reason) },
  );
  const message = setupInstructions(reason);
  for (const [name, title] of Object.entries(TOOL_TITLES)) {
    server.registerTool(
      name,
      {
        title,
        description: 'Unavailable until repos-expert is set up — call it to see how.',
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => text(message),
    );
  }
  return server;
}

/** The per-repo documents, in the order they are usually wanted. */
export const REPO_DOCS = ['card', 'architecture', 'map', 'activity', 'interfaces'] as const;
export type RepoDoc = (typeof REPO_DOCS)[number];

const MARKDOWN = 'text/markdown';

/**
 * One repo doc, exactly as get_repo_knowledge returns it: the staleness banner, the
 * document, and the provenance footer. Shared by the tool and the resource so a client
 * sees the same warnings whichever way it reads.
 */
async function repoDocText(cfg: ExpertConfig, repo: string, doc: RepoDoc): Promise<string> {
  const status = await requireRepo(cfg, repo);
  const file = `${doc}.md`;
  const content = knowledgeFile(cfg, 'repos', repo, file);
  if (content === null) {
    return (
      `No curated ${file} for "${repo}" yet — run \`expert curate ${repo}\`. ` +
      `You can still read the code directly with search_code, find_files, and read_repo_file.`
    );
  }
  return stalenessBanner(status) + content + provenanceFooter(status);
}

function isRepoDoc(value: string): value is RepoDoc {
  return (REPO_DOCS as readonly string[]).includes(value);
}

/** Template variables arrive as string | string[]; we only ever want one value. */
function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * The same knowledge as resources, for clients that attach context rather than call
 * tools. The list stays linear in the number of repos — portfolio, cross-repo map, and
 * one card per repo — and the other docs are one template away, with completion.
 */
function registerResources(server: McpServer, cfg: ExpertConfig): void {
  const markdown = (uri: URL, body: string) => ({
    contents: [{ uri: uri.href, mimeType: MARKDOWN, text: body }],
  });

  server.registerResource(
    'portfolio',
    'expert://portfolio',
    {
      title: 'Portfolio overview',
      description:
        'What repos exist, grouped by theme, and how they relate. Read first for cross-repo questions.',
      mimeType: MARKDOWN,
    },
    async (uri) => {
      const statuses = await listRepoStatuses(cfg);
      const body =
        knowledgeFile(cfg, 'portfolio.md') ??
        '(portfolio.md not yet curated — run `expert curate --portfolio`)';
      return markdown(uri, portfolioStalenessBanner(cfg, statuses) + body);
    },
  );

  server.registerResource(
    'cross-repo-map',
    'expert://cross-repo-map',
    {
      title: 'Cross-repo map',
      description:
        'Which repos are actually wired together (imports, ports, shared files) versus merely similar.',
      mimeType: MARKDOWN,
    },
    async (uri) =>
      markdown(
        uri,
        knowledgeFile(cfg, 'cross-repo-map.md') ??
          '(cross-repo-map.md not yet curated — run `expert curate --portfolio`)',
      ),
  );

  const repoNames = async (): Promise<string[]> => (await listRepoStatuses(cfg)).map((s) => s.name);

  server.registerResource(
    'repo-doc',
    new ResourceTemplate('expert://repos/{repo}/{doc}', {
      list: async () => ({
        resources: (await listRepoStatuses(cfg)).map((s) => ({
          uri: `expert://repos/${s.name}/card`,
          name: `${s.name} — card`,
          description: `${cardSummary(cfg, s.name)} [${s.state}]`,
          mimeType: MARKDOWN,
        })),
      }),
      complete: {
        repo: async (value) => (await repoNames()).filter((n) => n.startsWith(value)),
        doc: (value) => REPO_DOCS.filter((d) => d.startsWith(value)),
      },
    }),
    {
      title: 'Repository knowledge doc',
      description:
        'One curated doc for one repo. doc is card | architecture | map | activity | interfaces; interfaces is the verified contract surface.',
      mimeType: MARKDOWN,
    },
    async (uri, variables) => {
      const repo = one(variables.repo);
      const doc = one(variables.doc);
      if (!isRepoDoc(doc)) {
        throw new Error(`doc must be one of ${REPO_DOCS.join(', ')} — got "${doc}"`);
      }
      return markdown(uri, await repoDocText(cfg, repo, doc));
    },
  );
}

/**
 * Every tool here reads and does nothing else: no writes, no side effects, and nothing
 * outside the repos folder on this machine. Hosts use these hints to decide whether to
 * warn someone before a call, so all four are stated on every tool rather than left to
 * a default — a missing hint reads as "unknown", which is not what is true here.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Every tool this server exposes, with its display title; the unconfigured server mirrors the list. */
const TOOL_TITLES = {
  portfolio_overview: 'Portfolio overview',
  list_repos: 'List repositories',
  get_repo_knowledge: 'Read a repository’s written docs',
  search_knowledge: 'Search the written docs',
  search_code: 'Search source code',
  find_files: 'Find files by name',
  read_repo_file: 'Read a source file',
} as const;

/** Parameter descriptions are the only documentation a model gets for each argument. */
/** Longer than any real query, glob or path; past this an argument is a mistake, or an attack. */
const MAX_QUERY_LENGTH = 4096;
const MAX_GLOB_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

const PARAM = {
  repo: z.string().describe('Repository name, exactly as list_repos prints it.'),
  repoFilter: z
    .string()
    .optional()
    .describe(
      'Limit to this one repository (a name from list_repos). Omit to cover every repository.',
    ),
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .describe(
      'What to look for, as a ripgrep regular expression; case-insensitive unless it contains a capital letter. Escape ( [ { . * + ? | or set literal to search for code as written.',
    ),
  glob: (example: string) =>
    z
      .string()
      .min(1)
      .max(MAX_GLOB_LENGTH)
      .describe(
        `Glob matched against paths inside each repository, e.g. ${example}. {a,b} and [abc] work; start it with ! to exclude instead. A glob only narrows: hidden files (dotfiles, .github) and gitignored files are never searched or listed — open those with read_repo_file.`,
      ),
  literal: z
    .boolean()
    .optional()
    .describe(
      'Search for the query exactly as written instead of as a regular expression. Default false.',
    ),
};

export function createServer(cfg: ExpertConfig): McpServer {
  const server = new McpServer(
    { name: 'repos-expert', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'portfolio_overview',
    {
      title: TOOL_TITLES.portfolio_overview,
      description:
        'Start here for questions that span repositories: the written overview of every repo, how they connect, and which docs are out of date.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      if (statuses.length === 0) return text(noReposHint(cfg));
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
      return text(portfolioStalenessBanner(cfg, statuses) + parts.join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'list_repos',
    {
      title: TOOL_TITLES.list_repos,
      description:
        'Every repository in the collection, with a one-line summary and whether its written docs are current (fresh), older than the code (stale) or not written yet (uncurated). These names are what the other tools take as "repo".',
      inputSchema: {},
      // Staleness as data, not just prose: a client can act on `state` without parsing text.
      outputSchema: {
        repos: z
          .array(
            z.object({
              name: z.string(),
              state: z.enum(['fresh', 'stale', 'uncurated']),
              currentSha: z.string().describe('The commit the repository is at now.'),
              curatedSha: z.string().nullable().describe('The commit the docs were written at.'),
              verifiedThrough: z
                .string()
                .nullable()
                .describe(
                  'Set when only docs or CI changed since: code confirmed unchanged through this commit.',
                ),
              summary: z.string().describe('The first line of the repo’s card.'),
            }),
          )
          .describe('Every repository, sorted by name.'),
      },
      annotations: READ_ONLY,
    },
    async () => {
      const statuses = await listRepoStatuses(cfg);
      const repos = statuses.map((s) => ({
        name: s.name,
        state: s.state,
        currentSha: s.currentSha,
        curatedSha: s.curatedSha,
        verifiedThrough: s.verifiedThrough,
        summary: cardSummary(cfg, s.name),
      }));
      const body =
        repos.length === 0
          ? noReposHint(cfg)
          : repos.map((r) => `${r.name} [${r.state}] — ${r.summary}`).join('\n');
      return { content: [{ type: 'text' as const, text: body }], structuredContent: { repos } };
    },
  );

  server.registerTool(
    'get_repo_knowledge',
    {
      title: TOOL_TITLES.get_repo_knowledge,
      description:
        'One written document about one repository. "interfaces" is the verified contract surface — routes, CLI commands, exports, env vars, data models, outbound calls, each citing file:line — and is usually the fastest answer to "what does this expose?".',
      inputSchema: {
        repo: PARAM.repo,
        doc: z
          .enum(REPO_DOCS)
          .optional()
          .describe(
            'Which document: card (what it is and how to run it; the default), architecture (modules and design), map (annotated directory tree), activity (recent work and open branches), or interfaces (contract surface).',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ repo, doc }) => text(await repoDocText(cfg, repo, doc ?? 'card')),
  );

  server.registerTool(
    'search_knowledge',
    {
      title: TOOL_TITLES.search_knowledge,
      description:
        'Search the written docs of every repository, for concepts and relationships the code alone does not state. Results are file:line:text, at most 100. To find code, use search_code.',
      inputSchema: { query: PARAM.query, literal: PARAM.literal },
      annotations: READ_ONLY,
    },
    async ({ query, literal }, extra) => {
      if (!fs.existsSync(cfg.knowledgeDir)) return text(NO_DOCS_YET);
      // The docs of an excluded repo are as absent as the repo itself.
      return text(
        await searchText(cfg.knowledgeDir, query, {
          literal,
          excludeFolders: cfg.excludeRepos.map((name) => `repos/${name}`),
          signal: extra.signal,
        }),
      );
    },
  );

  server.registerTool(
    'search_code',
    {
      title: TOOL_TITLES.search_code,
      description:
        'Search the current source code of every repository, or of one. Results are repo/path:line:text sorted by path, at most 100; when capped, a missing match proves nothing, so narrow with repo or glob.',
      inputSchema: {
        query: PARAM.query,
        repo: PARAM.repoFilter,
        glob: PARAM.glob('"*.ts" or "src/**/*.py"').optional(),
        literal: PARAM.literal,
      },
      annotations: READ_ONLY,
    },
    async ({ query, repo, glob, literal }, extra) => {
      if (repo === undefined) {
        if (!fs.existsSync(cfg.reposDir)) return text(noReposHint(cfg));
        return text(
          await searchText(cfg.reposDir, query, {
            glob,
            literal,
            excludeFolders: cfg.excludeRepos,
            globBelowTopLevel: true,
            signal: extra.signal,
          }),
        );
      }
      const status = await requireRepo(cfg, repo);
      return text(
        stalenessBanner(status) +
          (await searchText(status.path, query, { glob, literal, signal: extra.signal })),
      );
    },
  );

  server.registerTool(
    'find_files',
    {
      title: TOOL_TITLES.find_files,
      description:
        'List files whose path matches a glob, in one repository or across all of them. At most 100, sorted by path.',
      inputSchema: {
        pattern: PARAM.glob('"*.ts", "**/Dockerfile" or "src/**/*.test.ts"'),
        repo: PARAM.repoFilter,
      },
      annotations: READ_ONLY,
    },
    async ({ pattern, repo }, extra) => {
      if (repo === undefined) {
        if (!fs.existsSync(cfg.reposDir)) return text(noReposHint(cfg));
        return text(
          await listFiles(cfg.reposDir, pattern, {
            excludeFolders: cfg.excludeRepos,
            globBelowTopLevel: true,
            signal: extra.signal,
          }),
        );
      }
      return text(
        await listFiles((await requireRepo(cfg, repo)).path, pattern, { signal: extra.signal }),
      );
    },
  );

  server.registerTool(
    'read_repo_file',
    {
      title: TOOL_TITLES.read_repo_file,
      description:
        'Read one file from a repository. Long files come back in parts — at most 2,000 lines or 48 KB per call — ending with the startLine to continue from.',
      inputSchema: {
        repo: PARAM.repo,
        path: z
          .string()
          .min(1)
          .max(MAX_PATH_LENGTH)
          .describe('Path inside the repository, relative to its root, e.g. "src/index.ts".'),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to return, 1-based. Default 1.'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Last line to return, inclusive. Default: the end of the file, within the read cap.',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ repo, path: relPath, startLine, endLine }) => {
      const status = await requireRepo(cfg, repo);
      const notServed = new Error(
        `Not served: ${relPath} is inside .git — git's own data, not source, and a remote URL there can carry a token.`,
      );
      const abs = resolveWithin(status.path, relPath); // throws if it leaves the repo
      const root = path.resolve(status.path);
      // Judged as written and where it lands: a link, or a Windows short name, can reach
      // .git too. Both are repo-relative, so a drive letter's colon never reads as a stream.
      if (
        namesGitDir(path.relative(root, path.resolve(root, relPath))) ||
        namesGitDir(path.relative(resolveReal(root), abs))
      ) {
        throw notServed;
      }
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found in "${repo}": ${relPath}`);
      }
      return text(stalenessBanner(status) + readFileCapped(abs, startLine, endLine));
    },
  );

  registerResources(server, cfg);

  return server;
}

export async function startMcp(cfg: ExpertConfig): Promise<void> {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}

/**
 * The entry point an MCP client actually launches. Loading the config is allowed to
 * fail: a client cannot act on a process that exited, but it can relay a sentence
 * telling the user which command to run.
 */
export async function startMcpOrExplain(loadCfg: () => ExpertConfig): Promise<void> {
  let server: McpServer;
  try {
    server = createServer(loadCfg());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // stderr only — stdout is the protocol.
    console.error(`repos-expert: starting in setup mode. ${reason}`);
    server = createUnconfiguredServer(reason);
  }
  await server.connect(new StdioServerTransport());
}
