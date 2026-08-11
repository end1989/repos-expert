import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';

const run = promisify(execFile);
export const MAX_MATCHES = 100;

function capLines(text: string): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length <= MAX_MATCHES) return lines.join('\n');
  return lines.slice(0, MAX_MATCHES).join('\n') + `\n… truncated to first ${MAX_MATCHES} results.`;
}

async function rg(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run(rgPath, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    if (e.code === 1) return ''; // rg exit 1 = no matches
    throw new Error(`ripgrep failed: ${e.stderr || String(err)}`);
  }
}

export async function searchText(root: string, query: string, glob?: string): Promise<string> {
  const args = ['-n', '--no-heading', '-S', '--max-columns', '250'];
  if (glob) args.push('-g', glob);
  args.push('--', query, '.');
  const out = await rg(args, root);
  return out.length === 0 ? 'No matches.' : capLines(out);
}

export async function listFiles(root: string, pattern: string): Promise<string> {
  const out = await rg(['--files', '-g', pattern], root);
  return out.length === 0 ? 'No matches.' : capLines(out);
}
