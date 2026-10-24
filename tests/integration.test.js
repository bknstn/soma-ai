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
    runHealthOs(cliPath, 'context-add', workspace, event, ['--input-json', '--idempotency-key', 'synthetic-integration:event']);

    const stdout = outputSink();
    const stderr = outputSink();
    const exitCode = await runCli(['prepare-training', '--as-of', asOf, '--json'], { client, stdout, stderr });
    assert.equal(exitCode, 0);
    assert.equal(stderr.value, '');
    const soma = JSON.parse(stdout.value);
    assert.equal(soma.ok, true);
    assert.equal(soma.data.recovery.status, 'available');
    assert.equal(soma.data.memory_status, 'blocked');
    assert.equal(stdout.value.includes('SYNTHETIC_BLOCKED_EVENT_TEXT'), false);
    assert.equal(stdout.value.includes('SYNTHETIC_PROFILE_PRIVATE_TEXT'), false);
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
