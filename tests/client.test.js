import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HEALTH_OS_EXPECTED_REVISION } from '../src/config.js';
import { HealthOsClient, parseHealthOsEnvelope } from '../src/health-os-client.js';

test('Health OS client enforces the CLI envelope and subprocess boundary', async (t) => {
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousModelSecret = process.env.MODEL_API_KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-health-client-'));
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousModelSecret === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousModelSecret;
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'temporary fake repository and scripts should be removed');
  });
  const repo = path.join(root, 'health-os');
  const bin = path.join(root, 'bin');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workspaces, { recursive: true });

  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  pwd
elif [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  if [ -f .rev-mismatch ]; then echo 0000000000000000000000000000000000000000; else echo ${HEALTH_OS_EXPECTED_REVISION}; fi
elif [ "$1" = "status" ]; then
  if [ -f .dirty-runtime ]; then echo ' M src/cli.js'; fi
  exit 0
else
  exit 1
fi
`);
  fs.chmodSync(fakeGit, 0o755);

  const fakeCli = path.join(repo, 'src', 'cli.js');
  fs.writeFileSync(fakeCli, String.raw`
const path = require('node:path');
const args = process.argv.slice(2);
const command = args[0];
const workspace = args[args.indexOf('--workspace') + 1];
const mode = path.basename(workspace || '');
const commands = ['version', 'capabilities', 'workspace-inspect', 'init-workspace', 'prepare-training'];
const capabilities = {
  name: 'health-os', version: '0.1.0', cli_json_schema_version: 1, workspace_schema_versions: [1],
  commands, contracts: { json_envelope_commands: commands, read_only_preparation_commands: ['prepare-training'],
    workspace_read_lock_commands: ['prepare-training'] }, limits: { json_output_bytes: 262144 }
};
const base = {
  schema_version: 1, as_of: { kind: 'date', value: '2026-10-24', date: '2026-10-24' },
  profile: { status: 'missing', path: null, content: null },
  session_selection: { selected_day_type: 'A', strategy: 'first_plan_day', reason: 'synthetic' },
  workout: { mode: 'UNAVAILABLE', scheduled_only: true, exercises: [
    { exercise_key: 'squat', exercise_name: 'Squat', target_sets: 3, target_reps: '5', target_weight: '' }
  ] },
  recovery: { status: 'unavailable', decision: { status: 'unavailable', mode: null, score: null,
    reasons: ['recovery_missing'], explanation: 'Synthetic recovery is unavailable.' } },
  subjective: { applied: [], signals: [] }, memory: { status: 'blocked', evidence: [] },
  gaps: [{ code: 'recovery_missing', detail: 'Synthetic recovery gap.' }],
  provenance: { training_plan: 'plan', preparation_policy: 'policy', rules: 'rules', exercise_settings: 'settings',
    workout_sessions: 'sessions', exercise_logs: 'logs', recovery: 'recovery' }
};
function emit(data, ok = true, extra = {}) {
  process.stdout.write(JSON.stringify({ schema_version: 1, command, ok, ...extra, ...(ok ? { data } : {}) }) + '\n');
}
if (mode === 'timeout' && command === 'capabilities') {
  setInterval(() => {}, 1000);
} else if (mode === 'output-limit' && command === 'capabilities') {
  process.stdout.write('x'.repeat(2048));
} else if (command === 'version') {
  emit({ name: 'health-os', version: '0.1.0' });
} else if (command === 'capabilities') {
  emit(capabilities);
} else if (command === 'workspace-inspect') {
  emit(['init', 'populated'].includes(mode) ? { status: 'uninitialized', schema_version: null }
    : { status: 'versioned', schema_version: 1, profile_status: 'valid' });
} else if (command === 'init-workspace') {
  emit({ status: 'initialized', schema_version: 1 });
} else if (command === 'prepare-training' && mode === 'nonzero') {
  process.stdout.write(JSON.stringify({ schema_version: 1, command, ok: false,
    error: { code: 'SYNTHETIC_FAILURE', message: 'Synthetic command failure.' } }) + '\n');
  process.exitCode = 1;
} else if (command === 'prepare-training' && mode === 'truncated') {
  emit(base, true, { truncation: { truncated: true, paths: ['$.profile'], max_bytes: 262144 } });
} else if (command === 'prepare-training' && mode === 'schema') {
  emit({ ...base, schema_version: 2 });
} else if (command === 'prepare-training' && mode === 'inconsistent') {
  emit({ ...base, workout: { ...base.workout, scheduled_only: false } });
} else if (command === 'prepare-training' && mode === 'argv') {
  emit({ ...base, probe: { args: process.argv.slice(2), home_present: Object.hasOwn(process.env, 'HOME'),
    model_secret_present: Object.hasOwn(process.env, 'MODEL_API_KEY') } });
} else if (command === 'prepare-training') {
  emit(base);
} else {
  emit(null, false, { error: { code: 'UNKNOWN', message: 'Unknown synthetic command.' } });
  process.exitCode = 1;
}
`);

  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;

  const makeClient = (mode, timeoutMs = 3_000) => new HealthOsClient({
    repo,
    workspace: path.join(workspaces, mode),
    timeoutMs,
    maxOutputBytes: 256 * 1024
  });

  await t.test('discovers the pinned version and mandatory preparation capability before workspace reads', async () => {
    const client = makeClient('success');
    const discovered = await client.discover();
    assert.equal(discovered.version.version, '0.1.0');
    assert.equal(discovered.capabilities.cli_json_schema_version, 1);
    assert.equal((await client.inspectWorkspace()).status, 'versioned');
  });

  await t.test('returns a valid scheduled-only result while keeping blocked memory empty', async () => {
    const result = await makeClient('success').prepareTraining({ asOf: '2026-10-24' });
    assert.equal(result.recovery.decision.status, 'unavailable');
    assert.equal(result.workout.scheduled_only, true);
    assert.equal(result.workout.mode, 'UNAVAILABLE');
    assert.equal(result.memory.status, 'blocked');
    assert.deepEqual(result.memory.evidence, []);
  });

  await t.test('rejects schema mismatch and incompatible decision/workout combinations', async () => {
    await assert.rejects(makeClient('schema').prepareTraining({ asOf: '2026-10-24' }), {
      code: 'HEALTH_OS_SCHEMA_MISMATCH'
    });
    await assert.rejects(makeClient('inconsistent').prepareTraining({ asOf: '2026-10-24' }), {
      code: 'HEALTH_OS_INVALID_DOMAIN'
    });
  });

  await t.test('surfaces a valid nonzero CLI error envelope and rejects truncated output', async () => {
    await assert.rejects(makeClient('nonzero').prepareTraining({ asOf: '2026-10-24' }), {
      code: 'SYNTHETIC_FAILURE', exitCode: 1
    });
    await assert.rejects(makeClient('truncated').prepareTraining({ asOf: '2026-10-24' }), {
      code: 'HEALTH_OS_OUTPUT_TRUNCATED'
    });
  });

  await t.test('times out a CLI process and only initializes an explicit empty workspace', async () => {
    await assert.rejects(makeClient('timeout', 100).discover(), { code: 'HEALTH_OS_TIMEOUT' });
    const initClient = makeClient('init');
    assert.equal((await initClient.initWorkspace()).status, 'initialized');
    await assert.rejects(new HealthOsClient({ repo, workspace: repo }).inspectWorkspace(), {
      code: 'HEALTH_OS_WORKSPACE_PATH_UNSAFE'
    });
  });

  await t.test('bounds stdout and refuses incompatible or dirty runtime checkouts', async () => {
    await assert.rejects(new HealthOsClient({ repo, workspace: path.join(workspaces, 'output-limit'), maxOutputBytes: 1_024 }).discover(), {
      code: 'HEALTH_OS_OUTPUT_LIMIT'
    });
    fs.writeFileSync(path.join(repo, '.rev-mismatch'), 'synthetic');
    await assert.rejects(makeClient('revision').discover(), { code: 'HEALTH_OS_REVISION_MISMATCH' });
    fs.rmSync(path.join(repo, '.rev-mismatch'));
    fs.writeFileSync(path.join(repo, '.dirty-runtime'), 'synthetic');
    await assert.rejects(makeClient('dirty').discover(), { code: 'HEALTH_OS_DIRTY_ENGINE' });
    fs.rmSync(path.join(repo, '.dirty-runtime'));
  });

  await t.test('passes user arguments as argv and strips HOME and API secrets from Health OS', async () => {
    process.env.HOME = path.join(root, 'user-home');
    process.env.MODEL_API_KEY = 'synthetic-secret';
    const shellMarker = path.join(root, 'shell-marker');
    const asOf = `2026-10-24; touch ${shellMarker}`;
    const client = makeClient('argv');
    const result = await client.prepareTraining({ asOf });
    assert.deepEqual(result.probe.args, [
      'prepare-training', '--as-of', asOf, '--workspace', path.join(workspaces, 'argv'), '--json'
    ]);
    assert.equal(result.probe.home_present, false);
    assert.equal(result.probe.model_secret_present, false);
    assert.equal(fs.existsSync(shellMarker), false);
  });

  await t.test('refuses populated initialization targets and symlink paths into either repository', async () => {
    const populated = path.join(workspaces, 'populated');
    fs.mkdirSync(populated);
    fs.writeFileSync(path.join(populated, 'unrelated.txt'), 'leave me');
    await assert.rejects(makeClient('populated').initWorkspace(), { code: 'HEALTH_OS_INIT_REFUSED' });

    const symlinkPath = path.join(workspaces, 'repo-link');
    fs.symlinkSync(repo, symlinkPath, 'dir');
    await assert.rejects(new HealthOsClient({ repo, workspace: symlinkPath }).inspectWorkspace(), {
      code: 'HEALTH_OS_WORKSPACE_PATH_UNSAFE'
    });
  });
});

test('parseHealthOsEnvelope requires the supported, untruncated JSON contract', () => {
  const envelope = { schema_version: 1, command: 'version', ok: true, data: { version: '0.1.0' } };
  assert.deepEqual(parseHealthOsEnvelope({ command: 'version', status: 0, stdout: JSON.stringify(envelope) }), envelope);
  assert.throws(() => parseHealthOsEnvelope({ command: 'version', status: 0,
    stdout: JSON.stringify({ ...envelope, schema_version: 2 }) }), { code: 'HEALTH_OS_INVALID_ENVELOPE' });
  assert.throws(() => parseHealthOsEnvelope({ command: 'version', status: 0,
    stdout: JSON.stringify({ ...envelope, truncation: { truncated: true } }) }), { code: 'HEALTH_OS_OUTPUT_TRUNCATED' });
  assert.throws(() => parseHealthOsEnvelope({ command: 'version', status: 1,
    stdout: JSON.stringify({ schema_version: 1, command: 'version', ok: false,
      error: { code: 'SYNTHETIC_FAILURE', message: 'Expected failure.' } }) }), { code: 'SYNTHETIC_FAILURE', exitCode: 1 });
  assert.throws(() => parseHealthOsEnvelope({ command: 'version', status: 0,
    stdout: `${JSON.stringify(envelope)}\n${JSON.stringify(envelope)}` }), { code: 'HEALTH_OS_INVALID_JSON' });
});
