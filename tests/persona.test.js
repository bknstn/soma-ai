import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('persona setup refreshes language and style policies safely in new and existing runtimes', () => {
  const result = spawnSync('python3', ['-I', '-B', 'tests/persona_test.py'], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
