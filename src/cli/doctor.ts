import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
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
  hasApiKey: boolean;
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
          fix: 'Install Node LTS: winget install OpenJS.NodeJS.LTS',
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

  const claude = probes.hasCommand('claude');
  checks.push(
    claude || probes.hasApiKey
      ? {
          name: 'model access',
          status: 'ok',
          detail: claude ? 'Claude Code is on PATH' : 'ANTHROPIC_API_KEY is set',
        }
      : {
          name: 'model access',
          status: 'warn',
          detail:
            'no Claude Code and no ANTHROPIC_API_KEY — studying repos will fail, but search and file reading still work',
          fix: 'Install Claude Code and sign in, or set ANTHROPIC_API_KEY',
        },
  );

  if (configPath === null) {
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
    return checks;
  }
  checks.push({ name: 'config', status: 'ok', detail: configPath });

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
          fix: 'winget install Git.Git',
        },
  );

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
