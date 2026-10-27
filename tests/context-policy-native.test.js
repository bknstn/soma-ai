import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('context policy uses native YAML and pinned Hermes budget calculations offline', {
  skip: process.env.SOMA_RUNTIME_INTEGRATION !== '1'
}, () => {
  const runtime = process.env.SOMA_RUNTIME_HOME;
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  assert.equal(runtime, path.resolve(process.env.RUNNER_TEMP, 'soma-hermes-runtime'));
  const python = fs.readFileSync(path.join(runtime, 'hermes-python.txt'), 'utf8').trim();
  const result = spawnSync(python, ['-I', '-B', path.join(repoRoot, 'tests/context_policy_native_test.py')], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HERMES_RUNTIME_DIR: path.join(runtime, 'hermes-tools') }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
