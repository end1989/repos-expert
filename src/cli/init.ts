import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, userConfigPath } from '../config.js';
import { readTextFile } from '../paths.js';
import { REPOS_LIST_FILENAME, reposListTemplate } from '../repos-list.js';

export const PACKAGE_NAME = 'repos-expert';

export interface InitOptions {
  reposDir?: string;
  githubUser?: string;
  force?: boolean;
  skipClient?: boolean;
  skipWorkspaceGuide?: boolean;
  /** Label for a second collection; becomes the client entry `repos-expert-<label>`. */
  name?: string;
}

export interface InitResult {
  configPath: string;
  configWritten: boolean;
  reposDir: string;
  reposListPath: string | null;
  clientConfigPath: string | null;
  clientWritten: boolean;
  /** The key written into the client's mcpServers (`repos-expert`, or `repos-expert-<label>`). */
  clientEntry: string;
  notes: string[];
}

export interface InitPaths {
  /** Where the config goes: the per-user default, or whatever `--config` named. */
  configPath: string;
  /**
   * The per-user default. When given and configPath differs from it, this is a second
   * profile; when omitted, configPath is treated as the default.
   */
  defaultConfigPath?: string;
  clientConfigPath: string | null;
  entryPoint: string;
}

/**
 * The client-side name for a profile. Keys in Claude Desktop's config are used as
 * identifiers, so the label is slugged: `Client Work (2026)` → `repos-expert-client-work-2026`.
 */
export function clientEntryName(label: string | undefined): string {
  const slug = (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? PACKAGE_NAME : `${PACKAGE_NAME}-${slug}`;
}

/**
 * The entry a second profile is registered under: its --name, else the config file's own
 * name (`work.json` → work), else the folder holding `expert.config.json`. A label of only
 * non-Latin letters or punctuation slugs to nothing and would take the default entry, so
 * it is named after the config's path instead.
 */
function profileEntryName(configPath: string, name: string | undefined): string {
  const file = path.basename(configPath);
  const label =
    name !== undefined && name.length > 0
      ? name
      : file.toLowerCase() === 'expert.config.json'
        ? path.basename(path.dirname(path.resolve(configPath)))
        : path.parse(file).name;
  const entry = clientEntryName(label);
  if (entry !== PACKAGE_NAME) return entry;
  const id = createHash('sha256').update(path.resolve(configPath).toLowerCase()).digest('hex');
  return `${PACKAGE_NAME}-${id.slice(0, 8)}`;
}

/**
 * The folder someone typed or pasted, as an absolute path: quotes from Explorer's "Copy as
 * path" removed, `~` expanded (only a shell would otherwise), and a relative answer read
 * from where they ran the command — not from wherever the config ends up.
 */
export function resolveFolderAnswer(
  input: string,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string {
  let p = input.trim();
  const quoted = /^"(.*)"$/.exec(p) ?? /^'(.*)'$/.exec(p);
  if (quoted !== null) p = (quoted[1] ?? '').trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  return path.resolve(cwd, p);
}

/** Two paths name the same place, compared the platform's way (ignoring case on Windows). */
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** Where Claude Desktop keeps its MCP server list, or null on platforms without it. */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
): string | null {
  const appData = process.env.APPDATA;
  if (platform === 'win32' && appData !== undefined && appData.length > 0) {
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return null;
}

/**
 * What the MCP client should run to start the server.
 *
 * Pin the client to *this* install: the absolute node binary plus the absolute path to
 * this file. That is deterministic, works offline, needs no PATH (GUI clients on macOS
 * famously do not inherit the shell's), and follows `npm update -g` because npm replaces
 * the files in place. The alternative — a bare `npx repos-expert` — runs whichever copy
 * npm finds first and keeps running it: a global install stays at its installed version
 * for as long as nobody runs `npm update -g`, and nothing says so. `expert doctor` reports
 * what the client would launch and flags a mismatch.
 *
 * The one place a path is *not* stable is npm's npx cache (`_npx/<hash>/…`, where
 * `npx repos-expert init` runs from). There, hand the client `npx … @latest`, which
 * re-resolves the newest published version on every launch.
 */
export function mcpLaunchCommand(
  entryPoint: string,
  nodeExecPath: string = process.execPath,
  /** For a second profile: the config file the server should load. Omit for the default. */
  configPath: string | null = null,
): { command: string; args: string[] } {
  // Separator-agnostic on purpose: this path can arrive as a Windows path or as
  // a POSIX one from fileURLToPath, and guessing wrong writes a broken command.
  const normalized = entryPoint.replace(/\\/g, '/');
  const profile = configPath === null ? [] : ['--config', configPath.replace(/\\/g, '/')];
  if (normalized.includes('_npx')) {
    return { command: 'npx', args: ['-y', `${PACKAGE_NAME}@latest`, 'mcp', ...profile] };
  }
  return { command: nodeExecPath, args: [normalized, 'mcp', ...profile] };
}

/** The config an entry's args name with --config, or null for the default profile. */
function configNamedBy(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const at = args.indexOf('--config');
  const value: unknown = at === -1 ? undefined : args[at + 1];
  return typeof value === 'string' ? value : null;
}

/**
 * Adds our server to a client config without disturbing anything already there: other
 * servers, other keys, and fields the user added to our own entry (an `env`, say). An entry
 * under the same key that belongs to another collection is refused, not replaced.
 */
export function mergeClientConfig(
  existingJson: string | null,
  command: string,
  args: string[],
  key: string = PACKAGE_NAME,
): string {
  let existing: Record<string, unknown> = {};
  if (existingJson !== null && existingJson.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingJson);
    } catch {
      throw new Error('The existing Claude Desktop config is not valid JSON — left it untouched.');
    }
    if (!isPlainObject(parsed)) {
      throw new Error(
        'The existing Claude Desktop config is not a JSON object — left it untouched.',
      );
    }
    existing = parsed;
  }
  const prior = existing.mcpServers;
  const servers: Record<string, unknown> = isPlainObject(prior) ? { ...prior } : {};
  const before = servers[key];
  if (isPlainObject(before)) {
    const theirs = configNamedBy(before.args);
    const ours = configNamedBy(args);
    const same = theirs === null || ours === null ? theirs === ours : samePath(theirs, ours);
    if (!same) {
      throw new Error(
        `Claude Desktop already has a "${key}" entry for another collection (${theirs ?? 'the default config'}) — left it untouched. Give this one a different --name.`,
      );
    }
  }
  servers[key] = { ...(isPlainObject(before) ? before : {}), command, args };
  return `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultConfigBody(
  opts: InitOptions,
  configPath: string = userConfigPath(),
): string {
  const body: Record<string, unknown> = {};
  if (opts.githubUser !== undefined && opts.githubUser.length > 0) {
    body.githubUser = opts.githubUser;
  }
  body.reposDir = (opts.reposDir ?? path.join(os.homedir(), 'repos')).replace(/\\/g, '/');
  // Knowledge lives beside its config, so a second profile gets its own knowledge base —
  // and is named after the config file, so two configs kept in one folder do not share one.
  const file = path.basename(configPath);
  const folder =
    file.toLowerCase() === 'expert.config.json'
      ? 'knowledge'
      : `knowledge-${path.parse(file).name}`;
  body.knowledgeDir = path.join(path.dirname(configPath), folder).replace(/\\/g, '/');
  body.model = 'claude-sonnet-5';
  body.excludeRepos = [];
  body.includeArchived = false;
  body.curateConcurrency = 2;
  body.curateTimeoutMinutes = 25;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Dropped into the user's code folder so an agent working there discovers the
 * knowledge base instead of starting cold in a directory of unfamiliar projects.
 */
export function workspaceGuide(): string {
  return `# Working in this folder

This folder holds multiple independent code repositories. A knowledge base about them is
available through the \`repos-expert\` MCP server — use it rather than exploring blind.

## Start here, not with find/grep

- \`portfolio_overview\` — what exists and how the projects relate. Read this first when
  the question spans more than one project.
- \`list_repos\` — every project with a one-line summary.
- \`get_repo_knowledge(repo, doc)\` — \`card\` (what it does), \`architecture\` (how it is
  built), \`map\` (where things live), \`activity\` (recent work), \`interfaces\` (routes,
  commands, exports, env vars, data models).

For "what does X expose?", \`interfaces\` is one call and beats grepping route definitions,
which returns matches from READMEs and old planning notes as readily as from real code.

## The documents are written, not generated

An AI agent wrote them by reading each repo at a specific commit. They hold reasoning you
cannot grep for — but code moves on, and a ⚠ banner means the summary is older than the
code.

**Verify what matters, not everything.** Confirm before stating anything the user will act
on: an exact endpoint, a signature, a path, whether a feature exists. Do not re-check every
sentence — that wastes the point of having summaries.

**These repositories are open to you.** \`search_code\`, \`find_files\`, and \`read_repo_file\`
read the real source. If a document looks wrong, contradicts itself, or does not match what
the user is telling you, go and settle it in the code without asking first. If the two
disagree, the code wins — say so, and mention that \`expert refresh <repo>\` updates the
document.

**\`interfaces.md\` separates implemented from merely documented.** Its "Documented but not
implemented" section lists things a README claims that the code does not do. Respect that
line when quoting it.

## Adding and keeping projects

\`${REPOS_LIST_FILENAME}\` in this folder is the list of projects to clone — one git URL per
line, then \`expert sync\`. Any folder already here containing a \`.git\` is picked up without
being listed.

\`expert refresh\` re-studies whatever changed. \`expert refresh <repo>\` adds or updates one.
`;
}

/** Where projects go if the user did not say. */
export function defaultReposDir(): string {
  return path.join(os.homedir(), 'repos');
}

/** Folders people actually keep code in, best guess first. */
export function reposDirCandidates(home = os.homedir()): string[] {
  const named = ['repos', 'code', 'dev', 'src', 'projects', 'source/repos', 'Documents/GitHub'];
  return named.map((n) => path.join(home, ...n.split('/')));
}

function holdsGitRepos(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git')));
  } catch {
    return false;
  }
}

/**
 * A default worth offering. Suggesting an empty folder is what leaves someone
 * looking at a directory with nothing in it, wondering what went wrong.
 */
export function suggestReposDir(candidates = reposDirCandidates()): string {
  return candidates.find((c) => holdsGitRepos(c)) ?? candidates[0] ?? defaultReposDir();
}

/** The folders a config really uses, read the way every command reads them. */
function configuredFolders(
  configPath: string,
): { reposDir: string; reposListFile: string } | { problem: string } {
  try {
    const cfg = loadConfig(configPath);
    return { reposDir: cfg.reposDir, reposListFile: cfg.reposListFile };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `--force` over an existing config: the old one is backed up (the first backup is kept),
 * and only what was asked for changes — the excluded repos, the spending cap and the model
 * endpoint someone set up survive a change of folder.
 */
function forceConfig(opts: InitOptions, configPath: string, askedFor: string | undefined): string {
  const backup = `${configPath}.backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);
  let current: unknown = null;
  try {
    current = JSON.parse(readTextFile(configPath));
  } catch {
    current = null;
  }
  if (!isPlainObject(current)) {
    fs.writeFileSync(configPath, defaultConfigBody({ ...opts, reposDir: askedFor }, configPath));
    return `Replaced ${configPath}, which could not be read; the previous version is in ${backup}`;
  }
  const updated: Record<string, unknown> = { ...current };
  if (askedFor !== undefined) updated.reposDir = askedFor.replace(/\\/g, '/');
  if (opts.githubUser !== undefined && opts.githubUser.length > 0) {
    updated.githubUser = opts.githubUser;
  }
  fs.writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`);
  return `Updated ${configPath}, keeping its other settings; the previous version is in ${backup}`;
}

export function runInit(opts: InitOptions, paths: InitPaths): InitResult {
  const notes: string[] = [];
  let configWritten = false;

  if (fs.existsSync(paths.configPath) && fs.statSync(paths.configPath).isDirectory()) {
    throw new Error(
      `${paths.configPath} is a folder: --config names the config file itself, such as ${path.join(paths.configPath, 'expert.config.json')}`,
    );
  }
  const askedFor = opts.reposDir !== undefined ? resolveFolderAnswer(opts.reposDir) : undefined;

  if (!fs.existsSync(paths.configPath)) {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      defaultConfigBody({ ...opts, reposDir: askedFor }, paths.configPath),
    );
    configWritten = true;
  } else if (opts.force === true) {
    notes.push(forceConfig(opts, paths.configPath, askedFor));
    configWritten = true;
  } else {
    notes.push(`Config already exists, left alone: ${paths.configPath}`);
  }

  // Report — and set up — the folders the tool will really read, not the ones asked for.
  // Otherwise init cheerfully describes a folder nothing ever looks in.
  let reposDir = askedFor ?? defaultReposDir();
  let listPath: string | null = null;
  const configured = configuredFolders(paths.configPath);
  if ('problem' in configured) {
    notes.push(`The config could not be read, so no folders were set up: ${configured.problem}`);
  } else {
    if (!configWritten && askedFor !== undefined && !samePath(askedFor, configured.reposDir)) {
      notes.push(`It points at ${configured.reposDir} — re-run with --force to change that.`);
    }
    reposDir = configured.reposDir;
    listPath = configured.reposListFile;
  }

  // A second profile is any config that is not the per-user default: it gets its own
  // client entry, and the server is told which config to load.
  const isProfile =
    paths.defaultConfigPath !== undefined && !samePath(paths.configPath, paths.defaultConfigPath);
  const clientEntry = isProfile ? profileEntryName(paths.configPath, opts.name) : PACKAGE_NAME;
  let reposListPath: string | null = null;

  // The list is the answer to "I have an empty folder, now what?" — so it is written
  // even when the workspace guide is skipped, and it is never silently replaced.
  if (listPath !== null) {
    try {
      fs.mkdirSync(path.dirname(listPath), { recursive: true });
      if (fs.existsSync(listPath)) {
        notes.push(`Your project list is already there: ${listPath}`);
      } else {
        fs.writeFileSync(listPath, reposListTemplate());
        notes.push(`Wrote your project list: ${listPath} — put git URLs in it, one per line.`);
      }
      reposListPath = listPath;
    } catch (err) {
      notes.push(
        `Could not write ${listPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.skipWorkspaceGuide !== true && !('problem' in configured)) {
    const guidePath = path.join(reposDir, 'CLAUDE.md');
    if (fs.existsSync(guidePath)) {
      notes.push(`Left your existing ${guidePath} alone.`);
    } else {
      try {
        fs.mkdirSync(reposDir, { recursive: true });
        fs.writeFileSync(guidePath, workspaceGuide());
        notes.push(`Wrote ${guidePath} so agents working there find the knowledge base.`);
      } catch (err) {
        notes.push(
          `Could not write ${guidePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  let clientWritten = false;
  if (opts.skipClient === true) {
    notes.push('Skipped the Claude Desktop step.');
  } else if (paths.clientConfigPath === null) {
    notes.push(
      'No Claude Desktop config location on this platform — add the server to your MCP client by hand.',
    );
  } else {
    const { command, args } = mcpLaunchCommand(
      paths.entryPoint,
      process.execPath,
      isProfile ? path.resolve(paths.configPath) : null,
    );
    const existing = fs.existsSync(paths.clientConfigPath)
      ? readTextFile(paths.clientConfigPath)
      : null;
    // Merged first: a config that cannot be parsed throws here, before anything is copied
    // or written, and is left exactly as it was.
    const merged = mergeClientConfig(existing, command, args, clientEntry);
    const backup = `${paths.clientConfigPath}.backup`;
    if (existing !== null) {
      // The first backup is the one worth keeping — the user's config from before this
      // tool ever touched it. A second run must not replace it with its own output.
      if (fs.existsSync(backup)) {
        notes.push(`Kept the earlier backup of the Claude Desktop config: ${backup}`);
      } else {
        fs.copyFileSync(paths.clientConfigPath, backup);
        notes.push(`Backed up the previous Claude Desktop config to ${backup}`);
      }
    }
    fs.mkdirSync(path.dirname(paths.clientConfigPath), { recursive: true });
    fs.writeFileSync(paths.clientConfigPath, merged);
    clientWritten = true;
    if (isProfile) {
      notes.push(`Registered as "${clientEntry}" in Claude Desktop, alongside any other profiles.`);
    }
    if (command === 'npx') {
      notes.push(
        'Claude Desktop will launch the newest published version through npx (needs network at launch).',
      );
    } else {
      const fromNpm = (args[0] ?? '').includes('/node_modules/');
      notes.push(
        `Claude Desktop will launch this install: ${args[0]}. ${
          fromNpm ? 'npm update -g repos-expert' : 'npm run build'
        } is picked up automatically; if you move or reinstall Node or the tool, run expert init again (expert doctor checks this).`,
      );
    }
    notes.push('Quit Claude Desktop from the system tray and reopen it to pick this up.');
  }

  return {
    configPath: paths.configPath,
    configWritten,
    reposDir,
    reposListPath,
    clientConfigPath: paths.clientConfigPath,
    clientWritten,
    clientEntry,
    notes,
  };
}
