import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { presentPreparation, presentDoctor, renderDoctor, renderPreparation } from '../src/presenter.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'training-preparation.synthetic.json');
const healthyPreparation = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('presents a populated synthetic preparation as a small neutral plan summary', () => {
  const data = presentPreparation(healthyPreparation);
  const json = JSON.stringify(data);
  const human = renderPreparation(data);

  assert.equal(data.recovery.status, 'available');
  assert.equal(data.recovery.explanation, 'Mode FULL from score 8: readiness +3, sleep +2, hrv +2, resting_hr +1.');
  assert.equal(data.session.day_type, 'A');
  assert.deepEqual(data.workout.exercises[0], {
    name: 'Goblet squat', sets: 3, reps: '8-10', target_weight_kg: 30
  });
  assert.deepEqual(data.sources.map(({ label }) => label), [
    'Training plan', 'Preparation policy', 'Training rules', 'Exercise settings',
    'Workout history', 'Exercise log history', 'Recovery inputs'
  ]);
  assert.match(human, /Goblet squat: 3 sets, 8-10 reps, 30 kg/);
  assert.match(human, /Recovery rationale: Mode FULL from score 8/);
  for (const withheld of [
    'SYNTHETIC_PROFILE_PRIVATE_TEXT',
    'SYNTHETIC_MEMORY_EVIDENCE_SHOULD_NOT_BE_PRESENTED',
    'SYNTHETIC_EVENT_TEXT_SHOULD_NOT_BE_PRESENTED',
    'synthetic-provider-id',
    'resting_hr_bpm',
    '"score"'
  ]) {
    assert.equal(json.includes(withheld), false, `neutral response should not contain ${withheld}`);
    assert.equal(human.includes(withheld), false, `human response should not contain ${withheld}`);
  }
});

test('labels an unavailable recovery result as schedule-only and keeps its gaps', () => {
  const empty = structuredClone(healthyPreparation);
  empty.workout.mode = 'UNAVAILABLE';
  empty.workout.scheduled_only = true;
  empty.recovery.status = 'unavailable';
  empty.recovery.decision = {
    status: 'unavailable', mode: null, score: null, reasons: ['recovery_missing'],
    explanation: 'Recovery decision unavailable because no eligible synthetic recovery observations were available.'
  };
  empty.recovery.physical_metrics = {};
  empty.recovery.proprietary_scores = {};
  empty.memory = { status: 'missing', evidence: [] };
  empty.gaps = [{ code: 'recovery_missing', detail: 'No eligible synthetic recovery inputs were available.' }];

  const data = presentPreparation(empty);
  const human = renderPreparation(data);
  assert.equal(data.workout.scheduled_only, true);
  assert.equal(data.recovery.mode, null);
  assert.deepEqual(data.recovery.reasons, ['recovery_missing']);
  assert.match(data.recovery.explanation, /no eligible synthetic recovery observations/);
  assert.deepEqual(data.gaps, [{ code: 'recovery_missing', detail: 'No eligible synthetic recovery inputs were available.' }]);
  assert.match(human, /schedule candidate only; no recovery-supported decision is available/);
  assert.match(human, /recovery_missing/);
});

test('never emits blocked memory evidence, including in JSON mode', () => {
  const blocked = structuredClone(healthyPreparation);
  blocked.memory = {
    status: 'blocked',
    evidence: [{ excerpt: 'BLOCKED_DERIVED_MEMORY_SECRET' }]
  };
  blocked.gaps = [
    { code: 'derived_memory_blocked', detail: 'Blocked memory gap.' },
    { code: 'memory_review_stale', detail: 'Blocked memory page name and text.' },
    { code: 'recovery_missing', detail: 'An unrelated synthetic recovery gap.' }
  ];

  const data = presentPreparation(blocked);
  const output = `${JSON.stringify(data)}\n${renderPreparation(data)}`;
  assert.equal(data.memory_status, 'blocked');
  assert.equal(output.includes('BLOCKED_DERIVED_MEMORY_SECRET'), false);
  assert.equal(output.includes('Blocked memory page name and text.'), false);
  assert.match(output, /Derived memory was blocked and omitted/);
  assert.match(output, /An unrelated synthetic recovery gap/);
});

test('rejects unsupported Health OS preparation schema before presenting it', () => {
  assert.throws(
    () => presentPreparation({ ...healthyPreparation, schema_version: 2 }),
    /unsupported training preparation result/
  );
});

test('doctor presenter exposes only compatibility and workspace status fields', () => {
  const data = presentDoctor({
    version: { name: 'health-os', version: '0.1.0', secret: 'VERSION_SECRET' },
    capabilities: {
      cli_json_schema_version: 1,
      commands: ['prepare-training'],
      secret: 'CAPABILITY_SECRET'
    },
    workspace: {
      status: 'versioned', schema_version: 1, profile_status: 'valid',
      workspace: '/private/synthetic/path', error: 'PROFILE_CONTENT_SECRET'
    }
  });
  const output = `${JSON.stringify(data)}\n${renderDoctor(data)}`;
  assert.equal(data.prepare_training_available, true);
  assert.equal(output.includes('VERSION_SECRET'), false);
  assert.equal(output.includes('CAPABILITY_SECRET'), false);
  assert.equal(output.includes('/private/synthetic/path'), false);
  assert.equal(output.includes('PROFILE_CONTENT_SECRET'), false);
});
