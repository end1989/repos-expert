#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { syncRepos } from './sync.js';
import { formatStatus } from './status.js';
import { listRepoStatuses } from '../registry.js';
import { startMcp } from '../mcp/server.js';

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

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
