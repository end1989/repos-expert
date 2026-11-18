import fs from 'node:fs';
import path from 'node:path';
import type { EnvLike } from './provider.js';

/**
 * Where a program is: found in the absolute folders on PATH, and never in the working folder.
 * Started by bare name, a program is looked for on Windows in the working folder before PATH,
 * and a relative PATH entry is read against the working folder on every platform. This tool
 * runs git inside the repositories it studies, so a git.exe committed to one would run in
 * git's place, as the user. Programs are found here instead, and started by their full path.
 *
 * On Windows each folder is tried with the extensions in PATHEXT, in order, or with
 * `extensions` when given (git must be an .exe or .com: anything else needs a shell).
 */
export function findOnPath(
  name: string,
  env: EnvLike = process.env,
  extensions?: readonly string[],
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const windows = process.platform === 'win32';
  const suffixes = windows
    ? (extensions ?? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')).map((e) => e.toLowerCase())
    : [''];
  for (const entry of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (dir.length === 0 || !path.isAbsolute(dir)) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (isProgram(candidate, windows)) return candidate;
    }
  }
  return null;
}

function isProgram(file: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
