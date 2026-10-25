import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { HealthOsClient } from '../src/health-os-client.js';
import { runCli } from '../src/cli.js';

const healthOsRepo = process.env.HEALTH_OS_REPO;
const asOf = '2026-10-24T12:00:00.000Z';
const asOfDate = asOf.slice(0, 10);

function dateOffset(value, offset) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function observationFor(date, { current = false } = {}) {
  const observedAt = `${date}T08:00:00.000Z`;
  const evaluatedAt = `${date}T09:00:00.000Z`;
  const sourceRef = `synthetic-${date}`;
  const physicalMetric = (metric, value, unit) => ({
    metric,
    status: 'observed',
    value,
    unit,
    observed_at: observedAt,
    observed_date: null,
    source_ref: sourceRef
  });
  const score = (metric, value) => ({
    metric,
    status: 'observed',
    value,
    unit: 'score',
    observed_at: observedAt,
    observed_date: null,
    source_ref: sourceRef
  });
  return {
    schema_version: 1,
    date,
    source: { id: 'synthetic', label: 'Synthetic integration fixture', reference: null },
    freshness: {
      status: 'fresh', observed_at: observedAt, evaluated_at: evaluatedAt, max_age_seconds: 3600
    },
    physical_metrics: [
      physicalMetric('hrv', current ? 53 : 50, 'ms'),
      physicalMetric('resting_hr', current ? 58 : 60, 'bpm')
    ],
    proprietary_scores: current
      ? [score('readiness_score', 90), score('sleep_score', 90)]
      : []
  };
}

function minimalEnvironment() {
  const env = { PATH: process.env.PATH || '', TZ: 'UTC' };
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) if (process.env[key]) env[key] = process.env[key];
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function runHealthOs(cliPath, command, workspace, payload, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    cliPath, command, '--workspace', workspace, '--json', ...extraArgs
  ], {
    input: payload === undefined ? undefined : JSON.stringify(payload),
    encoding: 'utf8',
    env: minimalEnvironment(),
    timeout: 30_000,
    maxBuffer: 256 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Synthetic Health OS ${command} command failed.`);
  }
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.command, command);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

function outputSink() {
  return { value: '', write(chunk) { this.value += chunk; return true; } };
}

test('pinned Health OS: empty, sufficient synthetic recovery, and blocked-memory preparations', {
  skip: healthOsRepo ? false : 'Set HEALTH_OS_REPO to run the pinned local Health OS integration.'
}, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-real-health-os-'));
  let primaryError;
  try {
    const workspace = path.join(tempRoot, 'workspace');
    const cliPath = path.join(healthOsRepo, 'src', 'cli.js');
    const client = new HealthOsClient({ repo: healthOsRepo, workspace, timeoutMs: 30_000 });
    const initialized = await client.initWorkspace();
    assert.equal(initialized.status, 'initialized');

    const empty = await client.prepareTraining({ asOf });
    assert.equal(empty.recovery.decision.status, 'unavailable');
    assert.equal(empty.workout.mode, 'UNAVAILABLE');
    assert.equal(empty.workout.scheduled_only, true);
    assert.ok(empty.gaps.some((gap) => gap.code === 'recovery_missing'));

    for (let daysAgo = 14; daysAgo >= 1; daysAgo -= 1) {
      const date = dateOffset(asOfDate, -daysAgo);
      runHealthOs(cliPath, 'ingest-wearable-observations', workspace,
        observationFor(date), ['--input-json', '--idempotency-key', `synthetic-integration:${date}`]);
    }
    runHealthOs(cliPath, 'ingest-wearable-observations', workspace,
      observationFor(asOfDate, { current: true }), ['--input-json', '--idempotency-key', `synthetic-integration:${asOfDate}`]);

    const available = await client.prepareTraining({ asOf });
    assert.equal(available.recovery.decision.status, 'available');
    assert.equal(available.recovery.decision.mode, 'FULL');
    assert.equal(available.workout.scheduled_only, false);
    assert.match(available.recovery.decision.explanation, /Mode FULL from score 6/);

    const event = {
      schema_version: 1,
      event_type: 'subjective.energy',
      occurred: { start: '2026-10-24T09:00:00Z', end: null, precision: 'minute', timezone: 'UTC' },
      data: { value: 4, note: 'SYNTHETIC_BLOCKED_EVENT_TEXT' },
      source: { kind: 'manual', ref: 'synthetic-integration-event', fragment_id: '0' },
      extraction_version: 'synthetic-integration-v1',
      epistemic_status: 'fact',
      uncertainty: { level: 'low', note: null }
    };
    const added = runHealthOs(cliPath, 'context-add', workspace, event, ['--input-json', '--idempotency-key', 'synthetic-integration:event']);

    const stdout = outputSink();
    const stderr = outputSink();
    const exitCode = await runCli(['prepare-training', '--as-of', asOf, '--json'], { client, stdout, stderr });
    assert.equal(exitCode, 0);
    assert.equal(stderr.value, '');
    const soma = JSON.parse(stdout.value);
    assert.equal(soma.ok, true);
    assert.equal(soma.data.recovery.status, 'available');
    assert.equal(soma.data.memory_status, 'blocked');
    assert.equal(soma.data.health_context.profile.status, 'available');
    assert.equal(typeof soma.data.health_context.profile.content, 'string');
    assert.equal(soma.data.health_context.memory.status, 'blocked');
    assert.deepEqual(soma.data.health_context.memory.evidence, []);
    assert.equal(stdout.value.includes('SYNTHETIC_BLOCKED_EVENT_TEXT'), false);
    assert.equal(stdout.value.includes('SYNTHETIC_PROFILE_PRIVATE_TEXT'), false);

    const eventId = added.event.event_id;
    const wiki = path.join(workspace, '.health-os', 'memory', 'wiki', 'synthetic-training-context.md');
    fs.mkdirSync(path.dirname(wiki), { recursive: true });
    fs.writeFileSync(wiki, [
      '---',
      'title: Synthetic training context',
      'status: observation',
      'confidence: medium',
      'evidence_start: 2026-10-23',
      'evidence_end: 2026-10-24',
      'last_reviewed: 2026-10-24',
      `provenance: [\"health-event:${eventId}@1\"]`,
      'human_confirmed: false',
      '---',
      '',
      'SYNTHETIC_REVIEWED_MEMORY_CONTEXT for goblet squat recovery training.',
      ''
    ].join('\n'));
    runHealthOs(cliPath, 'context-revalidate-memory', workspace, undefined, ['--generation', String(added.generation)]);

    const reviewedStdout = outputSink();
    const reviewedExitCode = await runCli(['prepare-training', '--as-of', '2026-10-25T08:00:00.000Z', '--json'], {
      client,
      stdout: reviewedStdout,
      stderr: outputSink()
    });
    assert.equal(reviewedExitCode, 0);
    const reviewed = JSON.parse(reviewedStdout.value).data.health_context;
    assert.equal(reviewed.memory.status, 'available');
    assert.equal(reviewed.memory.evidence.length, 1);
    assert.equal(reviewed.memory.evidence[0].file, 'wiki/synthetic-training-context.md');
    assert.equal(reviewed.memory.evidence[0].status, 'observation');
    assert.equal(reviewed.memory.evidence[0].confidence, 'medium');
    assert.equal(reviewed.memory.evidence[0].review_status, 'current');
    assert.deepEqual(reviewed.memory.evidence[0].provenance, [`health-event:${eventId}@1`]);
    assert.match(reviewed.memory.evidence[0].excerpt, /SYNTHETIC_REVIEWED_MEMORY_CONTEXT/);
    assert.equal(reviewed.memory.evidence[0].truncated, false);
    const subjective = reviewed.subjective.selected_facts.find((item) => item.provenance_ref === `health-event:${eventId}@1`);
    assert.equal(subjective.event_type, 'subjective.energy');
    assert.equal(subjective.epistemic_status, 'fact');
    assert.equal(subjective.uncertainty_level, 'low');
    assert.equal(subjective.value, 4);
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      if (fs.existsSync(tempRoot)) throw new Error('Temporary workspace still exists after cleanup.');
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError && cleanupError) {
      throw new AggregateError([primaryError, cleanupError], 'Integration failed and temporary workspace cleanup could not be verified.');
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  }
});

test('pinned Health OS selected profile, workout history, idempotent logging, and weight actions', {
  skip: healthOsRepo ? false : 'Set HEALTH_OS_REPO to run the pinned local Health OS integration.'
}, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-health-actions-'));
  let primaryError;
  try {
    const workspace = path.join(tempRoot, 'workspace');
    const client = new HealthOsClient({ repo: healthOsRepo, workspace, timeoutMs: 30_000,
      healthActionMode: 'confirmed-writes' });
    await client.initWorkspace();

    const tracker = path.join(workspace, '.health-os');
    const files = path.join(tracker, 'personal', 'files');
    fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    const selectedProfile = path.join(files, 'health-snapshot.md');
    const profileText = [
      '---',
      'schema_version: 1',
      'updated: 2026-10-24',
      '---',
      '',
      'SYNTHETIC_SELECTED_HEALTH_SNAPSHOT',
      ''
    ].join('\n');
    fs.writeFileSync(selectedProfile, profileText, { mode: 0o600 });
    fs.writeFileSync(path.join(tracker, 'manifest.json'), JSON.stringify({
      profile_path: 'personal/files/health-snapshot.md',
      schema_version: 1
    }, null, 2) + '\n', { mode: 0o600 });
    fs.rmSync(path.join(files, 'profile.md'), { force: true });

    const profile = await client.showProfile();
    assert.equal(profile.profile_path, 'personal/files/health-snapshot.md');
    assert.equal(profile.markdown, profileText);
    assert.equal(profile.complete, true);

    const weight = await client.setWorkingWeight({
      exercise: 'squat', weight: 52.5, increment: 2.5, idempotencyKey: 'synthetic:weight:1'
    });
    assert.equal(weight.weight_kg, 52.5);
    assert.equal(weight.idempotency_status, 'completed');
    const replayedWeight = await client.setWorkingWeight({
      exercise: 'squat', weight: 52.5, increment: 2.5, idempotencyKey: 'synthetic:weight:1'
    });
    assert.equal(replayedWeight.idempotency_status, 'replayed');

    const workoutPayload = (notes, weightValue) => ({
      session: {
        day: 'A', actual_mode: 'BASE', duration_minutes: 42, session_rpe: 6,
        energy_pre: 3, soreness_pre: 2, notes
      },
      exercises: [
        { exercise_key: 'squat', sets: [
          { weight: weightValue === 50 ? 'bw' : weightValue, reps: 5 },
          { weight: weightValue === 50 ? 'bw' : weightValue, reps: 4 }
        ] },
        { exercise_key: 'bench_press', sets: [
          { weight: 30, reps: 5 }, { weight: 30, reps: 5 }
        ] }
      ]
    });
    const first = await client.logWorkout({
      payload: workoutPayload('', 50),
      date: '2026-10-20',
      idempotencyKey: 'synthetic:workout:1'
    });
    const firstReplay = await client.logWorkout({
      payload: workoutPayload('', 50),
      date: '2026-10-20',
      idempotencyKey: 'synthetic:workout:1'
    });
    assert.equal(firstReplay.session_id, first.session_id);
    assert.equal(firstReplay.idempotency_status, 'replayed');

    await client.logWorkout({
      payload: workoutPayload('SYNTHETIC_LATEST_WORKOUT_NOTE', 55),
      date: '2026-10-22',
      idempotencyKey: 'synthetic:workout:2'
    });
    const latest = await client.latestWorkout({ through: '2026-10-24' });
    assert.equal(latest.status, 'available');
    assert.equal(latest.latest_date, '2026-10-22');
    assert.equal(latest.history_complete, true);
    assert.equal(latest.latest.data.session.notes, 'SYNTHETIC_LATEST_WORKOUT_NOTE');
    assert.equal(latest.latest.data.exercises.length, 2);
    assert.equal(latest.latest.data.exercises[0].reps, '55x5|55x4');
    assert.equal(latest.latest.data.exercises[0].set_count, 2);
    assert.equal(latest.latest.data.exercises[0].weight, 55);
    assert.equal(latest.latest.data.exercises[0].notes, 'SYNTHETIC_LATEST_WORKOUT_NOTE');

    const history = await client.workoutHistory({
      since: '2026-10-20', through: '2026-10-24'
    });
    assert.equal(history.complete, true);
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].data.session.notes, null);
    assert.equal(history.items[0].data.exercises[0].notes, null);
    assert.equal(history.items[0].data.exercises[0].weight, 'bw');
    assert.equal(history.items[0].data.exercises[0].reps, 'bwx5|bwx4');
    assert.equal(history.items[1].data.session.notes, 'SYNTHETIC_LATEST_WORKOUT_NOTE');

    for (let index = 0; index < 34; index += 1) {
      const note = `SYNTHETIC_BOUNDED_TIMELINE_${String(index).padStart(2, '0')}_${'x'.repeat(1_200)}`;
      await client.logWorkout({
        payload: workoutPayload(note, 55),
        date: dateOffset('2026-08-01', index),
        idempotencyKey: `synthetic:bounded-history:${index}`
      });
    }
    const partialHistory = await client.workoutHistory({ since: '2026-08-01', through: '2026-10-24' });
    assert.equal(partialHistory.complete, false);
    assert.equal(partialHistory.content_truncated, true);
    assert.ok(partialHistory.items.some((item) => item.data_truncated === true && item.data === null),
      'native item truncation must retain metadata and discard the incomplete workout body');

    const latestAfterNativeTruncation = await client.latestWorkout({ through: '2026-10-24' });
    assert.equal(latestAfterNativeTruncation.status, 'available');
    assert.equal(latestAfterNativeTruncation.latest_date, '2026-10-22');
    assert.equal(latestAfterNativeTruncation.latest.data.exercises.length, 2);
    assert.equal(latestAfterNativeTruncation.history_complete, true);
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      if (fs.existsSync(tempRoot)) throw new Error('Temporary action workspace still exists after cleanup.');
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError && cleanupError) {
      throw new AggregateError([primaryError, cleanupError], 'Health action integration failed and cleanup could not be verified.');
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  }
});
