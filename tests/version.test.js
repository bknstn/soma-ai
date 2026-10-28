import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.js';
import { runRuntimeCli } from '../src/runtime/cli.js';
import { releaseNotes } from '../scripts/check-release.js';

const metadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const notesFor = (version, notes = '- Synthetic release feature.') =>
  `# Changelog\n\n## [Unreleased]\n\n- Future change.\n\n## [${version}] - 2026-10-28\n\n${notes}\n\n## [0.0.1] - 2026-10-01\n\n- Previous change.\n`;

test('both CLIs report the package version without creating clients or runtimes', async () => {
  for (const run of [runCli, runRuntimeCli]) {
    for (const flag of ['--version', '-v']) {
      let output = '';
      let errors = '';
      const unexpected = () => assert.fail('version reporting must not initialize a dependency');
      const code = await run([flag], {
        env: {},
        stdout: { write(chunk) { output += chunk; } },
        stderr: { write(chunk) { errors += chunk; } },
        loadConfig: unexpected,
        createClient: unexpected,
        createRuntimeManager: unexpected
      });
      assert.equal(code, 0);
      assert.equal(output, `${metadata.version}\n`);
      assert.equal(errors, '');
    }
  }
});

test('version flags do not swallow commands or their arguments', async () => {
  for (const run of [runCli, runRuntimeCli]) {
    for (const args of [['--version', 'doctor'], ['doctor', '--version'], ['--version', '--json']]) {
      const unexpected = () => assert.fail('invalid arguments must not initialize a dependency');
      const code = await run(args, {
        env: {}, stdout: { write() {} }, stderr: { write() {} },
        createClient: unexpected, createRuntimeManager: unexpected
      });
      assert.equal(code, 2, args.join(' '));
    }
  }
});

test('real CLI entry points report the version from an unrelated working directory', () => {
  for (const entry of ['../src/cli.js', '../src/runtime/cli.js']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), '--version'], {
      cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${metadata.version}\n`);
    assert.equal(result.stderr, '');
  }
});

test('release check extracts only the selected notes and accepts SemVer prereleases', () => {
  for (const version of ['0.1.0', '1.0.0', '0.2.0-rc.1', '0.2.0-alpha-beta.0+build.01']) {
    const changelog = notesFor(version);
    assert.equal(releaseNotes({ version, changelog, tag: `v${version}` }), '- Synthetic release feature.\n');
    assert.equal(releaseNotes({ version, changelog: changelog.replaceAll('\n', '\r\n') }), '- Synthetic release feature.\n');
  }
});

test('release check rejects malformed versions and mismatched tags', () => {
  for (const version of ['v0.1.0', '0.1', '01.1.0', '0.1.0-01', '0.1.0-', '0.1.0+', '0.1.0\n', undefined]) {
    assert.throws(() => releaseNotes({ version, changelog: notesFor(version) }), /SemVer/);
  }
  for (const tag of ['0.1.0', 'v0.2.0', 'v0.1.0-rc.1', 'v0.1.0\n']) {
    assert.throws(() => releaseNotes({ version: '0.1.0', changelog: notesFor('0.1.0'), tag }), /Release tag/);
  }
});

test('release check requires unique, dated, nonempty release notes', () => {
  const valid = notesFor('0.1.0');
  for (const changelog of [
    notesFor('0.2.0'),
    valid + '\n## [0.1.0] - 2026-10-28\n\n- Duplicate.\n',
    valid.replace('2026-10-28', '2026-02-30'),
    valid.replace(' - 2026-10-28', ''),
    notesFor('0.1.0', ''),
    notesFor('0.1.0', '### Added')
  ]) {
    assert.throws(() => releaseNotes({ version: '0.1.0', changelog }));
  }
});

test('repository release metadata passes and a wrong tag fails with a nonzero exit', () => {
  const script = fileURLToPath(new URL('../scripts/check-release.js', import.meta.url));
  const run = (tag) => spawnSync(process.execPath, [script, tag], {
    cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 10000
  });
  const valid = run(`v${metadata.version}`);
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, releaseNotes({
    version: metadata.version,
    changelog: fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  }));
  assert.equal(valid.stderr, '');
  const invalid = run('v999.0.0');
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Release tag must equal/);
});
