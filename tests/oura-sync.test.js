import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialFile, localDay, runSync, syncAndVerify } from '../scripts/sync-oura-day.js';
import { HealthOsClient } from '../src/health-os-client.js';

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

test('the actual credential child stays isolated and refuses unsafe credentials before provider dispatch', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soma-oura-sync-test-')));
  const originalDoctor = HealthOsClient.prototype.doctor;
  const originalSecret = process.env.OPENAI_API_KEY;
  try {
    const repo = path.join(root, 'repo');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(workspace);
    const token = path.join(root, 'synthetic-token.json');
    fs.writeFileSync(token, '{}', { mode: 0o600 });
    const filename = path.join(root, 'synthetic.env');
    fs.writeFileSync(filename, [
      `HEALTH_OS_REPO=${repo}`, `HEALTH_OS_WORKSPACE=${workspace}`,
      'OURA_CLIENT_ID=SYNTHETIC_ID', 'OURA_CLIENT_SECRET=SYNTHETIC_SECRET',
      'OURA_REDIRECT_URI=http://localhost', `OURA_TOKEN_FILE=${token}`, ''
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(repo, 'src/cli.js'), `
      const fs = require('node:fs');
      const args = process.argv.slice(2), command = args[0];
      const date = args[args.indexOf('--date') + 1];
      const observation = { ...${JSON.stringify(observation)}, date };
      if (process.env.OPENAI_API_KEY || process.env.HOME) process.exit(91);
      if (command === 'oura-sync-from-token') {
        if (process.env.OURA_CLIENT_SECRET !== 'SYNTHETIC_SECRET') process.exit(92);
        fs.appendFileSync(${JSON.stringify(path.join(root, 'dispatch-count'))}, '1');
        console.log(JSON.stringify({ schema_version: 1, command, ok: true,
          idempotency: { status: 'completed' }, data: { connector: 'oura', date, observation_set: observation } }));
      } else {
        if (process.env.OURA_CLIENT_SECRET) process.exit(93);
        console.log(JSON.stringify({ schema_version: 1, command, ok: true,
          data: { matched_count: 1, truncated: false, observations: [observation] } }));
      }
    `);
    // Pin/workspace validation has its own real subprocess tests; mock only that
    // preflight so this fixture cannot contact a provider or require credentials.
    HealthOsClient.prototype.doctor = async () => ({
      workspace: { status: 'versioned', schema_version: 1 },
      capabilities: { commands: ['oura-sync-from-token', 'wearable-observations'], contracts: {
        json_envelope_commands: ['oura-sync-from-token', 'wearable-observations'],
        idempotency_commands: ['oura-sync-from-token']
      } }
    });
    process.env.OPENAI_API_KEY = 'SYNTHETIC_MUST_NOT_REACH_CHILD';
    const env = { PATH: process.env.PATH, TZ: 'UTC', SOMA_HEALTH_ACTION_MODE: 'confirmed-writes',
      HEALTH_OS_REPO: repo, HEALTH_OS_WORKSPACE: workspace, SOMA_HEALTH_ENV_FILE: filename };
    const result = await runSync(['--date', date, '--request-id', 'synthetic'], env);
    assert.equal(result.status, 'verified');
    fs.chmodSync(token, 0o644);
    await assert.rejects(runSync(['--date', date], env), { code: 'SOMA_SYNC_CREDENTIAL_METADATA_INVALID' });
    fs.chmodSync(token, 0o600);
    fs.appendFileSync(filename, 'UNEXPECTED_SETTING=SYNTHETIC\n');
    await assert.rejects(runSync(['--date', date], env), { code: 'SOMA_SYNC_CREDENTIAL_METADATA_INVALID' });
    assert.equal(fs.readFileSync(path.join(root, 'dispatch-count'), 'utf8'), '1');
  } finally {
    HealthOsClient.prototype.doctor = originalDoctor;
    if (originalSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalSecret;
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
});
