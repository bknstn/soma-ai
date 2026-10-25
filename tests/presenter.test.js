import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { presentPreparation, presentDoctor, renderDoctor, renderPreparation } from '../src/presenter.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'training-preparation.synthetic.json');
const healthyPreparation = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('presents bounded health context in JSON while keeping it out of the human formatter', () => {
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
  assert.equal(data.health_context.profile.content, 'SYNTHETIC_PROFILE_PRIVATE_TEXT');
  assert.equal(data.health_context.profile.truncated, false);
  assert.equal(data.health_context.subjective.applied[0].target_sets_delta, -1);
  assert.equal(data.health_context.subjective.applied[0].provenance_ref, 'health-event:11111111-1111-4111-8111-111111111111@1');
  assert.deepEqual(data.health_context.subjective.applied[0].occurred, {
    start: '2026-10-24T09:00:00Z', end: null, precision: 'instant', timezone: 'UTC'
  });
  assert.equal(data.health_context.memory.status, 'available');
  assert.equal(data.health_context.memory.evidence[0].provenance[0], 'synthetic://workout-history#example');
  assert.match(json, /SYNTHETIC_MEMORY_EVIDENCE_SHOULD_BE_PRESENTED_ONLY_AS_BOUNDED_CONTEXT/);
  for (const withheld of [
    'SYNTHETIC_EVENT_TEXT_SHOULD_NOT_BE_PRESENTED',
    'SYNTHETIC_SOURCE_PATH_SHOULD_NOT_BE_PRESENTED',
    'synthetic-provider-id',
    'resting_hr_bpm',
    '"score"'
  ]) {
    assert.equal(json.includes(withheld), false, `bounded response should not contain ${withheld}`);
    assert.equal(human.includes(withheld), false, `human response should not contain ${withheld}`);
  }
  for (const privateContext of ['SYNTHETIC_PROFILE_PRIVATE_TEXT', 'SYNTHETIC_MEMORY_EVIDENCE_SHOULD_BE_PRESENTED_ONLY_AS_BOUNDED_CONTEXT']) {
    assert.equal(human.includes(privateContext), false, `human formatter should not contain ${privateContext}`);
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
  assert.equal(data.health_context.memory.status, 'blocked');
  assert.deepEqual(data.health_context.memory.evidence, []);
  assert.equal(output.includes('BLOCKED_DERIVED_MEMORY_SECRET'), false);
  assert.equal(output.includes('Blocked memory page name and text.'), false);
  assert.match(output, /Memory context was omitted because no usable evidence is available/);
  assert.match(output, /An unrelated synthetic recovery gap/);
});

test('missing and empty memory never forward evidence even when the native payload contains it', () => {
  for (const status of ['missing', 'empty']) {
    const input = structuredClone(healthyPreparation);
    input.memory = { status, evidence: [{ excerpt: 'STALE_EVIDENCE_MUST_NOT_PASS' }] };
    const data = presentPreparation(input);
    assert.equal(data.health_context.memory.status, status);
    assert.deepEqual(data.health_context.memory.evidence, []);
    assert.equal(JSON.stringify(data).includes('STALE_EVIDENCE_MUST_NOT_PASS'), false);
  }
});

test('preserves truncation metadata for local bounds and Health OS global output bounds', () => {
  const local = structuredClone(healthyPreparation);
  local.profile.content = 'P'.repeat(2_100);
  local.memory.evidence[0].excerpt = 'M'.repeat(1_100);
  const localData = presentPreparation(local);
  assert.equal(localData.health_context.profile.content.length, 2_000);
  assert.equal(localData.health_context.profile.truncated, true);
  assert.equal(localData.health_context.memory.evidence[0].excerpt.length, 500);
  assert.equal(localData.health_context.memory.evidence[0].truncated, true);

  const engineBounded = structuredClone(healthyPreparation);
  engineBounded.gaps = [{ code: 'preparation_output_bounded', detail: 'Narrative shortened.' }];
  const boundedData = presentPreparation(engineBounded);
  assert.equal(boundedData.health_context.profile.truncated, true);
  assert.equal(boundedData.health_context.memory.evidence[0].truncated, true);
});

test('memory without usable source provenance is marked unavailable and cannot be treated as a rule', () => {
  for (const provenance of [[], ['  ']]) {
    const input = structuredClone(healthyPreparation);
    input.memory.evidence[0].provenance = provenance;
    const data = presentPreparation(input);
    assert.equal(data.health_context.memory.status, 'available');
    assert.equal(data.health_context.memory.evidence[0].provenance_status, 'unavailable');
    assert.deepEqual(data.health_context.memory.evidence[0].provenance, []);
    assert.deepEqual(data.health_context.memory.context_gaps, [{
      code: 'memory_provenance_missing',
      detail: 'A retrieved memory excerpt has no source references; do not treat it as an established rule.'
    }]);
  }
});

test('fails closed on malformed or over-bound health context without echoing private text', () => {
  for (const mutate of [
    (input) => { input.profile.content = { private: 'MALFORMED_PRIVATE_TEXT' }; },
    (input) => { input.profile.content = ''; },
    (input) => { input.subjective.selected_facts[0].provenance_ref = 'PRIVATE_BAD_REF'; },
    (input) => { input.memory.evidence[0].excerpt = { private: 'MALFORMED_PRIVATE_MEMORY_TEXT' }; },
    (input) => { input.memory.evidence = []; },
    (input) => { input.subjective.selected_facts[0].occurred.timezone = 'MALFORMED_PRIVATE_TIMEZONE'; },
    (input) => { input.subjective.applied[0].occurred = { start: '2026-10-24T11:00:00Z', end: '2026-10-24T10:00:00Z', precision: 'interval', timezone: 'UTC' }; },
    (input) => {
      input.profile.content = 'P'.repeat(2_000);
      const event = input.subjective.applied[0];
      const longEvent = { ...event, value: 'V'.repeat(100) };
      input.subjective.applied = Array.from({ length: 8 }, () => structuredClone(longEvent));
      input.subjective.selected_facts = Array.from({ length: 8 }, () => structuredClone(longEvent));
      input.subjective.conversation_signals = Array.from({ length: 8 }, () => structuredClone(longEvent));
      input.memory.evidence = Array.from({ length: 3 }, (_, index) => ({
        ...input.memory.evidence[0],
        file: `wiki/context-${index}.md`,
        provenance: ['X'.repeat(200), 'Y'.repeat(200), 'Z'.repeat(200), 'A'.repeat(200), 'B'.repeat(200)],
        excerpt: 'M'.repeat(500)
      }));
    }
  ]) {
    const input = structuredClone(healthyPreparation);
    mutate(input);
    assert.throws(() => presentPreparation(input), (error) => {
      assert.doesNotMatch(error.message, /MALFORMED_PRIVATE_TEXT|MALFORMED_PRIVATE_MEMORY_TEXT|PRIVATE_BAD_REF/);
      return /invalid|above the SOMA context bound/.test(error.message);
    });
  }
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
