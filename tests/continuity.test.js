import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('confirmed continuity and installer pass isolated synthetic contracts', () => {
  const result = spawnSync('python3', ['-I', '-B', 'tests/continuity_test.py'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
