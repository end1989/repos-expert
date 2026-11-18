import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeAuthOutput, type ClaudeAuth } from '../provider.js';
import { findOnPath } from '../which.js';

/**
 * What `doctor` asks of the machine. Each answers without opening a shell and without
 * throwing: a probe that cannot tell returns "no" or null, and the check says so.
 */

/**
 * Is a command installed? Looked up rather than executed — running `claude --version`
 * would need a shell on Windows, where it is a .cmd shim, and this tool does not open one.
 * Looked up in-process, and only in absolute PATH folders: where.exe also searches the
 * folder doctor is started from (see which.ts).
 */
export function onPath(cmd: string): boolean {
  return findOnPath(cmd) !== null;
}

/**
 * Asks Claude Code whether it is signed in (`claude auth status`, JSON). The executable is
 * found on PATH and run directly; an npm `.cmd` shim on Windows is run through the
 * package's cli.js with node instead of through cmd.exe. Null whenever the answer cannot be
 * trusted.
 */
export function claudeAuthStatus(): ClaudeAuth | null {
  const found = findOnPath('claude');
  if (found === null) return null;

  let file = found;
  let args = ['auth', 'status'];
  if (/\.(cmd|bat)$/i.test(found)) {
    const cli = path.join(
      path.dirname(found),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js',
    );
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
  return parseClaudeAuthOutput(res.stdout);
}
