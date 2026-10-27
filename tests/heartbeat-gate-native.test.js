import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('heartbeat gate runs with the pinned isolated Python and SQLite offline', {
  skip: process.env.SOMA_RUNTIME_INTEGRATION !== '1'
}, () => {
  const runtime = process.env.SOMA_RUNTIME_HOME;
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  assert.equal(runtime, path.resolve(process.env.RUNNER_TEMP, 'soma-hermes-runtime'));
  const python = fs.readFileSync(path.join(runtime, 'hermes-python.txt'), 'utf8').trim();
  const result = spawnSync(python, ['-I', '-B', 'tests/heartbeat_gate_test.py'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
