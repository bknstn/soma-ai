import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'training-preparation.synthetic.json');
const healthyPreparation = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function sink() {
  const stream = new EventEmitter();
  stream.value = '';
  stream.write = (chunk) => { stream.value += chunk; return true; };
  return stream;
}

function testClient(overrides = {}) {
  return {
    async doctor() {
      return {
        version: { name: 'health-os', version: '0.1.0' },
        capabilities: { cli_json_schema_version: 1, commands: ['prepare-training'] },
        workspace: { status: 'versioned', schema_version: 1, profile_status: 'valid' }
      };
    },
    async initWorkspace() { return { initialized: true }; },
    async prepareTraining() { return healthyPreparation; },
    ...overrides
  };
}

test('help is available without Health OS configuration', async () => {
  const stdout = sink();
  const result = await runCli(['--help'], { stdout, stderr: sink() });
  assert.equal(result, 0);
  for (const command of ['doctor', 'init', 'prepare-training']) assert.match(stdout.value, new RegExp(`^  ${command}`, 'm'));
});

test('requires explicit repository and workspace configuration, and passes flag overrides through', async () => {
  const missingOut = sink();
  let clientCreated = false;
  const missingResult = await runCli(['doctor', '--json'], {
    stdout: missingOut,
    stderr: sink(),
    env: {},
    createClient() { clientCreated = true; return testClient(); }
  });
  assert.equal(missingResult, 2);
  assert.equal(clientCreated, false);
  assert.equal(JSON.parse(missingOut.value).error.code, 'SOMA_CONFIG_REQUIRED');

  const stdout = sink();
  let receivedConfig;
  const result = await runCli([
    'doctor', '--health-os-repo', '/tmp/synthetic-health-os', '--workspace', '/tmp/synthetic-workspace', '--json'
  ], {
    stdout,
    stderr: sink(),
    env: {},
    loadConfig: (options) => options,
    createClient(config) { receivedConfig = config; return testClient(); }
  });
  assert.equal(result, 0);
  assert.deepEqual(receivedConfig, { healthOsRepo: '/tmp/synthetic-health-os', workspace: '/tmp/synthetic-workspace' });

  let envConfig;
  const envResult = await runCli(['doctor', '--json'], {
    stdout: sink(),
    stderr: sink(),
    env: { HEALTH_OS_REPO: '/tmp/env-health-os', HEALTH_OS_WORKSPACE: '/tmp/env-workspace' },
    loadConfig: (options) => options,
    createClient(config) { envConfig = config; return testClient(); }
  });
  assert.equal(envResult, 0);
  assert.deepEqual(envConfig, { healthOsRepo: '/tmp/env-health-os', workspace: '/tmp/env-workspace' });
});

test('prepare-training defaults to an exact current instant and emits neutral JSON', async () => {
  const stdout = sink();
  const stderr = sink();
  let received;
  const client = testClient({
    async prepareTraining(options) { received = options; return healthyPreparation; }
  });

  const result = await runCli(['prepare-training', '--json'], {
    stdout,
    stderr,
    client,
    now: () => new Date('2026-10-24T10:00:00.123Z')
  });

  assert.equal(result, 0);
  assert.deepEqual(received, { asOf: '2026-10-24T10:00:00.123Z' });
  assert.equal(stderr.value, '');
  const envelope = JSON.parse(stdout.value);
  assert.deepEqual(Object.keys(envelope).sort(), ['command', 'data', 'ok', 'schema_version']);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.command, 'prepare-training');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.as_of, healthyPreparation.as_of.value);
  assert.equal(envelope.data.health_context.profile.content, 'SYNTHETIC_PROFILE_PRIVATE_TEXT');
  assert.equal(envelope.data.health_context.memory.status, 'available');
  assert.equal(stdout.value.includes('SYNTHETIC_EVENT_TEXT_SHOULD_NOT_BE_PRESENTED'), false);
});

test('date-only as-of is rejected before the client is called', async () => {
  const stdout = sink();
  const stderr = sink();
  let called = false;
  const result = await runCli(['prepare-training', '--as-of', '2026-10-24', '--json'], {
    stdout,
    stderr,
    client: testClient({ async prepareTraining() { called = true; return healthyPreparation; } })
  });

  assert.equal(result, 2);
  assert.equal(called, false);
  assert.equal(stderr.value, '');
  const envelope = JSON.parse(stdout.value);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'SOMA_INVALID_AS_OF');
  assert.match(envelope.error.message, /full RFC3339 timestamp/);
});

test('rejects RFC3339 values outside Health OS timestamp precision and offset bounds', async () => {
  for (const asOf of ['2026-10-24T10:00:00.1234Z', '2026-10-24T10:00:00+14:01', '0000-10-24T10:00:00Z']) {
    const stdout = sink();
    let called = false;
    const result = await runCli(['prepare-training', '--as-of', asOf, '--json'], {
      stdout,
      stderr: sink(),
      client: testClient({ async prepareTraining() { called = true; return healthyPreparation; } })
    });
    assert.equal(result, 2);
    assert.equal(called, false);
    assert.equal(JSON.parse(stdout.value).error.code, 'SOMA_INVALID_AS_OF');
  }
});

test('accepts a full RFC3339 instant with an explicit offset', async () => {
  const stdout = sink();
  let received;
  const result = await runCli(['prepare-training', '--as-of', '2026-10-24T12:00:00+02:00'], {
    stdout,
    stderr: sink(),
    client: testClient({ async prepareTraining(options) { received = options; return healthyPreparation; } })
  });
  assert.equal(result, 0);
  assert.deepEqual(received, { asOf: '2026-10-24T12:00:00+02:00' });
  assert.match(stdout.value, /Training preparation for/);
  assert.match(stdout.value, /30 kg/);
  assert.equal(stdout.value.includes('SYNTHETIC_PROFILE_PRIVATE_TEXT'), false);
  assert.equal(stdout.value.includes('SYNTHETIC_MEMORY_EVIDENCE_SHOULD_BE_PRESENTED_ONLY_AS_BOUNDED_CONTEXT'), false);
});

test('malformed private context fails with a safe JSON error and no excerpt leakage', async () => {
  const stdout = sink();
  const malformed = structuredClone(healthyPreparation);
  malformed.profile.content = { private: 'MALFORMED_PRIVATE_PROFILE_TEXT' };
  malformed.memory.evidence[0].provenance = [];
  const result = await runCli(['prepare-training', '--json'], {
    stdout,
    stderr: sink(),
    now: () => new Date('2026-10-24T10:00:00.000Z'),
    client: testClient({ async prepareTraining() { return malformed; } })
  });
  assert.equal(result, 1);
  const envelope = JSON.parse(stdout.value);
  assert.equal(envelope.ok, false);
  assert.equal(stdout.value.includes('MALFORMED_PRIVATE_PROFILE_TEXT'), false);
  assert.equal(stdout.value.includes('SYNTHETIC_MEMORY_EVIDENCE_SHOULD_BE_PRESENTED_ONLY_AS_BOUNDED_CONTEXT'), false);
});

test('doctor presents only Health OS compatibility and workspace status', async () => {
  const stdout = sink();
  const result = await runCli(['doctor', '--json'], {
    stdout,
    stderr: sink(),
    client: testClient({
      async doctor() {
        return {
          version: { name: 'health-os', version: '0.1.0', private_text: 'PRIVATE_VERSION_TEXT' },
          capabilities: { cli_json_schema_version: 1, commands: ['prepare-training'], private_text: 'PRIVATE_CAPS' },
          workspace: {
            status: 'versioned', schema_version: 1, profile_status: 'valid',
            workspace: '/private/real-ish/path', error: 'PROFILE_CONTENT'
          }
        };
      }
    })
  });
  assert.equal(result, 0);
  assert.match(stdout.value, /"status":"versioned"/);
  for (const secret of ['PRIVATE_VERSION_TEXT', 'PRIVATE_CAPS', '/private/real-ish/path', 'PROFILE_CONTENT']) {
    assert.equal(stdout.value.includes(secret), false);
  }
});

test('init delegates the empty-path guard to Health OS and emits no path or contents', async () => {
  const stdout = sink();
  let called = false;
  const result = await runCli(['init', '--json'], {
    stdout,
    stderr: sink(),
    client: testClient({ async initWorkspace() { called = true; return { workspace: '/private/workspace' }; } })
  });
  assert.equal(result, 0);
  assert.equal(called, true);
  assert.deepEqual(JSON.parse(stdout.value).data, { initialized: true, profile: 'neutral starter profile' });
  assert.equal(stdout.value.includes('/private/workspace'), false);
});

test('Health OS failures are nonzero and use safe JSON error text', async () => {
  const stdout = sink();
  const stderr = sink();
  const result = await runCli(['prepare-training', '--json'], {
    stdout,
    stderr,
    now: () => new Date('2026-10-24T10:00:00.000Z'),
    client: testClient({
      async prepareTraining() {
        const error = new Error('PRIVATE_HEALTH_TEXT from /Users/person/private/workspace');
        error.code = 'HEALTH_OS_BAD_SCHEMA';
        error.exitCode = 1;
        throw error;
      }
    })
  });
  assert.equal(result, 1);
  assert.equal(stderr.value, '');
  const envelope = JSON.parse(stdout.value);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'HEALTH_OS_BAD_SCHEMA');
  assert.equal(stdout.value.includes('PRIVATE_HEALTH_TEXT'), false);
  assert.equal(stdout.value.includes('/Users/person'), false);
});

test('init timeout explains that the workspace may need inspection before retry', async () => {
  const stdout = sink();
  const stderr = sink();
  const result = await runCli(['init', '--json'], {
    stdout,
    stderr,
    client: testClient({
      async initWorkspace() {
        const error = new Error('PRIVATE_INIT_DIAGNOSTIC');
        error.code = 'HEALTH_OS_TIMEOUT';
        error.exitCode = 1;
        throw error;
      }
    })
  });
  assert.equal(result, 1);
  const envelope = JSON.parse(stdout.value);
  assert.equal(envelope.error.code, 'HEALTH_OS_TIMEOUT');
  assert.match(envelope.error.message, /may have completed/);
  assert.match(envelope.error.message, /Run doctor to inspect/);
  assert.equal(stdout.value.includes('PRIVATE_INIT_DIAGNOSTIC'), false);
});

test('health actions require JSON mode and malformed write input fails without echoing content', async () => {
  const privateMarker = 'SYNTHETIC_PRIVATE_HEALTH_MARKER';
  const humanOut = sink();
  const humanErr = sink();
  let clientCalled = false;
  const humanCode = await runCli(['health-action', 'profile'], {
    stdout: humanOut,
    stderr: humanErr,
    client: testClient({
      async showProfile() { clientCalled = true; return { markdown: privateMarker }; }
    })
  });
  assert.equal(humanCode, 2);
  assert.equal(clientCalled, false);
  assert.equal(humanOut.value, '');
  assert.equal(humanErr.value.includes(privateMarker), false);

  let weightWriterCalled = false;
  const unconfirmedOut = sink();
  const unconfirmedCode = await runCli([
    'health-action', 'set-working-weight', '--exercise', 'squat', '--weight', '55',
    '--idempotency-key', 'synthetic:weight:1', '--json'
  ], {
    stdout: unconfirmedOut,
    stderr: sink(),
    client: testClient({
      async setWorkingWeight() { weightWriterCalled = true; return { weight_kg: 55 }; }
    })
  });
  assert.equal(unconfirmedCode, 2);
  assert.equal(weightWriterCalled, false);
  assert.equal(JSON.parse(unconfirmedOut.value).error.code, 'HEALTH_OS_ACTION_INPUT_INVALID');

  let latestWriterCalled = false;
  const latestOut = sink();
  const latestCode = await runCli(['health-action', 'latest-workout', '--json'], {
    stdout: latestOut,
    stderr: sink(),
    client: testClient({ async latestWorkout() { latestWriterCalled = true; return { status: 'empty' }; } })
  });
  assert.equal(latestCode, 2);
  assert.equal(latestWriterCalled, false);
  assert.equal(JSON.parse(latestOut.value).error.code, 'HEALTH_OS_ACTION_INPUT_INVALID');

  let blockedWriterCalled = false;
  const blockedOut = sink();
  const blockedCode = await runCli([
    'health-action', 'set-working-weight', '--confirmed', '--exercise', 'squat', '--weight', '55',
    '--idempotency-key', 'synthetic:weight:blocked', '--json'
  ], {
    stdout: blockedOut,
    stderr: sink(),
    client: testClient({ async setWorkingWeight() { blockedWriterCalled = true; return { weight_kg: 55 }; } })
  });
  assert.equal(blockedCode, 2);
  assert.equal(blockedWriterCalled, false);
  assert.equal(JSON.parse(blockedOut.value).error.code, 'HEALTH_OS_ACTION_WRITES_DISABLED');

  const jsonOut = sink();
  const writeCode = await runCli([
    'health-action', 'log-workout', '--confirmed', '--date', '2026-10-24',
    '--idempotency-key', 'synthetic:workout:1', '--input-json', '--json'
  ], {
    stdout: jsonOut,
    stderr: sink(),
    env: { SOMA_HEALTH_ACTION_MODE: 'confirmed-writes' },
    stdin: Readable.from(['{"notes":"', privateMarker]),
    client: testClient({
      async logWorkout() { assert.fail('malformed input must fail before invoking the writer'); }
    })
  });
  assert.equal(writeCode, 2);
  assert.equal(JSON.parse(jsonOut.value).error.code, 'HEALTH_OS_ACTION_INPUT_INVALID');
  assert.equal(jsonOut.value.includes(privateMarker), false);
});

test('unsupported command arguments return nonzero and do not echo supplied text', async () => {
  const stdout = sink();
  const stderr = sink();
  const result = await runCli(['prepare-training', '--surprise', 'UNTRUSTED_FLAG_VALUE', '--json'], { stdout, stderr });
  assert.equal(result, 2);
  assert.equal(stderr.value, '');
  const envelope = JSON.parse(stdout.value);
  assert.equal(envelope.ok, false);
  assert.equal(stdout.value.includes('UNTRUSTED_FLAG_VALUE'), false);
});
