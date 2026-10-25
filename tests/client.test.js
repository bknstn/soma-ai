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
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[0];
const workspace = args[args.indexOf('--workspace') + 1];
const mode = path.basename(workspace || '');
const commands = ['version', 'capabilities', 'workspace-inspect', 'init-workspace', 'prepare-training',
  'profile-show', 'timeline', 'log-workout', 'set-working-weight'];
const capabilities = {
  name: 'health-os', version: '0.1.0', cli_json_schema_version: 1, workspace_schema_versions: [1],
  commands, contracts: { json_envelope_commands: commands, json_stdin_commands: ['log-workout'],
    idempotency_commands: ['log-workout', 'set-working-weight'], read_only_event_commands: ['timeline'],
    read_only_preparation_commands: ['prepare-training'], workspace_read_lock_commands: ['prepare-training'] },
  limits: { json_output_bytes: 262144 }
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
if (mode === 'read-only-write-guard' && ['log-workout', 'set-working-weight'].includes(command)) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.native-write-or-journal-attempted'), 'unexpected');
  process.exit(99);
}
if (mode === 'write-early-exit' && command === 'log-workout') process.exit(0);
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
    : { status: 'versioned', schema_version: 1, profile_status: 'valid', profile_path: 'personal/files/profile.md' });
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
} else if (command === 'profile-show') {
  const markdown = mode === 'profile-truncated' ? 'P'.repeat(50000) : 'PRIVATE_SYNTHETIC_PROFILE_TEXT';
  const total = mode === 'profile-truncated' ? 60000 : [...markdown].length;
  emit({ profile_path: 'personal/files/profile.md', metadata: { schema_version: 1, updated: null },
    markdown, truncated: total > [...markdown].length, total_chars: total, returned_chars: [...markdown].length });
} else if (command === 'timeline') {
  let workouts = [
    { date: '2026-10-20', session_id: 'synthetic-1' },
    { date: '2026-10-22', session_id: 'synthetic-2' }
  ];
  if (mode === 'local-boundary') {
    workouts = [{ date: '2026-10-25', session_id: 'synthetic-local-calendar-boundary' }];
  }
  if (mode === 'history-drift') {
    workouts = [];
    for (let index = 0; index < 50; index += 1) {
      const date = new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10);
      workouts.push({ date, session_id: 'synthetic-' + index });
    }
    workouts.push({ date: '2026-10-22', session_id: 'synthetic-latest' });
    fs.mkdirSync(workspace, { recursive: true });
    const counterFile = path.join(workspace, '.timeline-query-count');
    const count = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
    fs.writeFileSync(counterFile, String(count + 1));
    if (count > 0) workouts.push({ date: '2026-10-23', session_id: 'synthetic-added-during-query' });
  }
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const since = option('--since', '0001-01-01');
  const through = option('--through', '9999-12-31');
  const limit = Number(option('--limit', '50'));
  const rows = workouts.filter((item) => item.date >= since && item.date <= through);
  const records = rows.map((item) => ({
    id: item.session_id, type: 'workout', occurred: { start: item.date, end: null, precision: 'day', timezone: null },
    source: { kind: 'legacy.workout_session', ref: 'synthetic', fragment_id: '0' }, data_truncated: false,
    data: { session: { session_id: item.session_id, notes: 'PRIVATE_SESSION_NOTE' }, issues: [],
      exercises: [{ exercise_key: 'squat', set_count: 2, reps: '50x5|50x4', weight: 50, notes: 'PRIVATE_SET_NOTE', issues: [] }] }
  }));
  const shouldTruncateFirst = records.length > 0 &&
    (mode === 'history-truncated' || (mode === 'latest-initial-truncated' && since === '0001-01-01' && limit >= 50));
  if (shouldTruncateFirst) {
    records[0].data_truncated = true;
    records[0].data = null;
  }
  if (mode === 'history-malformed-unmarked' && records.length) {
    delete records[0].data_truncated;
  }
  if (mode === 'history-missing-body' && records.length) {
    records[0].data = null;
  }
  const returned = records.slice(0, limit);
  const truncatedContentCount = returned.filter((item) => item.data_truncated === true).length;
  const contentTruncated = truncatedContentCount > 0;
  emit({ items: returned, matched_count: records.length, limit,
    truncated: records.length > limit || contentTruncated,
    returned_count: returned.length, content_truncated: contentTruncated,
    records_with_truncated_content: truncatedContentCount,
    omitted_legacy_rows: 0, omission_counts: {}, source_issue_count: 0, source_issues: [], source_issues_truncated: false });
} else if (command === 'log-workout') {
  if (mode === 'write-unknown') {
    emit(null, false, { error: { code: 'SYNTHETIC_WRITE_ERROR', message: 'PRIVATE_NATIVE_ERROR_TEXT' } });
    process.exitCode = 1;
  } else {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => {
      const payload = JSON.parse(body);
      emit({ session_id: 'synthetic-session-1', date: args[args.indexOf('--date') + 1],
        accepted_private_note: payload.session.notes === 'PRIVATE_WORKOUT_NOTE' }, true,
        { idempotency: { status: 'completed' } });
    });
  }
} else if (command === 'set-working-weight') {
  emit({ exercise: args[args.indexOf('--exercise') + 1],
    weight_kg: Number(args[args.indexOf('--weight') + 1]),
    increment_kg: mode === 'weight-increment-mismatch' ? null :
      (args.includes('--increment') ? Number(args[args.indexOf('--increment') + 1]) : null) }, true,
    { idempotency: { status: 'replayed' } });
} else {
  emit(null, false, { error: { code: 'UNKNOWN', message: 'Unknown synthetic command.' } });
  process.exitCode = 1;
}
`);

  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;

  const makeClient = (mode, timeoutMs = 3_000, healthActionMode = 'confirmed-writes') => new HealthOsClient({
    repo,
    workspace: path.join(workspaces, mode),
    timeoutMs,
    maxOutputBytes: 256 * 1024,
    healthActionMode
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

  await t.test('retrieves the manifest-selected profile with truthful partial metadata', async () => {
    const complete = await makeClient('profile').showProfile();
    assert.equal(complete.profile_path, 'personal/files/profile.md');
    assert.equal(complete.markdown, 'PRIVATE_SYNTHETIC_PROFILE_TEXT');
    assert.equal(complete.complete, true);
    const partial = await makeClient('profile-truncated').showProfile();
    assert.equal(partial.returned_chars, 50000);
    assert.equal(partial.total_chars, 60000);
    assert.equal(partial.complete, false);
    assert.equal(partial.partial_reason, 'native_profile_character_limit');
  });

  await t.test('finds latest workout by date and preserves linked set and note fields', async () => {
    const result = await makeClient('actions').latestWorkout({ through: '2026-10-24' });
    assert.equal(result.status, 'available');
    assert.equal(result.latest_date, '2026-10-22');
    assert.equal(result.latest.data.exercises[0].reps, '50x5|50x4');
    assert.equal(result.latest.data.exercises[0].set_count, 2);
    assert.equal(result.latest.data.exercises[0].notes, 'PRIVATE_SET_NOTE');
    const history = await makeClient('actions').workoutHistory({ since: '2026-10-20', through: '2026-10-24' });
    assert.equal(history.complete, true);
    assert.equal(history.items.length, 2);
    const partial = await makeClient('history-truncated').workoutHistory({
      since: '2026-10-20', through: '2026-10-24'
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.content_truncated, true);
    assert.equal(partial.items[0].data_truncated, true);
    assert.equal(partial.items[0].data, null, 'truncated native workout bodies must not be reused as complete');
    await assert.rejects(makeClient('history-malformed-unmarked').workoutHistory({
      since: '2026-10-20', through: '2026-10-24'
    }), { code: 'HEALTH_OS_INVALID_HISTORY' });
    await assert.rejects(makeClient('history-missing-body').workoutHistory({
      since: '2026-10-20', through: '2026-10-24'
    }), { code: 'HEALTH_OS_INVALID_HISTORY' });
  });

  await t.test('latest lookup requires an explicit local-calendar cutoff and narrows valid native truncation', async () => {
    const readOnly = makeClient('actions', 3_000, 'read-only');
    await assert.rejects(readOnly.latestWorkout(), { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
    const result = await makeClient('latest-initial-truncated').latestWorkout({ through: '2026-10-24' });
    assert.equal(result.status, 'available');
    assert.equal(result.latest_date, '2026-10-22');
    assert.equal(result.latest.data.exercises[0].set_count, 2);
    const localCalendarDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date('2026-10-24T12:30:00Z'));
    assert.equal(localCalendarDate, '2026-10-25');
    const localBoundary = await makeClient('local-boundary').latestWorkout({ through: localCalendarDate });
    assert.equal(localBoundary.status, 'available');
    assert.equal(localBoundary.latest_date, localCalendarDate);
  });

  await t.test('latest lookup refuses a workout source that changes during range narrowing', async () => {
    const result = await makeClient('history-drift').latestWorkout({ through: '2026-10-24' });
    assert.equal(result.status, 'source_changed_during_query');
    assert.equal(result.history_complete, false);
  });

  await t.test('read-only is the default write gate even when direct client methods are called', async () => {
    const readonlyWorkspace = path.join(workspaces, 'read-only-write-guard');
    const client = new HealthOsClient({ repo, workspace: readonlyWorkspace });
    await assert.rejects(client.logWorkout({
      payload: { session: {}, exercises: [] }, date: '2026-10-24', idempotencyKey: 'synthetic:blocked:1'
    }), { code: 'HEALTH_OS_ACTION_WRITES_DISABLED' });
    await assert.rejects(client.setWorkingWeight({
      exercise: 'squat', weight: 55, idempotencyKey: 'synthetic:blocked:2'
    }), { code: 'HEALTH_OS_ACTION_WRITES_DISABLED' });
    assert.equal(fs.existsSync(readonlyWorkspace), false,
      'read-only refusal must occur before native CLI invocation, workspace mutation, or write journal creation');
    assert.throws(() => new HealthOsClient({
      repo, workspace: path.join(workspaces, 'bad-mode'), healthActionMode: 'user-controlled'
    }), /SOMA_HEALTH_ACTION_MODE/);
  });

  await t.test('writes pass bounded JSON on stdin and unknown outcomes never expose native error text', async () => {
    const payload = { session: { day: 'A', actual_mode: 'BASE', duration_minutes: 30,
      session_rpe: 6, energy_pre: 3, soreness_pre: 2, notes: 'PRIVATE_WORKOUT_NOTE' },
      exercises: [{ exercise_key: 'squat', sets: [{ weight: 50, reps: 5 }] }] };
    const logged = await makeClient('actions').logWorkout({
      payload, date: '2026-10-23', idempotencyKey: 'synthetic:workout:1'
    });
    assert.equal(logged.idempotency_status, 'completed');
    assert.equal(logged.idempotency_key, 'synthetic:workout:1');
    assert.equal(logged.accepted_private_note, true);
    assert.equal(JSON.stringify(logged).includes('PRIVATE_WORKOUT_NOTE'), false);
    const weight = await makeClient('actions').setWorkingWeight({
      exercise: 'squat', weight: 55, idempotencyKey: 'synthetic:weight:1'
    });
    assert.equal(weight.idempotency_status, 'replayed');
    await assert.rejects(makeClient('weight-increment-mismatch').setWorkingWeight({
      exercise: 'squat', weight: 55, increment: 2.5, idempotencyKey: 'synthetic:weight:bad-increment'
    }), { code: 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN' });
    await assert.rejects(makeClient('write-unknown').logWorkout({
      payload, date: '2026-10-23', idempotencyKey: 'synthetic:unknown:1'
    }), (error) => error.code === 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN' &&
      !error.message.includes('PRIVATE_NATIVE_ERROR_TEXT'));
    await assert.rejects(makeClient('write-early-exit').logWorkout({
      payload: { ...payload, session: { ...payload.session, notes: 'N'.repeat(50000) } },
      date: '2026-10-23', idempotencyKey: 'synthetic:early-exit:1'
    }), (error) => error.code === 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN');
    await assert.rejects(makeClient('actions').logWorkout({
      payload: { ...payload, extra: 'unsupported' }, date: '2026-10-23', idempotencyKey: 'synthetic:bad:1'
    }), { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
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
