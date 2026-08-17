import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type ExpertConfig } from '../config.js';
import { curatorEnvFrom, describeProvider, type ClaudeAuth, type EnvLike } from '../provider.js';
import { readReposList } from '../repos-list.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** The command or edit that resolves it. Only for warn/fail. */
  fix?: string;
}

/** Everything about the machine, injected so the checks stay testable. */
export interface Probes {
  nodeVersion: string;
  /** Path to the bundled ripgrep, or null if the binary never got installed. */
  ripgrepPath: string | null;
  hasCommand(cmd: string): boolean;
  /** This process's environment; config's curatorEnv is layered on top. */
  env: EnvLike;
  /** This CLI's own version — what the client *should* be launching. */
  version: string;
  /**
   * Asks Claude Code whether it is signed in (`claude auth status`). Returns null when
   * that could not be determined; must never throw. A function, so the probe only runs
   * when Claude Code is on PATH and nothing else already decides the provider.
   */
  claudeAuth: () => ClaudeAuth | null;
  /**
   * Claude Desktop's config: where it lives and its text (null when the file does not
   * exist). null when the platform has no Claude Desktop location at all.
   */
  clientConfig: { path: string; text: string | null } | null;
}

const PACKAGE_NAME = 'repos-expert';

/** Version of the package that owns `file`, found by walking up to its package.json. */
function installedVersionAbove(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: unknown; version?: unknown };
        if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') return parsed.version;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * What Claude Desktop would actually start, compared with this CLI. This is the check
 * that catches "I updated the tool but my assistant still runs the old server" — the
 * client config points somewhere, and nothing else ever looks at where.
 */
export function clientLaunchCheck(probes: Probes): Check | null {
  const client = probes.clientConfig;
  if (client === null) return null;
  const name = 'claude desktop';

  if (client.text === null) {
    return { name, status: 'warn', detail: `no config at ${client.path} — the server is not connected yet`, fix: 'expert init' };
  }
  let parsed: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
  try {
    parsed = JSON.parse(client.text) as typeof parsed;
  } catch {
    return {
      name,
      status: 'warn',
      detail: `${client.path} is not valid JSON — Claude Desktop will start no servers from it`,
      fix: 'Fix the file by hand (there may be a .backup next to it), then: expert init',
    };
  }
  const entry = parsed.mcpServers?.[PACKAGE_NAME];
  if (entry === undefined || typeof entry.command !== 'string') {
    return { name, status: 'warn', detail: `not registered in ${client.path}`, fix: 'expert init' };
  }
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  const command = entry.command;
  const exe = path.basename(command).toLowerCase();

  if (exe === 'npx' || exe === 'npx.cmd') {
    const spec = args.find((a) => a.startsWith(PACKAGE_NAME));
    if (spec === undefined) {
      return { name, status: 'ok', detail: `custom launch: ${command} ${args.join(' ')}` };
    }
    if (spec.includes('@')) {
      return { name, status: 'ok', detail: `via npx ${spec} — the newest published version, resolved at each launch (needs network)` };
    }
    return {
      name,
      status: 'warn',
      detail: `via bare "npx ${spec}", which runs whichever copy npm finds first and keeps running it — a global install stays at its version until npm update -g`,
      fix: 'expert init',
    };
  }

  const isNode = exe === 'node' || exe === 'node.exe';
  const script = args[0];
  if (!isNode || script === undefined || !/\.(c|m)?js$/i.test(script)) {
    return { name, status: 'ok', detail: `custom launch: ${command} ${args.join(' ')}` };
  }
  if (!fs.existsSync(script)) {
    return {
      name,
      status: 'fail',
      detail: `points at ${script}, which no longer exists — the server cannot start`,
      fix: 'expert init',
    };
  }
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    return {
      name,
      status: 'fail',
      detail: `launches with ${command}, which no longer exists — the server cannot start`,
      fix: 'expert init',
    };
  }
  const launched = installedVersionAbove(script);
  if (launched === null) {
    return { name, status: 'ok', detail: `launches ${script}` };
  }
  if (launched !== probes.version) {
    return {
      name,
      status: 'warn',
      detail: `launches ${launched} from ${script}; this command is ${probes.version}`,
      fix: 'expert init',
    };
  }
  return { name, status: 'ok', detail: `launches this install (${launched}) — ${script}` };
}

const MIN_NODE_MAJOR = 20;

function majorOf(version: string): number {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '0', 10);
}

function countProjects(reposDir: string): number {
  try {
    return fs
      .readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(reposDir, e.name, '.git'))).length;
  } catch {
    return 0;
  }
}

function countCurated(knowledgeDir: string): number {
  try {
    return fs
      .readdirSync(path.join(knowledgeDir, 'repos'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(knowledgeDir, 'repos', e.name, 'meta.json')))
      .length;
  } catch {
    return 0;
  }
}

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which model would write the documents, and who pays. `curatorEnv` is included
 * because that is exactly the setting a scheduled run relies on and a shell session
 * would otherwise hide.
 */
function modelAccessCheck(probes: Probes, cfg: ExpertConfig | undefined): Check {
  const env = curatorEnvFrom(probes.env, cfg?.curatorEnv);
  const hasClaudeCode = probes.hasCommand('claude');
  // Only ask Claude Code about sign-in when its answer would matter: an API key, a
  // custom endpoint or a cloud provider outranks it, and without the executable there
  // is nothing to ask.
  const off = (v: string | undefined): boolean =>
    v === undefined || v.length === 0 || v === '0' || v.toLowerCase() === 'false';
  const askAuth =
    hasClaudeCode &&
    off(env.CLAUDE_CODE_USE_BEDROCK) &&
    off(env.CLAUDE_CODE_USE_VERTEX) &&
    off(env.ANTHROPIC_BASE_URL) &&
    off(env.ANTHROPIC_API_KEY);
  const provider = describeProvider(env, {
    hasClaudeCode,
    claudeAuth: askAuth ? probes.claudeAuth() : null,
  });
  if (provider.kind === 'none') {
    return {
      name: 'model access',
      status: 'warn',
      detail: `${provider.detail} — search and file reading still work without it`,
      fix:
        provider.fix ??
        'Install Claude Code and sign in, set ANTHROPIC_API_KEY, or point curatorEnv.ANTHROPIC_BASE_URL at a local model',
    };
  }
  const viaConfig = cfg !== undefined && Object.keys(cfg.curatorEnv).length > 0;
  return {
    name: 'model access',
    status: 'ok',
    detail: `${provider.detail}${viaConfig ? ' (via curatorEnv)' : ''}`,
  };
}

/**
 * Checks are ordered by what blocks what: an unusable Node makes everything else
 * moot, and there is no point reporting on repos when the config that names them
 * could not be read.
 */
export function runChecks(configPath: string | null, probes: Probes): Check[] {
  const checks: Check[] = [];

  const major = majorOf(probes.nodeVersion);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: probes.nodeVersion }
      : {
          name: 'node',
          status: 'fail',
          detail: `${probes.nodeVersion} — this needs ${MIN_NODE_MAJOR} or newer`,
          fix: 'Install Node 20 or newer: winget install OpenJS.NodeJS.LTS (Windows), brew install node (macOS), or nodejs.org',
        },
  );

  checks.push(
    probes.ripgrepPath !== null
      ? { name: 'ripgrep', status: 'ok', detail: 'bundled binary found' }
      : {
          name: 'ripgrep',
          status: 'fail',
          detail: 'the bundled search binary is missing — code search cannot run',
          fix: 'Reinstall to re-run the download: npm install -g repos-expert',
        },
  );

  if (configPath === null) {
    checks.push(modelAccessCheck(probes, undefined));
    checks.push({
      name: 'config',
      status: 'fail',
      detail: 'no config file found',
      fix: 'expert init',
    });
    return checks; // Everything below reads the config; guessing would only mislead.
  }

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    checks.push({
      name: 'config',
      status: 'fail',
      detail: `${configPath} — ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Fix the file by hand, or start over with: expert init --force',
    });
    checks.push(modelAccessCheck(probes, undefined));
    return checks;
  }
  checks.push({ name: 'config', status: 'ok', detail: configPath });
  checks.push(modelAccessCheck(probes, cfg));

  const reposExists = fs.existsSync(cfg.reposDir);
  checks.push(
    reposExists
      ? { name: 'repos folder', status: 'ok', detail: cfg.reposDir }
      : {
          name: 'repos folder',
          status: 'fail',
          detail: `${cfg.reposDir} does not exist`,
          fix: `Create it, or point "reposDir" somewhere real: expert init --repos-dir "<path>" --force`,
        },
  );

  const projects = reposExists ? countProjects(cfg.reposDir) : 0;
  const listed = readReposList(cfg.reposListFile).entries.length;
  checks.push(
    projects > 0
      ? {
          name: 'projects',
          status: 'ok',
          detail: `${projects} project${projects === 1 ? '' : 's'} found${listed > 0 ? `, ${listed} listed in repos.txt` : ''}`,
        }
      : {
          name: 'projects',
          status: 'warn',
          detail: listed > 0 ? `${listed} listed but none cloned yet` : 'the folder is empty',
          fix: listed > 0 ? 'expert sync' : 'expert add <url>, or copy project folders in',
        },
  );

  const curated = countCurated(cfg.knowledgeDir);
  checks.push(
    curated > 0
      ? { name: 'knowledge', status: 'ok', detail: `${curated} studied — ${cfg.knowledgeDir}` }
      : {
          name: 'knowledge',
          status: 'warn',
          detail: 'nothing studied yet — only live code search will answer',
          fix: 'expert refresh <project>',
        },
  );

  checks.push(
    canWrite(cfg.knowledgeDir)
      ? { name: 'knowledge writable', status: 'ok', detail: 'yes' }
      : {
          name: 'knowledge writable',
          status: 'fail',
          detail: `cannot write to ${cfg.knowledgeDir}`,
          fix: 'Point "knowledgeDir" at a folder you own',
        },
  );

  checks.push(
    probes.hasCommand('git')
      ? { name: 'git', status: 'ok', detail: 'on PATH' }
      : {
          name: 'git',
          status: 'warn',
          detail: 'not on PATH — cloning and staleness checks need it',
          fix: 'winget install Git.Git (Windows), brew install git (macOS), or your package manager',
        },
  );

  // Last because it is the last mile: everything above can be perfect and the
  // assistant still runs a server from somewhere else.
  const client = clientLaunchCheck(probes);
  if (client !== null) checks.push(client);

  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export function formatDiagnosis(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `  ${MARK[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);

  // One thing to do next beats a wall of advice: the first blocker is what to fix.
  const blockers = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  const first = blockers[0] ?? warnings[0];

  if (first === undefined) {
    lines.push('', 'All good — ready to answer questions.');
  } else {
    lines.push(
      '',
      blockers.length > 0
        ? `${blockers.length} problem${blockers.length === 1 ? '' : 's'} to fix. Start with "${first.name}":`
        : `Nothing broken. To get more out of it, "${first.name}":`,
      `  ${first.fix ?? 'see above'}`,
    );
  }
  return lines.join('\n');
}
