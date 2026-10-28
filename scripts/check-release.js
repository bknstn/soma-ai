import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOMA_VERSION } from '../src/version.js';

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** Validate release metadata and return only the selected version's notes. */
export function releaseNotes({ version, changelog, tag }) {
  if (typeof version !== 'string' || !semver.test(version)) {
    throw new Error('package.json must contain a valid SemVer version.');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error('Release tag must equal v followed by the package.json version.');
  }
  const sections = [...changelog.matchAll(/^## (.+)\r?$/gm)];
  const matches = sections.filter((section) => section[1].startsWith(`[${version}]`));
  if (matches.length !== 1) throw new Error('Changelog must contain exactly one section for the package version.');
  const section = matches[0];
  const dateMatch = new RegExp(`^\\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - (\\d{4}-\\d{2}-\\d{2})$`).exec(section[1]);
  const date = dateMatch && new Date(`${dateMatch[1]}T00:00:00Z`);
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateMatch[1]) {
    throw new Error('Changelog release heading must include a valid YYYY-MM-DD date.');
  }
  const next = sections[sections.indexOf(section) + 1];
  const notes = changelog.slice(section.index + section[0].length, next?.index ?? changelog.length).trim();
  if (!notes || !notes.split('\n').some((line) => line.trim() && !line.trim().startsWith('#'))) {
    throw new Error('Changelog release notes must not be empty.');
  }
  return `${notes}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/check-release.js [vX.Y.Z]');
    process.stdout.write(releaseNotes({
      version: SOMA_VERSION,
      changelog: readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
      tag: process.argv[2]
    }));
  } catch (error) {
    process.stderr.write(`Release check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
