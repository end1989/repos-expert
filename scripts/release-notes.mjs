#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for use as GitHub Release notes.
//
//   node scripts/release-notes.mjs 0.1.8            # section body + footer to stdout
//
// Used by .github/workflows/release.yml. Falls back to a one-line note when the version
// has no section, so a release is never blocked on a missing changelog entry — but the
// entry is the whole point, so write it first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (version.length === 0) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const repo = process.env.GITHUB_REPOSITORY ?? 'end1989/repos-expert';

export function sectionFor(lines, ver) {
  const start = lines.findIndex((l) => l.startsWith(`## [${ver}]`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

const body = sectionFor(changelog, version);
const footer =
  `\n\n---\n` +
  `npm: https://www.npmjs.com/package/repos-expert/v/${version} · ` +
  `full changelog: https://github.com/${repo}/blob/main/CHANGELOG.md`;

process.stdout.write((body && body.length > 0 ? body : `Release ${version}. See CHANGELOG.md.`) + footer + '\n');
if (body === null) console.error(`release-notes: no "## [${version}]" section in CHANGELOG.md — using a generic note`);
