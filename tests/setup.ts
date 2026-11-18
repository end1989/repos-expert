import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDirs } from './helpers.js';

// Git in tests must not depend on the machine running them: commit signing, hooks,
// autocrlf or a default branch name in someone's global or system config would change
// what a test sees. Every git process a test starts inherits these.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-gitconfig-'));
const emptyConfig = path.join(configDir, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Nor on the developer's own repos-expert setup: an EXPERT_CONFIG pointing at their real
// config would decide which config the tests load. A test that wants one sets it.
delete process.env.EXPERT_CONFIG;

afterAll(() => {
  removeTempDirs();
  fs.rmSync(configDir, { recursive: true, force: true });
});
