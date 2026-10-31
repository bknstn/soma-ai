import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialFile, localDay, runSync, syncAndVerify } from '../scripts/sync-oura-day.js';

const date = '2026-02-14';
const observation = {
  date, source: { id: 'oura' },
  physical_metrics: [{ metric: 'hrv', status: 'observed', value: 50 }], proprietary_scores: []
};
function responses() {
  return [
    { data: { connector: 'oura', date, observation_set: structuredClone(observation) }, idempotency: { status: 'completed' } },
    { data: { truncated: false, matched_count: 1, observations: [structuredClone(observation)] } }
  ];
}

test('single-day sync verifies stored observations and reuses the occurrence identity on replay', () => {
  const queue = responses();
  queue[0].idempotency.status = 'replayed';
  const calls = [];
  const result = syncAndVerify({ date, requestId: 'synthetic-occurrence', invoke(...args) {
    calls.push(args); return queue.shift();
  } });
  assert.equal(result.status, 'verified');
  assert.equal(result.idempotency_status, 'replayed');
  assert.deepEqual(calls, [
    ['oura-sync-from-token', ['--date', date, '--idempotency-key', 'oura:2026-02-14:synthetic-occurrence'], true],
    ['wearable-observations', ['--source', 'oura', '--date', date], false]
  ]);
  assert.equal(JSON.stringify(result).includes('50'), false);
  assert.equal(Object.hasOwn(result, 'mode'), false);
});

test('unknown writes stop without a retry, a new identity, or a read-back success claim', () => {
  let calls = 0;
  assert.throws(() => syncAndVerify({ date, requestId: 'synthetic', invoke() {
    calls += 1; throw new Error('PRIVATE_SYNTHETIC_PROVIDER_ERROR');
  } }), { code: 'SOMA_SYNC_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
  for (const mutate of [
    (items) => { items[0].idempotency.status = 'pending'; },
    (items) => { items[0].data.observation_set.source.id = 'other'; },
    (items) => { items[1].data.truncated = true; },
    (items) => { items[1].data.observations[0].physical_metrics[0].value = 51; },
    (items) => { items[1].data.matched_count = 2; }
  ]) {
    const items = responses(); mutate(items);
    assert.throws(() => syncAndVerify({ date, requestId: 'synthetic', invoke() { return items.shift(); } }));
  }
});

test('an empty provider response is not reported as received measurements', () => {
  const items = responses();
  for (const sample of [items[0].data.observation_set, items[1].data.observations[0]]) {
    sample.physical_metrics = [{ metric: 'hrv', status: 'missing', value: null }];
  }
  assert.throws(() => syncAndVerify({ date, requestId: 'synthetic', invoke() { return items.shift(); } }),
    { code: 'SOMA_SYNC_NO_OBSERVATIONS' });
});

test('the operator gate and configured local calendar are checked before repository or credential access', async () => {
  await assert.rejects(runSync([], {}), { code: 'SOMA_SYNC_WRITES_DISABLED' });
  await assert.rejects(runSync([], { SOMA_HEALTH_ACTION_MODE: 'confirmed-writes' }), { code: 'SOMA_SYNC_TIMEZONE_REQUIRED' });
  assert.equal(localDay('Europe/Warsaw', new Date('2026-02-13T23:30:00Z')), '2026-02-14');
  assert.throws(() => localDay('Invalid/Zone'), { code: 'SOMA_SYNC_TIMEZONE_INVALID' });
  await assert.rejects(runSync(['--date', '2026-02-30'], { SOMA_HEALTH_ACTION_MODE: 'confirmed-writes', TZ: 'UTC' }),
    { code: 'SOMA_SYNC_DATE_INVALID' });
});

test('credential metadata rejects symlinks, shared permissions and files inside the workspace', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soma-oura-sync-test-')));
  try {
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const filename = path.join(root, 'synthetic.env'); fs.writeFileSync(filename, '', { mode: 0o600 });
    assert.equal(credentialFile(filename, [workspace]), fs.realpathSync(filename));
    fs.chmodSync(filename, 0o644);
    assert.throws(() => credentialFile(filename, [workspace]), { code: 'SOMA_SYNC_ENV_FILE_INVALID' });
    fs.chmodSync(filename, 0o600);
    const linked = path.join(root, 'linked.env'); fs.symlinkSync(filename, linked);
    assert.throws(() => credentialFile(linked, [workspace]), { code: 'SOMA_SYNC_ENV_FILE_INVALID' });
    assert.throws(() => credentialFile(filename, [root]), { code: 'SOMA_SYNC_ENV_FILE_LOCATION_INVALID' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
});
