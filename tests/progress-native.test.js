import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('progress uses pinned Hermes hooks and supervised tasks offline', {
  skip: process.env.SOMA_RUNTIME_INTEGRATION !== '1'
}, () => {
  const runtime = process.env.SOMA_RUNTIME_HOME;
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  assert.equal(runtime, path.resolve(process.env.RUNNER_TEMP, 'soma-hermes-runtime'));
  const python = fs.readFileSync(path.join(runtime, 'hermes-python.txt'), 'utf8').trim();
  const result = spawnSync(python, ['-I', '-B', 'tests/progress_native_test.py'], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HERMES_RUNTIME_DIR: path.join(runtime, 'hermes-tools'),
      SOMA_TEST_DEPENDENCY_HOME: path.join(runtime, 'hermes-home') }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
