const SAFE_GAP_DETAIL = 'Derived memory was blocked and omitted from this response.';

const SOURCE_LABELS = Object.freeze([
  ['training_plan', 'Training plan'],
  ['preparation_policy', 'Preparation policy'],
  ['rules', 'Training rules'],
  ['exercise_settings', 'Exercise settings'],
  ['workout_sessions', 'Workout history'],
  ['exercise_logs', 'Exercise log history'],
  ['recovery', 'Recovery inputs']
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function safeMemoryStatus(memory) {
  const status = text(memory?.status, 'unknown');
  return ['available', 'empty', 'missing', 'blocked'].includes(status) ? status : 'unknown';
}

function safeGap(gap, memoryBlocked) {
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(text(gap?.code)) ? gap.code : 'unspecified_gap';
  const isMemoryGap = code.startsWith('memory_') || code === 'derived_memory_blocked';
  if (memoryBlocked && isMemoryGap) return { code, detail: SAFE_GAP_DETAIL };
  return {
    code,
    detail: text(gap?.detail).slice(0, 500)
  };
}

function safeExercise(exercise) {
  if (!record(exercise)) return null;
  const name = text(exercise.exercise_name, text(exercise.exercise_key, 'Exercise')).slice(0, 120);
  const reps = text(exercise.target_reps, '').slice(0, 30);
  const rawWeight = text(exercise.target_weight, '');
  const weight = finiteNumber(rawWeight);
  return {
    name,
    sets: Number.isSafeInteger(exercise.target_sets) && exercise.target_sets >= 0 ? exercise.target_sets : null,
    reps,
    target_weight_kg: weight
  };
}

/** Convert Health OS training preparation into the deliberately small SOMA response contract. */
export function presentPreparation(data) {
  if (!record(data) || data.schema_version !== 1 || !record(data.workout) ||
      !record(data.session_selection) || !record(data.recovery?.decision) ||
      !record(data.memory) || !Array.isArray(data.gaps) || !record(data.provenance)) {
    throw new Error('Health OS returned an unsupported training preparation result.');
  }

  const exercises = Array.isArray(data.workout.exercises)
    ? data.workout.exercises.map(safeExercise).filter(Boolean)
    : [];
  const memoryStatus = safeMemoryStatus(data.memory);
  const memoryBlocked = memoryStatus === 'blocked';
  const sources = SOURCE_LABELS.flatMap(([key, label]) => {
    const ref = data.provenance[key];
    const safeRelativeRef = typeof ref === 'string' && ref.startsWith('.health-os/') &&
      ref.length <= 240 && !ref.split('/').some((part) => part === '..');
    return safeRelativeRef ? [{ label, ref }] : [];
  });
  const recoveryReasons = Array.isArray(data.recovery.decision.reasons)
    ? data.recovery.decision.reasons.filter((item) => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 100))
    : [];

  return {
    as_of: text(data.as_of?.value),
    session: {
      day_type: text(data.session_selection.selected_day_type),
      strategy: text(data.session_selection.strategy),
      reason: text(data.session_selection.reason).slice(0, 300)
    },
    workout: {
      mode: text(data.workout.mode, 'UNAVAILABLE'),
      scheduled_only: data.workout.scheduled_only === true,
      exercises
    },
    recovery: {
      status: text(data.recovery.decision.status, 'unavailable'),
      mode: text(data.recovery.decision.mode) || null,
      reasons: recoveryReasons,
      explanation: text(data.recovery.decision.explanation).slice(0, 500)
    },
    gaps: data.gaps.slice(0, 50).map((gap) => safeGap(gap, memoryBlocked)),
    sources,
    memory_status: memoryStatus
  };
}

export function renderPreparation(data) {
  const lines = [`Training preparation for ${data.as_of || 'the requested time'}`];
  const { session, workout, recovery } = data;
  lines.push(`Session: ${session.day_type || 'unspecified'} (${session.strategy || 'unspecified'})`);
  if (session.reason) lines.push(`Selection reason: ${session.reason}`);

  if (workout.scheduled_only || recovery.status !== 'available') {
    lines.push('Plan status: schedule candidate only; no recovery-supported decision is available.');
  } else {
    lines.push(`Plan status: recovery decision available${recovery.mode ? ` (${recovery.mode})` : ''}.`);
  }
  if (recovery.reasons.length) lines.push(`Recovery reasons: ${recovery.reasons.join(', ')}`);
  if (recovery.explanation) lines.push(`Recovery rationale: ${recovery.explanation}`);

  lines.push('Scheduled exercises:');
  if (workout.exercises.length === 0) {
    lines.push('- None');
  } else {
    for (const exercise of workout.exercises) {
      const reps = exercise.reps ? `, ${exercise.reps} reps` : '';
      const sets = exercise.sets === null ? '' : `${exercise.sets} sets`;
      const weight = exercise.target_weight_kg === null ? '' : `, ${exercise.target_weight_kg} kg`;
      lines.push(`- ${exercise.name}: ${sets}${reps}${weight}`);
    }
  }

  if (data.gaps.length) {
    lines.push(`Gaps (${data.gaps.length}):`);
    for (const gap of data.gaps) lines.push(`- ${gap.code}: ${gap.detail}`);
  } else {
    lines.push('Gaps: none reported');
  }
  lines.push('Sources:');
  if (data.sources.length) {
    for (const source of data.sources) lines.push(`- ${source.label} (${source.ref})`);
  } else {
    lines.push('- None reported');
  }
  if (data.memory_status === 'blocked') lines.push('Derived memory: blocked and omitted.');
  return `${lines.join('\n')}\n`;
}

export function presentDoctor(result) {
  if (!record(result)) throw new Error('Health OS doctor returned an unsupported result.');
  const version = record(result.version) ? result.version : {};
  const capabilities = record(result.capabilities) ? result.capabilities : {};
  const workspace = record(result.workspace) ? result.workspace : {};
  return {
    health_os: {
      name: text(version.name, text(capabilities.name, 'Health OS')),
      version: text(version.version, text(capabilities.version, 'unknown')),
      cli_json_schema_version: finiteNumber(capabilities.cli_json_schema_version)
    },
    prepare_training_available: Array.isArray(capabilities.commands) && capabilities.commands.includes('prepare-training'),
    workspace: {
      status: text(workspace.status, 'unknown'),
      schema_version: finiteNumber(workspace.schema_version),
      profile_status: text(workspace.profile_status) || null
    }
  };
}

export function renderDoctor(data) {
  const lines = [
    'SOMA doctor',
    `Health OS: ${data.health_os.name} ${data.health_os.version}`,
    `CLI JSON schema: ${data.health_os.cli_json_schema_version ?? 'unknown'}`,
    `prepare-training: ${data.prepare_training_available ? 'available' : 'unavailable'}`,
    `Workspace: ${data.workspace.status}`
  ];
  if (data.workspace.schema_version !== null) lines.push(`Workspace schema: ${data.workspace.schema_version}`);
  if (data.workspace.profile_status) lines.push(`Selected profile: ${data.workspace.profile_status}`);
  return `${lines.join('\n')}\n`;
}
