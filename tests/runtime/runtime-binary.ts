import { createRequire } from 'node:module';
import path from 'node:path';

/** The Claude Code binary the Agent SDK installed for this platform. */
export function runtimeBinary(): string {
  const require = createRequire(import.meta.url);
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [name, `${name}-musl`]) {
    let dir: string;
    try {
      dir = path.dirname(require.resolve(`${pkg}/package.json`));
    } catch {
      continue;
    }
    return path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  }
  throw new Error(`No Claude Code binary for ${process.platform}-${process.arch} is installed.`);
}
