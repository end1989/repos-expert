#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses, getRepoStatus } from '../registry.js';
import { startMcp } from '../mcp/server.js';
import { curateRepo, curatePortfolio } from '../curator/curator.js';
import { curateMany } from './curate-many.js';
import { runRefresh } from './refresh.js';

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

program
  .command('mcp')
  .description('Start the MCP server on stdio (for `claude mcp add`)')
  .action(async () => {
    const cfg = loadConfig();
    await startMcp(cfg);
  });

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
      failures += (await curateMany(cfg, targets)).length;
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
