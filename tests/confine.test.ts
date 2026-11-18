import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkToolCall, confineToRepo } from '../src/curator/confine.js';
import { makeTempDir } from './helpers.js';

// Built at module scope so `it.runIf` can see whether this machine can make a link.
const repo = makeTempDir('confine-repo-');
const outside = makeTempDir('confine-outside-');
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
let linkOk = false;
try {
  // 'junction' needs no privilege on Windows and is an ordinary symlink elsewhere.
  fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction');
  linkOk = true;
} catch {
  linkOk = false;
}

describe('checkToolCall — what the curator may touch', () => {
  it('lets Read open a file inside the repository', () => {
    expect(checkToolCall(repo, 'Read', { file_path: path.join(repo, 'src', 'index.ts') })).toEqual({
      allowed: true,
    });
  });

  it('lets Read name a file relative to the repository', () => {
    expect(checkToolCall(repo, 'Read', { file_path: 'src/index.ts' })).toEqual({ allowed: true });
  });

  it('refuses Read on an absolute path outside the repository', () => {
    const decision = checkToolCall(repo, 'Read', { file_path: path.join(outside, 'secret.txt') });
    expect(decision.allowed).toBe(false);
  });

  it('refuses Read that climbs out with ..', () => {
    const climbing = path.join(repo, '..', path.basename(outside), 'secret.txt');
    expect(checkToolCall(repo, 'Read', { file_path: climbing }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Read', { file_path: '../secret.txt' }).allowed).toBe(false);
  });

  it('refuses a sibling folder whose name merely starts with the repository name', () => {
    const sibling = `${repo}-evil`;
    expect(checkToolCall(repo, 'Read', { file_path: path.join(sibling, 'x.txt') }).allowed).toBe(
      false,
    );
  });

  it('refuses a home-relative path, which the agent runtime would expand outside the repo', () => {
    expect(checkToolCall(repo, 'Read', { file_path: '~/.ssh/id_rsa' }).allowed).toBe(false);
  });

  it('refuses Read with no usable file_path instead of guessing', () => {
    expect(checkToolCall(repo, 'Read', {}).allowed).toBe(false);
    expect(checkToolCall(repo, 'Read', { file_path: 42 }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Read', null).allowed).toBe(false);
  });

  it.runIf(linkOk)(
    'refuses a file reached through a link that points out of the repository',
    () => {
      const viaLink = path.join(repo, 'escape', 'secret.txt');
      expect(fs.readFileSync(viaLink, 'utf8')).toBe('top secret\n'); // the link really resolves
      expect(checkToolCall(repo, 'Read', { file_path: viaLink }).allowed).toBe(false);
    },
  );

  it('lets Glob and Grep search the repository when no path is given', () => {
    expect(checkToolCall(repo, 'Glob', { pattern: '**/*.ts' })).toEqual({ allowed: true });
    expect(checkToolCall(repo, 'Grep', { pattern: 'export' })).toEqual({ allowed: true });
  });

  it('lets Glob and Grep search a folder inside the repository', () => {
    expect(checkToolCall(repo, 'Glob', { pattern: '*.ts', path: path.join(repo, 'src') })).toEqual({
      allowed: true,
    });
    expect(checkToolCall(repo, 'Grep', { pattern: 'export', path: 'src', glob: '*.ts' })).toEqual({
      allowed: true,
    });
  });

  it('refuses Glob and Grep aimed at a folder outside the repository', () => {
    expect(checkToolCall(repo, 'Glob', { pattern: '*', path: outside }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Grep', { pattern: 'secret', path: outside }).allowed).toBe(false);
  });

  it('refuses a glob that reaches outside by itself', () => {
    expect(checkToolCall(repo, 'Glob', { pattern: '../**/*.txt' }).allowed).toBe(false);
    expect(
      checkToolCall(repo, 'Glob', { pattern: `${outside.replace(/\\/g, '/')}/*.txt` }).allowed,
    ).toBe(false);
    expect(checkToolCall(repo, 'Grep', { pattern: 'secret', glob: '../../**' }).allowed).toBe(
      false,
    );
    expect(checkToolCall(repo, 'Glob', { pattern: '~/**/*.pem' }).allowed).toBe(false);
  });

  it('accepts an absolute glob that stays inside the repository', () => {
    const inside = `${repo.replace(/\\/g, '/')}/src/**/*.ts`;
    expect(checkToolCall(repo, 'Glob', { pattern: inside })).toEqual({ allowed: true });
  });

  it('keeps the agent out of .git, where a remote URL can carry a token into the docs', () => {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n');
    expect(
      checkToolCall(repo, 'Read', { file_path: path.join(repo, '.git', 'config') }).allowed,
    ).toBe(false);
    expect(checkToolCall(repo, 'Read', { file_path: '.GIT/config' }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Grep', { pattern: 'url', path: '.git' }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Glob', { pattern: '.git/**' }).allowed).toBe(false);
    expect(checkToolCall(repo, 'Grep', { pattern: 'url', glob: '**/.git/*' }).allowed).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'refuses Windows paths that resolve somewhere other than they look',
    () => {
      const drive = repo.slice(0, 2); // e.g. "C:"
      // Drive-relative: "C:secret" is relative to the current folder on drive C, wherever that is.
      expect(checkToolCall(repo, 'Read', { file_path: `${drive}secret.txt` }).allowed).toBe(false);
      expect(checkToolCall(repo, 'Glob', { pattern: `${drive}/**/*.pem` }).allowed).toBe(false);
      expect(checkToolCall(repo, 'Glob', { pattern: `${drive}**/*.pem` }).allowed).toBe(false);
    },
  );

  it('judges a Grep or Glob path as the runtime will use it: trimmed, with ~ expanded', () => {
    // The runtime trims these and expands ~ after the hook has seen them.
    for (const p of [' ~/.ssh', '\t~/.ssh', '\n~', ' .git', '.git ', ' ~']) {
      expect(checkToolCall(repo, 'Grep', { pattern: 'KEY', path: p }).allowed, p).toBe(false);
      expect(checkToolCall(repo, 'Glob', { pattern: '*', path: p }).allowed, p).toBe(false);
    }
    expect(checkToolCall(repo, 'Grep', { pattern: 'KEY', path: '~' }).allowed).toBe(false);
  });

  it('allows an in-repository name that merely starts with ~', () => {
    fs.mkdirSync(path.join(repo, '~archive'), { recursive: true });
    expect(checkToolCall(repo, 'Grep', { pattern: 'x', path: '~archive' })).toEqual({
      allowed: true,
    });
  });

  it('refuses a Grep glob that would bring .git back into the search', () => {
    // The runtime adds --glob !.git, then the caller's globs; in ripgrep the later one wins.
    for (const glob of ['*', '**/*', '.*', '.gi?/**', '*.ts *', '*.ts,*', '[.]git/**']) {
      expect(checkToolCall(repo, 'Grep', { pattern: 'url', glob }).allowed, glob).toBe(false);
    }
    for (const glob of ['*.ts', '*.{ts,tsx}', 'src/**/*.ts', '!*.md']) {
      expect(checkToolCall(repo, 'Grep', { pattern: 'url', glob }), glob).toEqual({
        allowed: true,
      });
    }
  });

  it('refuses a network path without touching the network', () => {
    // Resolving \\host\share on Windows connects to that host and offers it the user's
    // NTLM credentials, so a network path must be refused before anything resolves it.
    const resolve = vi.spyOn(fs.realpathSync, 'native');
    try {
      const unc = ['\\\\attacker.invalid\\share\\x', '//attacker.invalid/share'];
      for (const p of unc) {
        expect(checkToolCall(repo, 'Read', { file_path: p }).allowed, p).toBe(false);
        expect(checkToolCall(repo, 'Grep', { pattern: 'x', path: p }).allowed, p).toBe(false);
      }
      expect(checkToolCall(repo, 'Glob', { pattern: '//attacker.invalid/share/**' }).allowed).toBe(
        false,
      );
      const touched = resolve.mock.calls.map((c) => String(c[0])).filter((p) => /attacker/.test(p));
      expect(touched).toEqual([]);
    } finally {
      resolve.mockRestore();
    }
  });

  it.runIf(linkOk)(
    'judges an absolute glob by every literal folder in it, even one named with } or ]',
    () => {
      // `}` and `]` only close a wildcard; alone they are ordinary characters, so the runtime
      // follows a folder named "x}" — here a link out of the repository.
      fs.symlinkSync(outside, path.join(repo, 'x}'), 'junction');
      const pattern = `${repo.replace(/\\/g, '/')}/x}/*.txt`;
      expect(checkToolCall(repo, 'Glob', { pattern }).allowed).toBe(false);
    },
  );

  it('refuses a path longer than any real one, before resolving it', () => {
    const long = `${'a/'.repeat(3000)}x`;
    expect(checkToolCall(repo, 'Read', { file_path: long }).allowed).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'reads a Git Bash drive path as the runtime does, and refuses Windows aliases of .git',
    () => {
      const bash = `/${repo[0]?.toLowerCase() ?? 'c'}${repo.slice(2).replace(/\\/g, '/')}/src`;
      expect(checkToolCall(repo, 'Grep', { pattern: 'x', path: bash })).toEqual({ allowed: true });
      expect(checkToolCall(repo, 'Grep', { pattern: 'x', path: '/c/Windows' }).allowed).toBe(false);
      for (const p of ['GIT~1./config', 'GIT~1/config', '.git./config']) {
        expect(checkToolCall(repo, 'Read', { file_path: p }).allowed, p).toBe(false);
      }
    },
  );

  it('refuses every tool that is not Read, Glob or Grep', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'mcp__gmail__send_message']) {
      expect(checkToolCall(repo, tool, { command: 'echo hi' }).allowed, tool).toBe(false);
    }
  });

  it('says why, so the model can correct course instead of retrying blindly', () => {
    const decision = checkToolCall(repo, 'Read', { file_path: path.join(outside, 'secret.txt') });
    expect(decision).toMatchObject({ allowed: false });
    expect(decision.allowed ? '' : decision.reason).toMatch(/outside the repository/i);
  });

  it.runIf(process.platform === 'win32')(
    'treats a path that differs only in letter case as the same place',
    () => {
      const upper = path.join(repo, 'src', 'index.ts').toUpperCase();
      expect(checkToolCall(repo, 'Read', { file_path: upper })).toEqual({ allowed: true });
    },
  );
});

describe('checkToolCall — a folder of repos, some excluded (the portfolio pass)', () => {
  const collection = makeTempDir('confine-collection-');
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(collection, name, 'src'), { recursive: true });
    fs.writeFileSync(path.join(collection, name, 'src', 'x.ts'), 'export {};\n');
  }
  const excluded = ['BETA']; // as the config spells it: excluded whatever the case

  it('refuses to read inside an excluded repo, and allows the others', () => {
    expect(
      checkToolCall(collection, 'Read', { file_path: 'beta/src/x.ts' }, excluded).allowed,
    ).toBe(false);
    expect(checkToolCall(collection, 'Read', { file_path: 'alpha/src/x.ts' }, excluded)).toEqual({
      allowed: true,
    });
  });

  it('refuses a search across the whole folder, which would cover the excluded repo too', () => {
    expect(checkToolCall(collection, 'Grep', { pattern: 'x' }, excluded).allowed).toBe(false);
    expect(checkToolCall(collection, 'Glob', { pattern: '**/*.ts' }, excluded).allowed).toBe(false);
    expect(
      checkToolCall(collection, 'Grep', { pattern: 'x', path: 'beta' }, excluded).allowed,
    ).toBe(false);
    expect(checkToolCall(collection, 'Grep', { pattern: 'x', path: 'alpha' }, excluded)).toEqual({
      allowed: true,
    });
  });

  it('searches the whole folder freely when nothing is excluded', () => {
    expect(checkToolCall(collection, 'Grep', { pattern: 'x' })).toEqual({ allowed: true });
  });
});

describe('confineToRepo — the hook the agent runtime calls before every tool', () => {
  const call = (toolName: string, toolInput: unknown) =>
    confineToRepo(repo)(
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 'toolu_test',
        session_id: 'session',
        transcript_path: '',
        cwd: repo,
      },
      'toolu_test',
      { signal: new AbortController().signal },
    );

  it('denies an out-of-repository read with a permission decision the runtime enforces', async () => {
    const out = await call('Read', { file_path: path.join(outside, 'secret.txt') });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('stays out of the way for an in-repository read', async () => {
    const out = await call('Read', { file_path: path.join(repo, 'src', 'index.ts') });
    expect(out).toEqual({});
  });
});
