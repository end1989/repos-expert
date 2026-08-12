#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { findConfigPath, loadConfig, userConfigPath } from '../config.js';
import { addToReposList, readReposList } from '../repos-list.js';
import { helpText, type HelpState } from './help.js';
import { claudeDesktopConfigPath, runInit, suggestReposDir } from './init.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses, getRepoStatus } from '../registry.js';
import { startMcp } from '../mcp/server.js';
import { curateRepo, curatePortfolio } from '../curator/curator.js';
import { curateMany, parseConcurrency } from './curate-many.js';
import { runRefresh } from './refresh.js';

const program = new Command();

// Read the real version rather than a literal that silently drifts from package.json.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

program.name('expert').description('Answers questions about a folder of code repositories').version(version);

program
  .command('init')
  .description('Set up config and connect this to Claude Desktop — run this first')
  .option('--repos-dir <path>', 'folder holding your project folders')
  .option('--github-user <name>', 'only needed to pull repos from GitHub')
  .option('--force', 'overwrite an existing config')
  .option('--skip-client', 'do not touch the Claude Desktop config')
  .option('--skip-workspace-guide', 'do not write CLAUDE.md into your repos folder')
  .option('-y, --yes', 'accept the default repos folder without asking')
  .action(async (opts: {
    reposDir?: string;
    githubUser?: string;
    force?: boolean;
    skipClient?: boolean;
    skipWorkspaceGuide?: boolean;
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
      configPath: userConfigPath(),
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
      for (const f of sync.failed) console.error(`  FAILED ${f.name}: ${f.error}`);
      if (sync.failed.length > 0) process.exitCode = 1;
      else if (sync.synced.length > 0) {
        console.log(`Next: expert refresh ${sync.synced.join(' ')}`);
      }
    }
  });

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
    for (const f of res.failed) console.error(`  FAILED ${f.name}: ${f.error}`);
    if (res.failed.length > 0) process.exitCode = 1;
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
  .action(async () => {
    const cfg = loadConfig();
    await startMcp(cfg);
  });

interface CurateOptions {
  all?: boolean;
  stale?: boolean;
  portfolio?: boolean;
  concurrency?: number;
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
  .action(async (repoArg: string | undefined, opts: CurateOptions) => {
    const cfg = loadConfig();
    let failures = 0;

    if (repoArg !== undefined) {
      await curateRepo(cfg, await getRepoStatus(cfg, repoArg));
      console.log(`curated ${repoArg}`);
    } else if (opts.all || opts.stale) {
      const statuses = await listRepoStatuses(cfg);
      const targets = opts.stale ? statuses.filter((s) => s.state !== 'fresh') : statuses;
      const concurrency = opts.concurrency ?? cfg.curateConcurrency;
      if (targets.length === 0) console.log('Nothing to curate — everything is fresh.');
      else console.log(`curating ${targets.length} repos, ${concurrency} at a time`);
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
    const res = await runRefresh(cfg, repos.length > 0 ? repos : undefined);
    console.log(
      `sync: ${res.synced} ok, ${res.syncFailed.length} failed | curate: ${res.curated} ok, ${res.curateFailed.length} failed | portfolio: ${res.portfolioOk ? 'ok' : 'FAILED'}`,
    );
    if (res.uncurated.length > 0) {
      console.log(
        `uncurated (not auto-curated — add with \`expert refresh <name>\`): ${res.uncurated.join(', ')}`,
      );
    }
    for (const f of res.syncFailed) {
      console.error(`  FAILED ${f.name}: ${f.error}`);
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
