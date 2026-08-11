import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userConfigPath } from '../config.js';

export const PACKAGE_NAME = 'repos-expert';

export interface InitOptions {
  reposDir?: string;
  githubUser?: string;
  force?: boolean;
  skipClient?: boolean;
}

export interface InitResult {
  configPath: string;
  configWritten: boolean;
  clientConfigPath: string | null;
  clientWritten: boolean;
  notes: string[];
}

export interface InitPaths {
  configPath: string;
  clientConfigPath: string | null;
  entryPoint: string;
}

/** Where Claude Desktop keeps its MCP server list, or null on platforms without it. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform = process.platform): string | null {
  const appData = process.env.APPDATA;
  if (platform === 'win32' && appData !== undefined && appData.length > 0) {
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

/**
 * Installed from npm, the launch command must be `npx` — the package path is a
 * cache folder that changes. Run from a clone, point at the file directly.
 */
export function mcpLaunchCommand(entryPoint: string): { command: string; args: string[] } {
  // Separator-agnostic on purpose: this path can arrive as a Windows path or as
  // a POSIX one from fileURLToPath, and guessing wrong writes a broken command.
  const normalized = entryPoint.replace(/\\/g, '/');
  const installed = normalized.includes('/node_modules/') || normalized.includes('_npx');
  return installed
    ? { command: 'npx', args: ['-y', PACKAGE_NAME, 'mcp'] }
    : { command: 'node', args: [normalized, 'mcp'] };
}

/** Adds our server to a client config without disturbing anything already there. */
export function mergeClientConfig(
  existingJson: string | null,
  command: string,
  args: string[],
): string {
  let existing: Record<string, unknown> = {};
  if (existingJson !== null && existingJson.trim().length > 0) {
    try {
      existing = JSON.parse(existingJson) as Record<string, unknown>;
    } catch {
      throw new Error('The existing Claude Desktop config is not valid JSON — left it untouched.');
    }
  }
  const servers = { ...((existing.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  servers[PACKAGE_NAME] = { command, args };
  return `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
}

export function defaultConfigBody(opts: InitOptions): string {
  const body: Record<string, unknown> = {};
  if (opts.githubUser !== undefined && opts.githubUser.length > 0) {
    body.githubUser = opts.githubUser;
  }
  body.reposDir = (opts.reposDir ?? path.join(os.homedir(), 'repos')).replace(/\\/g, '/');
  body.knowledgeDir = path
    .join(path.dirname(userConfigPath()), 'knowledge')
    .replace(/\\/g, '/');
  body.model = 'claude-sonnet-5';
  body.excludeRepos = [];
  body.includeArchived = false;
  body.curateConcurrency = 2;
  body.curateTimeoutMinutes = 25;
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function runInit(opts: InitOptions, paths: InitPaths): InitResult {
  const notes: string[] = [];
  let configWritten = false;

  if (fs.existsSync(paths.configPath) && opts.force !== true) {
    notes.push(`Config already exists, left alone: ${paths.configPath}`);
  } else {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, defaultConfigBody(opts));
    configWritten = true;
  }

  let clientWritten = false;
  if (opts.skipClient === true) {
    notes.push('Skipped the Claude Desktop step.');
  } else if (paths.clientConfigPath === null) {
    notes.push(
      'No Claude Desktop config location on this platform — add the server to your MCP client by hand.',
    );
  } else {
    const { command, args } = mcpLaunchCommand(paths.entryPoint);
    const existing = fs.existsSync(paths.clientConfigPath)
      ? fs.readFileSync(paths.clientConfigPath, 'utf8')
      : null;
    if (existing !== null) {
      fs.copyFileSync(paths.clientConfigPath, `${paths.clientConfigPath}.backup`);
      notes.push(`Backed up the previous Claude Desktop config to ${paths.clientConfigPath}.backup`);
    }
    fs.mkdirSync(path.dirname(paths.clientConfigPath), { recursive: true });
    fs.writeFileSync(paths.clientConfigPath, mergeClientConfig(existing, command, args));
    clientWritten = true;
    notes.push('Quit Claude Desktop from the system tray and reopen it to pick this up.');
  }

  return {
    configPath: paths.configPath,
    configWritten,
    clientConfigPath: paths.clientConfigPath,
    clientWritten,
    notes,
  };
}
