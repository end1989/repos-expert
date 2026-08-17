#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { rgPath } from '@vscode/ripgrep';
import { formatDiagnosis, runChecks } from './doctor.js';
import { parseClaudeAuthOutput, type ClaudeAuth } from '../provider.js';
import {
  estimateBatch,
  formatDryRun,
  formatEstimate,
  needsConfirmation,
} from './estimate.js';
import { findConfigPath, loadConfig, parseConcurrency, userConfigPath } from '../config.js';
import { addToReposList, readReposList } from '../repos-list.js';
import { helpText, type HelpState } from './help.js';
import { claudeDesktopConfigPath, runInit, suggestReposDir } from './init.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses, getRepoStatus } from '../registry.js';
import { startMcpOrExplain } from '../mcp/server.js';
// The curator (and with it the Claude Agent SDK) is imported lazily inside `curate` and
// `refresh`: `expert mcp` runs in every client session and must not load what it never uses.

const program = new Command();

// Read the real version rather than a literal that silently drifts from package.json.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

program
  .name('expert')
  .description('Answers questions about a folder of code repositories')
  .version(version)
  .option(
    '--config <path>',
    'use this config file instead of the default — a second collection with its own knowledge base',
  );

/**
 * `--config` names a profile: every command in this process reads that file, and the
 * knowledge base beside it. It is applied through EXPERT_CONFIG, which config
 * resolution already honours first, so nothing downstream needs to know.
 */
let profileConfig: string | null = null;
program.hook('preAction', () => {
  const opt = (program.opts() as { config?: string }).config;
  if (opt !== undefined && opt.length > 0) {
    profileConfig = path.resolve(opt);
    process.env.EXPERT_CONFIG = profileConfig;
  }
});

program
  .command('init')
  .description('Set up config and connect this to Claude Desktop — run this first')
  .option('--repos-dir <path>', 'folder holding your project folders')
  .option('--github-user <name>', 'only needed to pull repos from GitHub')
  .option('--force', 'overwrite an existing config')
  .option('--skip-client', 'do not touch the Claude Desktop config')
  .option('--skip-workspace-guide', 'do not write CLAUDE.md into your repos folder')
  .option('--name <label>', 'with --config: label for this collection (client entry becomes repos-expert-<label>)')
  .option('-y, --yes', 'accept the default repos folder without asking')
  .action(async (opts: {
    reposDir?: string;
    githubUser?: string;
    force?: boolean;
    skipClient?: boolean;
    skipWorkspaceGuide?: boolean;
    name?: string;
    yes?: boolean;
  }) => {
    // Guessing the folder is what leaves people staring at an empty one, so ask
    // whenever there is someone there to answer.
    const suggestion = suggestReposDir();
    if (opts.reposDir === undefined && opts.yes !== true && process.stdin.isTTY === true) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`Where are your projects? [${suggestion}] `)).trim();
        opts.reposDir = answer.length > 0 ? answer : suggestion;
      } finally {
        rl.close();
      }
    } else if (opts.reposDir === undefined) {
      opts.reposDir = suggestion;
    }

    const res = runInit(opts, {
      configPath: profileConfig ?? userConfigPath(),
      defaultConfigPath: userConfigPath(),
      clientConfigPath: claudeDesktopConfigPath(),
      entryPoint: fileURLToPath(import.meta.url),
    });
    console.log(
      res.configWritten ? `Wrote config: ${res.configPath}` : `Config: ${res.configPath}`,
    );
    console.log(`Projects folder: ${res.reposDir}`);
    if (res.clientWritten) console.log(`Connected to Claude Desktop: ${res.clientConfigPath}`);
    for (const note of res.notes) console.log(`  ${note}`);

    const listPath = res.reposListPath ?? path.join(res.reposDir, 'repos.txt');
    console.log('\nNext — get your projects in the folder, either way works:');
    console.log(`  a. Copy or clone project folders into ${res.reposDir}`);
    console.log(`  b. Add their git URLs to ${listPath}, then run \`expert sync\``);
    console.log(`     (or skip the editor: \`expert add <url>\` does both)`);
    console.log('\nThen:');
    console.log('  expert status                  # see what it found');
    console.log('  expert refresh <project>       # study one, check the result');
    console.log('  Restart Claude Desktop and ask "What projects do I have?"');
    if (!res.configWritten) {
      console.log(`\nWrong folder? Edit "reposDir" in ${res.configPath}, or re-run with`);
      console.log(`  expert init --repos-dir "<path>" --force`);
    }
  });

program
  .command('add')
  .description('Add git URLs to your project list and clone them')
  .argument('<urls...>', 'git URLs, or "name = url" to choose the folder name')
  .option('--no-sync', 'just add to the list, do not clone yet')
  .action(async (urls: string[], opts: { sync?: boolean }) => {
    const cfg = loadConfig();
    const res = addToReposList(cfg.reposListFile, urls);
    for (const problem of res.problems) console.error(`  ${problem}`);
    for (const name of res.alreadyListed) console.log(`  already listed: ${name}`);
    for (const entry of res.added) console.log(`  added: ${entry.name} <- ${entry.url}`);
    if (res.added.length > 0) console.log(`Updated ${cfg.reposListFile}`);
    if (res.problems.length > 0) process.exitCode = 1;

    if (opts.sync !== false && res.added.length > 0) {
      const sync = await syncRepos(cfg, undefined, res.added.map((e) => e.name));
      console.log(`cloned ${sync.synced.length}, failed ${sync.failed.length}`);
      for (const f of sync.failed) console.error(`  FAILED ${f.name}: ${oneLineError(f.error)}`);
      if (sync.failed.length > 0) process.exitCode = 1;
      else if (sync.synced.length > 0) {
        console.log(`Next: expert refresh ${sync.synced.join(' ')}`);
      }
    }
  });

/**
 * git's failure text is a transcript — "Cloning into…", "remote: …", "fatal: …" — and the
 * only line worth a summary is the last fatal/error one. Keep the whole thing out of a
 * one-line report; the user asked what failed, not for the log.
 */
function oneLineError(message: string): string {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const decisive = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l));
  return (decisive ?? lines[0] ?? message).replace(/^(fatal|error):\s*/i, '');
}
/**
 * Is a command installed? Looked up rather than executed — running `claude --version`
 * would need a shell on Windows, where it is a .cmd shim, and this file does not get
 * to be the one place that opens a shell.
 */
function onPath(cmd: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) return false;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(finder, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks Claude Code whether it is signed in (`claude auth status`, JSON). Never throws
 * and never opens a shell: the executable is located with where/which and run directly;
 * an npm `.cmd` shim on Windows is run through the package's cli.js with node instead
 * of through cmd.exe. Returns null whenever the answer cannot be trusted.
 */
function claudeAuthStatus(): ClaudeAuth | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  let found: string;
  try {
    found =
      execFileSync(finder, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0) ?? '';
  } catch {
    return null;
  }
  if (found.length === 0) return null;

  let file = found;
  let args = ['auth', 'status'];
  if (/\.(cmd|bat)$/i.test(found)) {
    const cli = path.join(path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (!fs.existsSync(cli)) return null;
    file = process.execPath;
    args = [cli, 'auth', 'status'];
  } else if (/\.ps1$/i.test(found)) {
    return null;
  }
  // spawnSync, not execFileSync: `claude auth status` exits 1 when signed out but still
  // prints the JSON — an exception here would throw away exactly the answer we want.
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (res.error !== undefined) return null;
  return parseClaudeAuthOutput(res.stdout ?? '');
}

/** Never throws: help is what you reach for when things are broken. */
async function currentHelpState(): Promise<HelpState> {
  const state: HelpState = {
    version,
    configPath: null,
    reposDir: null,
    reposListFile: null,
    listedCount: 0,
    repoCount: 0,
    curatedCount: 0,
    githubUser: null,
  };
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return state;
  }
  state.configPath = findConfigPath() ?? userConfigPath();
  state.reposDir = cfg.reposDir;
  state.reposListFile = cfg.reposListFile;
  state.githubUser = cfg.githubUser;
  try {
    state.listedCount = readReposList(cfg.reposListFile).entries.length;
  } catch { /* an unreadable list should not take the help text down */ }
  try {
    const statuses = await listRepoStatuses(cfg);
    state.repoCount = statuses.length;
    state.curatedCount = statuses.filter((s) => s.state !== 'uncurated').length;
  } catch { /* likewise a missing folder */ }
  return state;
}

program
  .command('help', { isDefault: true })
  .description('Where your files are, what state you are in, and what to run next')
  .argument('[command]', 'show the options for one command instead')
  .action(async (name?: string) => {
    if (name !== undefined) {
      const cmd = program.commands.find((c) => c.name() === name);
      if (cmd === undefined) {
        console.error(`No such command: ${name}`);
        process.exitCode = 1;
        return;
      }
      cmd.outputHelp();
      return;
    }
    console.log(helpText(await currentHelpState()));
  });

program
  .command('sync')
  .description('Pull repos from GitHub into your repos folder (optional — you can copy them in instead)')
  .action(async () => {
    const cfg = loadConfig();
    const res = await syncRepos(cfg);
    console.log(`synced ${res.synced.length}, skipped ${res.skipped.length}, failed ${res.failed.length}`);
    for (const f of res.failed) console.error(`  FAILED ${f.name}: ${oneLineError(f.error)}`);
    if (res.failed.length > 0) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Check the setup and say what to fix — run this when something is not working')
  .action(() => {
    const clientPath = claudeDesktopConfigPath();
    const checks = runChecks(findConfigPath(), {
      nodeVersion: process.version,
      ripgrepPath: fs.existsSync(rgPath) ? rgPath : null,
      hasCommand: onPath,
      env: process.env,
      version,
      claudeAuth: claudeAuthStatus,
      profileConfig,
      clientConfig:
        clientPath === null
          ? null
          : { path: clientPath, text: fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : null },
    });
    console.log(formatDiagnosis(checks));
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program
  .command('status')
  .description('Show what was found in your repos folder and what has been studied')
  .action(async () => {
    const cfg = loadConfig();
    console.log(formatStatus(await listRepoStatuses(cfg), cfg));
  });

program
  .command('mcp')
  .description('Start the MCP server on stdio (for Claude Desktop, Claude Code, Copilot, or any MCP client)')
  .option('--http', 'serve over Streamable HTTP instead of stdio (for clients that only speak HTTP)')
  .option('--host <host>', 'address to bind with --http (default 127.0.0.1 — loopback only)', '127.0.0.1')
  .option('--port <n>', 'port for --http', (v: string) => Number.parseInt(v, 10), 7411)
  .option('--token <token>', 'bearer token clients must send with --http (default: EXPERT_HTTP_TOKEN, else generated and printed once)')
  .action(async (opts: { http?: boolean; host: string; port: number; token?: string }) => {
    if (opts.http !== true) {
      await startMcpOrExplain(() => loadConfig());
      return;
    }
    const { startHttp, generateToken, isLoopback } = await import('../mcp/http.js');
    const { createServer, createUnconfiguredServer } = await import('../mcp/server.js');
    if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
      console.error('--port must be an integer between 0 and 65535');
      process.exitCode = 1;
      return;
    }
    const fromEnv = process.env.EXPERT_HTTP_TOKEN;
    const generated = opts.token === undefined && (fromEnv === undefined || fromEnv.length === 0);
    const token = opts.token ?? (generated ? generateToken() : (fromEnv as string));

    // Setup mode over HTTP too: a reachable server that explains beats a dead port.
    let makeServer: () => ReturnType<typeof createServer>;
    try {
      const cfg = loadConfig();
      makeServer = () => createServer(cfg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`repos-expert: starting in setup mode. ${reason}`);
      makeServer = () => createUnconfiguredServer(reason);
    }

    const handle = await startHttp(makeServer, { host: opts.host, port: opts.port, token });
    // stderr, deliberately: same habit as stdio mode, and it keeps stdout scriptable.
    console.error(`repos-expert MCP over HTTP: ${handle.url}`);
    console.error(`  health:  ${handle.url.replace(/\/mcp$/, '/health')}`);
    console.error(
      generated
        ? `  token:   ${token}   (generated for this run — pass --token or set EXPERT_HTTP_TOKEN to keep one)`
        : `  token:   ${opts.token !== undefined ? 'from --token' : 'from EXPERT_HTTP_TOKEN'}`,
    );
    console.error('  clients: send "Authorization: Bearer <token>" on every request');
    if (!isLoopback(opts.host)) {
      console.error(
        `  WARNING: bound to ${opts.host}, not loopback — anyone who can reach this port and has the token can read every repository in this collection. Put it behind TLS if it leaves this machine.`,
      );
    }
    const stop = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

interface CurateOptions {
  all?: boolean;
  stale?: boolean;
  portfolio?: boolean;
  concurrency?: number;
  yes?: boolean;
  dryRun?: boolean;
}

program
  .command('curate')
  .description('Run the curator agent to (re)write knowledge docs')
  .argument('[repo]', 'curate a single repo')
  .option('--all', 'study every repo in the folder, then the portfolio')
  .option('--stale', 'curate only stale/uncurated repos, then the portfolio')
  .option('--portfolio', 'run only the portfolio pass')
  .option(
    '--concurrency <n>',
    'repos to curate at once (default: config curateConcurrency)',
    parseConcurrency,
  )
  .option('-y, --yes', 'do not ask before a long batch')
  .option('--dry-run', 'show what would be studied, and what it would cost, without doing it')
  .action(async (repoArg: string | undefined, opts: CurateOptions) => {
    const cfg = loadConfig();
    const { curateRepo, curatePortfolio } = await import('../curator/curator.js');
    const { curateMany } = await import('./curate-many.js');
    let failures = 0;

    if (repoArg !== undefined) {
      await curateRepo(cfg, await getRepoStatus(cfg, repoArg));
      console.log(`curated ${repoArg}`);
    } else if (opts.all || opts.stale) {
      const statuses = await listRepoStatuses(cfg);
      let targets = opts.stale ? statuses.filter((s) => s.state !== 'fresh') : statuses;
      if (opts.stale) {
        // Stale only in docs/CI/lockfiles → re-verified for free, not studied again.
        const { partitionStale } = await import('./reverify.js');
        const split = await partitionStale(cfg, targets, undefined, opts.dryRun === true ? 'dry-run' : 'apply');
        targets = split.curate;
        if (split.reverified.length > 0) {
          console.log(
            `${split.reverified.length} unchanged in code since last studied — ${
              opts.dryRun === true ? 'would be re-verified' : 're-verified'
            } without the model: ${split.reverified.join(', ')}`,
          );
        }
      }
      const concurrency = opts.concurrency ?? cfg.curateConcurrency;
      if (opts.dryRun === true) {
        console.log(
          targets.length === 0
            ? 'Nothing to curate — everything is fresh.'
            : formatDryRun(targets.map((t) => t.name), estimateBatch(targets.length, concurrency)),
        );
        return;
      }
      if (targets.length === 0) {
        console.log('Nothing to curate — everything is fresh.');
      } else {
        console.log(formatEstimate(estimateBatch(targets.length, concurrency), targets.length));
        if (opts.yes !== true && needsConfirmation(targets.length, process.stdin.isTTY === true)) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = (await rl.question('\nStart? [y/N] ')).trim().toLowerCase();
          rl.close();
          if (answer !== 'y' && answer !== 'yes') {
            console.log('Stopped. Nothing was studied, nothing was spent.');
            return;
          }
        }
        console.log(`\ncurating ${targets.length} repos, ${concurrency} at a time`);
      }
      failures += (await curateMany(cfg, targets, undefined, concurrency)).length;
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

program
  .command('refresh')
  .description('Update repos, re-study anything out of date (or the named repos), then the portfolio')
  .argument('[repos...]', 'limit to these repos and curate them unconditionally')
  .action(async (repos: string[]) => {
    const cfg = loadConfig();
    const { runRefresh } = await import('./refresh.js');
    const res = await runRefresh(cfg, repos.length > 0 ? repos : undefined);
    console.log(
      `sync: ${res.synced} ok, ${res.syncFailed.length} failed | curate: ${res.curated} ok, ${res.curateFailed.length} failed${
        res.reverified.length > 0 ? `, ${res.reverified.length} re-verified without the model` : ''
      } | portfolio: ${res.portfolioOk ? 'ok' : 'FAILED'}`,
    );
    if (res.uncurated.length > 0) {
      console.log(
        `uncurated (not auto-curated — add with \`expert refresh <name>\`): ${res.uncurated.join(', ')}`,
      );
    }
    if (res.skipped.length > 0) {
      console.log(
        `skipped (excluded, or archived without "includeArchived" — not synced, not curated): ${res.skipped.join(', ')}`,
      );
    }
    for (const f of res.syncFailed) {
      console.error(`  FAILED ${f.name}: ${oneLineError(f.error)}`);
    }
    if (res.portfolioError !== null) console.error(`  FAILED portfolio: ${res.portfolioError}`);
    if (res.syncFailed.length + res.curateFailed.length > 0 || !res.portfolioOk) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
