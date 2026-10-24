import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.SOMA_RUNTIME_INTEGRATION === '1';

function runRuntime(args) {
  const result = spawnSync(process.execPath, ['src/runtime/cli.js', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: process.env.CI,
      SOMA_RUNTIME: 'hermes',
      SOMA_RUNTIME_HOME: process.env.SOMA_RUNTIME_HOME,
      HEALTH_OS_REPO: process.env.HEALTH_OS_REPO
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `runtime ${args.join(' ')} failed with ${result.status}: ${result.stderr.slice(0, 500)}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('managed Hermes runtime runs offline doctor, CLI help, and local skill loading', { skip: !enabled }, () => {
  const runnerTemp = process.env.RUNNER_TEMP;
  const runtimeHome = process.env.SOMA_RUNTIME_HOME;
  assert.ok(runnerTemp && path.isAbsolute(runnerTemp), 'RUNNER_TEMP must be an explicit absolute CI path');
  assert.equal(runtimeHome, path.resolve(runnerTemp, 'soma-hermes-runtime'), 'runtime home must use the fresh CI-only path');

  const homeStat = fs.lstatSync(runtimeHome);
  assert.ok(homeStat.isDirectory() && !homeStat.isSymbolicLink(), 'runtime home must be a real directory');
  const marker = JSON.parse(fs.readFileSync(path.join(runtimeHome, '.soma-runtime.json'), 'utf8'));
  assert.equal(marker.managed_by, 'soma-ai');
  assert.equal(marker.runtime, 'hermes');
  assert.equal(marker.setup_status, 'ready');

  assert.match(runRuntime(['doctor']), /hermes: ready/i);
  assert.match(runRuntime(['chat', '--help']), /usage/i);
  assert.match(runRuntime(['skills', 'list']), /soma-health/);
});
