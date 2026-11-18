#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { rgPath } from '@vscode/ripgrep';
import { formatDiagnosis, runChecks } from './doctor.js';
import { estimateBatch, formatDryRun, formatEstimate, needsConfirmation } from './estimate.js';
import { findConfigPath, loadConfig, parseConcurrency, userConfigPath } from '../config.js';
import { readTextFile } from '../paths.js';
import { addToReposList } from '../repos-list.js';
import { gatherHelpState, helpText } from './help.js';
import { claudeDesktopConfigPath, runInit, suggestReposDir } from './init.js';
import { claudeAuthStatus, onPath } from './probes.js';
import { describeCitations, describeRun, oneLineError } from './messages.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses, getRepoStatus, scanRepos } from '../registry.js';
import { startMcpOrExplain } from '../mcp/server.js';
import { VERSION } from '../version.js';
// The curator (and with it the Claude Agent SDK) is imported lazily, only where it is
// about to spend: `expert mcp` runs in every client session and must not load what it never uses.

/**
 * Command wiring: options in, a call into a module, output and exit code out. Anything
 * with a decision in it lives in the module the command calls.
 */

const program = new Command();

const version = VERSION;

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
  const opt = program.opts<{ config?: string }>().config;
  if (opt !== undefined && opt.length > 0) {
    profileConfig = path.resolve(opt);
    process.env.EXPERT_CONFIG = profileConfig;
  }
});

/** Asks a yes/no question when someone is at the terminal; anything but yes is no. */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

program
  .command('init')
  .description('Set up config and connect this to Claude Desktop — run this first')
  .option('--repos-dir <path>', 'folder holding your project folders')
  .option('--github-user <name>', 'only needed to pull repos from GitHub')
  .option('--force', 'overwrite an existing config')
  .option('--skip-client', 'do not touch the Claude Desktop config')
  .option('--skip-workspace-guide', 'do not write CLAUDE.md into your repos folder')
  .option(
    '--name <label>',
    'with --config: label for this collection (client entry becomes repos-expert-<label>)',
  )
  .option('-y, --yes', 'accept the default repos folder without asking')
  .action(
    async (opts: {
      reposDir?: string;
      githubUser?: string;
      force?: boolean;
      skipClient?: boolean;
      skipWorkspaceGuide?: boolean;
      name?: string;
      yes?: boolean;
    }) => {
      const configPath = profileConfig ?? userConfigPath();
      // Only a new config needs a folder. An existing one already names it, and init reports
      // that — a guess here would draw a spurious "re-run with --force", and with --force
      // would quietly move the collection.
      if (opts.reposDir === undefined && !fs.existsSync(configPath)) {
        // Guessing the folder is what leaves people staring at an empty one, so ask
        // whenever there is someone there to answer.
        const suggestion = suggestReposDir();
        if (opts.yes !== true && process.stdin.isTTY) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (await rl.question(`Where are your projects? [${suggestion}] `)).trim();
            opts.reposDir = answer.length > 0 ? answer : suggestion;
          } finally {
            rl.close();
          }
        } else {
          opts.reposDir = suggestion;
        }
      }

      const res = runInit(opts, {
        configPath,
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
    },
  );

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
      const sync = await syncRepos(
        cfg,
        undefined,
        res.added.map((e) => e.name),
      );
      console.log(`cloned ${sync.synced.length}, failed ${sync.failed.length}`);
      for (const f of sync.failed) console.error(`  FAILED ${f.name}: ${oneLineError(f.error)}`);
      if (sync.failed.length > 0) process.exitCode = 1;
      else if (sync.synced.length > 0) {
        console.log(`Next: expert refresh ${sync.synced.join(' ')}`);
      }
    }
  });

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
    console.log(helpText(await gatherHelpState(version)));
  });

program
  .command('sync')
  .description(
    'Clone or update everything in repos.txt, and GitHub if configured (optional — copying folders in works too)',
  )
  .action(async () => {
    const cfg = loadConfig();
    const res = await syncRepos(cfg);
    if (res.nothingToSync !== undefined) {
      console.log(res.nothingToSync);
      return;
    }
    console.log(
      `synced ${res.synced.length}, skipped ${res.skipped.length}, failed ${res.failed.length}`,
    );
    for (const f of res.failed) console.error(`  FAILED ${f.name}: ${oneLineError(f.error)}`);
    if (res.failed.length > 0) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Check the setup and say what to fix — run this when something is not working')
  .option('--json', 'print the checks as JSON')
  .action((opts: { json?: boolean }) => {
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
          : {
              path: clientPath,
              text: fs.existsSync(clientPath) ? readTextFile(clientPath) : null,
            },
    });
    console.log(opts.json === true ? JSON.stringify({ checks }, null, 2) : formatDiagnosis(checks));
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program
  .command('status')
  .description('Show what was found in your repos folder and what has been studied')
  .option('--json', 'print the repos and skipped folders as JSON')
  .action(async (opts: { json?: boolean }) => {
    const cfg = loadConfig();
    const { statuses, skipped } = await scanRepos(cfg);
    console.log(
      opts.json === true
        ? JSON.stringify({ repos: statuses, skipped }, null, 2)
        : formatStatus(statuses, cfg, skipped),
    );
  });

program
  .command('mcp')
  .description(
    'Start the MCP server on stdio (for Claude Desktop, Claude Code, Copilot, or any MCP client)',
  )
  .option(
    '--http',
    'serve over Streamable HTTP instead of stdio (for clients that only speak HTTP)',
  )
  .option(
    '--host <host>',
    'address to bind with --http (default 127.0.0.1 — loopback only)',
    '127.0.0.1',
  )
  .option('--port <n>', 'port for --http', (v: string) => Number(v), 7411)
  .option(
    '--token <token>',
    'bearer token clients must send with --http (default: EXPERT_HTTP_TOKEN, else generated and printed once)',
  )
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
    const token =
      opts.token ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : generateToken());
    const generated = opts.token === undefined && token !== fromEnv;

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
    // A dry run of a named repo or of the portfolio pass is answered before the curator
    // (and the Agent SDK) is even imported: "without doing it" means no model call.
    // A named repo always takes this path, even alongside --all/--stale (commander accepts
    // the combination, and a real run then curates the repo and the portfolio).
    // The batch forms handle --dry-run below, after working out what is stale.
    if (
      opts.dryRun === true &&
      (repoArg !== undefined ||
        (opts.portfolio === true && opts.all !== true && opts.stale !== true))
    ) {
      if (repoArg !== undefined) {
        await getRepoStatus(cfg, repoArg); // an unknown or invalid name fails here, as it would for real
        console.log(formatDryRun([repoArg], estimateBatch(1, 1)));
      }
      if (opts.portfolio === true || opts.all === true || opts.stale === true) {
        console.log(
          'The portfolio pass would rewrite portfolio.md and cross-repo-map.md.\n' +
            'Dry run — nothing was studied and nothing was spent. Drop --dry-run to go ahead.',
        );
      }
      return;
    }
    if (
      repoArg === undefined &&
      opts.all !== true &&
      opts.stale !== true &&
      opts.portfolio !== true
    ) {
      console.error('Specify a repo, --all, --stale, or --portfolio.');
      process.exitCode = 1;
      return;
    }

    // Writing docs takes the same lock as refresh: two batches never write the same folder.
    const { withRefreshLock } = await import('./refresh.js');
    let failures = 0;
    const run = async (): Promise<void> => {
      if (repoArg !== undefined) {
        const { curateRepo } = await import('../curator/curator.js');
        console.error(`studying ${repoArg} — usually a few minutes…`);
        const { stats, citations } = await curateRepo(cfg, await getRepoStatus(cfg, repoArg));
        const notes = [
          stats !== undefined ? describeRun(stats) : '',
          describeCitations(citations),
        ].filter((n) => n.length > 0);
        console.log(`curated ${repoArg}${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}`);
      } else if (opts.all === true || opts.stale === true) {
        // Scanned while holding the lock: a run that has just finished is seen as finished,
        // not studied again from a picture taken before it ended.
        const statuses = await listRepoStatuses(cfg);
        if (statuses.length === 0) {
          // Not "everything is fresh": there is nothing here at all, which is a setup problem.
          console.error(
            fs.existsSync(cfg.reposDir)
              ? `No git repositories found in ${cfg.reposDir}.`
              : `The repos folder does not exist yet: ${cfg.reposDir}.`,
          );
          process.exitCode = 1;
          return;
        }
        let targets = opts.stale === true ? statuses.filter((s) => s.state !== 'fresh') : statuses;
        if (opts.stale === true) {
          // Stale only in docs/CI/lockfiles → re-verified for free, not studied again.
          const { partitionStale } = await import('./reverify.js');
          const split = await partitionStale(
            cfg,
            targets,
            undefined,
            opts.dryRun === true ? 'dry-run' : 'apply',
          );
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
              : formatDryRun(
                  targets.map((t) => t.name),
                  estimateBatch(targets.length, concurrency),
                ),
          );
          return;
        }
        if (targets.length === 0) {
          console.log('Nothing to curate — everything is fresh.');
        } else {
          console.log(formatEstimate(estimateBatch(targets.length, concurrency), targets.length));
          if (
            opts.yes !== true &&
            needsConfirmation(targets.length, process.stdin.isTTY) &&
            !(await confirm('\nStart? [y/N] '))
          ) {
            console.log('Stopped. Nothing was studied, nothing was spent.');
            return;
          }
          console.log(`\ncurating ${targets.length} repos, ${concurrency} at a time`);
        }
        const { curateMany } = await import('./curate-many.js');
        failures += (await curateMany(cfg, targets, undefined, concurrency)).length;
      }

      if (opts.all === true || opts.stale === true || opts.portfolio === true) {
        try {
          const { curatePortfolio } = await import('../curator/curator.js');
          const stats = await curatePortfolio(cfg);
          console.log(`curated portfolio${stats !== undefined ? ` — ${describeRun(stats)}` : ''}`);
        } catch (err) {
          failures += 1;
          console.error(`FAILED portfolio: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    if (opts.dryRun === true) await run();
    else await withRefreshLock(cfg.knowledgeDir, run);
    if (failures > 0) process.exitCode = 1;
  });

program
  .command('refresh')
  .description(
    'Update repos, re-study anything out of date (or the named repos), then the portfolio',
  )
  .argument('[repos...]', 'limit to these repos and curate them unconditionally')
  .option('-y, --yes', 'do not ask before a long batch')
  .option(
    '--dry-run',
    'show what would be studied, and what it would cost, without syncing or studying',
  )
  .action(async (repos: string[], opts: { yes?: boolean; dryRun?: boolean }) => {
    const cfg = loadConfig();
    const { runRefresh } = await import('./refresh.js');
    const res = await runRefresh(cfg, repos.length > 0 ? repos : undefined, undefined, {
      dryRun: opts.dryRun === true,
      confirm: async (targets) => {
        console.log(
          formatEstimate(estimateBatch(targets.length, cfg.curateConcurrency), targets.length),
        );
        if (opts.yes === true || !needsConfirmation(targets.length, process.stdin.isTTY))
          return true;
        return confirm('\nStart? [y/N] ');
      },
    });
    if (opts.dryRun === true) {
      if (res.reverified.length > 0)
        console.log(`would be re-verified without the model: ${res.reverified.join(', ')}`);
      if (res.uncurated.length > 0) {
        console.log(
          `not studied yet, and not studied by a plain refresh: ${res.uncurated.join(', ')} — name them to study them`,
        );
      }
      console.log(
        res.planned.length === 0
          ? 'Nothing to study — every studied repo is up to date.\nDry run — nothing was synced, nothing was studied and nothing was spent.'
          : formatDryRun(res.planned, estimateBatch(res.planned.length, cfg.curateConcurrency)),
      );
      return;
    }
    if (res.cancelled) {
      console.log('Stopped. Nothing was studied, nothing was spent.');
      return;
    }
    if (res.syncNote !== null) console.log(res.syncNote);
    const portfolio =
      res.portfolioSkipped !== null
        ? `skipped (${res.portfolioSkipped})`
        : res.portfolioOk
          ? 'ok'
          : 'FAILED';
    console.log(
      `sync: ${res.synced} ok, ${res.syncFailed.length} failed | curate: ${res.curated} ok, ${res.curateFailed.length} failed${
        res.reverified.length > 0 ? `, ${res.reverified.length} re-verified without the model` : ''
      } | portfolio: ${portfolio}`,
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

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
