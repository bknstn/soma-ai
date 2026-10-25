const SAFE_GAP_DETAIL = 'Memory context was omitted because no usable evidence is available.';

const SOURCE_LABELS = Object.freeze([
  ['training_plan', 'Training plan'],
  ['preparation_policy', 'Preparation policy'],
  ['rules', 'Training rules'],
  ['exercise_settings', 'Exercise settings'],
  ['workout_sessions', 'Workout history'],
  ['exercise_logs', 'Exercise log history'],
  ['recovery', 'Recovery inputs']
]);
const MAX_PROFILE_CONTEXT_CHARS = 2_000;
const MAX_SUBJECTIVE_ITEMS = 8;
const MAX_MEMORY_PAGES = 3;
const MAX_MEMORY_EXCERPT_CHARS = 500;
const MAX_HEALTH_CONTEXT_BYTES = 10 * 1024;
const MEMORY_PAGE_STATUSES = new Set(['observation', 'hypothesis', 'accepted_rule', 'general_claim', 'unknown']);
const MEMORY_CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);

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

function safeRelativeMarkdownPath(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.endsWith('.md') &&
    !value.includes('\\') && value.length <= 240 &&
    !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function safeDateOrNull(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function presentProfileContext(profile, engineBounded) {
  if (!record(profile) || !['available', 'missing'].includes(profile.status)) {
    throw new Error('Health OS returned an invalid bounded profile context.');
  }
  if (profile.status === 'missing') {
    if (profile.content !== null || profile.path !== null || profile.updated !== null) {
      throw new Error('Health OS returned an invalid bounded profile context.');
    }
    return { status: 'missing', path: null, updated: null, content: null, truncated: false };
  }
  if (!safeRelativeMarkdownPath(profile.path, 'personal/files/') || typeof profile.content !== 'string' ||
      profile.content.length === 0 || !safeDateOrNull(profile.updated) || typeof profile.truncated !== 'boolean') {
    throw new Error('Health OS returned an invalid bounded profile context.');
  }
  const profileText = [...profile.content];
  const clipped = profileText.length > MAX_PROFILE_CONTEXT_CHARS;
  return {
    status: 'available',
    path: profile.path,
    updated: profile.updated,
    content: profileText.slice(0, MAX_PROFILE_CONTEXT_CHARS).join(''),
    truncated: profile.truncated || engineBounded || clipped
  };
}

function presentSubjectiveItem(item) {
  if (!record(item) || !/^[a-z][a-z0-9_.-]{0,79}$/.test(text(item.event_type)) ||
      !record(item.occurred) ||
      !['fact', 'pending'].includes(text(item.epistemic_status)) ||
      !['low', 'medium', 'high', 'unknown'].includes(text(item.uncertainty_level)) ||
      typeof item.provenance_ref !== 'string' || !/^health-event:[a-z0-9-]{1,80}@\d{1,9}$/.test(item.provenance_ref)) {
    throw new Error('Health OS returned invalid subjective context.');
  }
  const value = typeof item.value === 'number' && Number.isFinite(item.value)
    ? item.value
    : typeof item.value === 'boolean' ? item.value
      : typeof item.value === 'string' && item.value.length <= 100 ? item.value : null;
  const occurred = presentOccurrence(item.occurred);
  return {
    event_type: item.event_type,
    occurred,
    epistemic_status: item.epistemic_status,
    uncertainty_level: item.uncertainty_level,
    value,
    provenance_ref: item.provenance_ref
  };
}

function presentSubjectiveContext(subjective) {
  if (!record(subjective) || !Array.isArray(subjective.applied) ||
      !Array.isArray(subjective.selected_facts) || !Array.isArray(subjective.conversation_signals)) {
    throw new Error('Health OS returned invalid subjective context.');
  }
  const applied = subjective.applied.slice(0, MAX_SUBJECTIVE_ITEMS).map((item) => {
    const event = presentSubjectiveItem(item);
    if (!Number.isSafeInteger(item.target_sets_delta) || item.target_sets_delta > 0 || item.target_sets_delta < -20) {
      throw new Error('Health OS returned invalid subjective context.');
    }
    return { ...event, target_sets_delta: item.target_sets_delta };
  });
  return {
    applied,
    selected_facts: subjective.selected_facts.slice(0, MAX_SUBJECTIVE_ITEMS).map(presentSubjectiveItem),
    conversation_signals: subjective.conversation_signals.slice(0, MAX_SUBJECTIVE_ITEMS).map(presentSubjectiveItem),
    truncated: subjective.truncated === true || subjective.applied.length > MAX_SUBJECTIVE_ITEMS ||
      subjective.selected_facts.length > MAX_SUBJECTIVE_ITEMS || subjective.conversation_signals.length > MAX_SUBJECTIVE_ITEMS
  };
}

function presentMemoryContext(memory, engineBounded) {
  if (!record(memory)) throw new Error('Health OS returned an invalid memory context.');
  const status = safeMemoryStatus(memory);
  if (status === 'blocked' || status === 'missing' || status === 'empty') {
    return { status, evidence: [], truncated: false, context_gaps: [] };
  }
  if (status !== 'available' || !Array.isArray(memory.evidence) || memory.evidence.length === 0) {
    throw new Error('Health OS returned an invalid memory context.');
  }
  const contextGaps = [];
  const evidence = memory.evidence.slice(0, MAX_MEMORY_PAGES).map((page) => {
    if (!record(page) || !safeRelativeMarkdownPath(page.file, '') || typeof page.title !== 'string' ||
        page.title.length > 200 || !MEMORY_PAGE_STATUSES.has(page.status) ||
        !MEMORY_CONFIDENCE_LEVELS.has(page.confidence) ||
        !safeDateOrNull(page.evidence_start) || !safeDateOrNull(page.evidence_end) ||
        !safeDateOrNull(page.last_reviewed) || !['current', 'stale'].includes(text(page.review_status)) ||
        !Array.isArray(page.provenance) ||
        page.provenance.some((ref) => typeof ref !== 'string' || ref.length > 200) ||
        typeof page.excerpt !== 'string' || page.excerpt.trim() === '' ||
        !['evidence/', 'wiki/'].some((prefix) => safeRelativeMarkdownPath(page.file, prefix))) {
      throw new Error('Health OS returned an invalid memory context.');
    }
    const provenance = page.provenance.filter((ref) => ref.trim() !== '');
    if (provenance.length === 0) {
      contextGaps.push({ code: 'memory_provenance_missing', detail: 'A retrieved memory excerpt has no source references; do not treat it as an established rule.' });
    }
    const excerptText = [...page.excerpt];
    const clipped = excerptText.length > MAX_MEMORY_EXCERPT_CHARS || excerptText.length >= 1_000;
    return {
      file: page.file,
      title: page.title,
      status: page.status,
      confidence: page.confidence,
      evidence_start: page.evidence_start,
      evidence_end: page.evidence_end,
      last_reviewed: page.last_reviewed,
      review_status: page.review_status,
      provenance: provenance.slice(0, 5),
      provenance_status: provenance.length > 0 ? 'available' : 'unavailable',
      excerpt: excerptText.slice(0, MAX_MEMORY_EXCERPT_CHARS).join(''),
      truncated: clipped || engineBounded || provenance.length > 5
    };
  });
  return {
    status: 'available',
    evidence,
    truncated: memory.evidence.length > MAX_MEMORY_PAGES || engineBounded || evidence.some((page) => page.truncated),
    context_gaps: contextGaps
  };
}

function presentHealthContext(data) {
  const engineBounded = Array.isArray(data.gaps) && data.gaps.some((gap) => gap?.code === 'preparation_output_bounded');
  const context = {
    profile: presentProfileContext(data.profile, engineBounded),
    subjective: presentSubjectiveContext(data.subjective),
    memory: presentMemoryContext(data.memory, engineBounded)
  };
  if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_HEALTH_CONTEXT_BYTES) {
    throw new Error('Health OS returned health context above the SOMA context bound.');
  }
  return context;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !safeDateOrNull(value.slice(0, 10))) return false;
  const time = value.slice(11, 19);
  if (Number(time.slice(0, 2)) > 23 || Number(time.slice(3, 5)) > 59 || Number(time.slice(6, 8)) > 59) return false;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (offset && (Number(offset[2]) > 14 || Number(offset[3]) > 59 ||
      (Number(offset[2]) === 14 && Number(offset[3]) !== 0))) return false;
  return Number.isFinite(Date.parse(value));
}

function validOccurrenceBound(value) {
  return typeof value === 'string' && (safeDateOrNull(value) || validTimestamp(value));
}

function validTimezone(value) {
  if (value === null || value === 'Z') return true;
  if (typeof value !== 'string' || value.length > 100) return false;
  const offset = /^[+-](\d{2}):(\d{2})$/.exec(value);
  if (offset) {
    const [, hours, minutes] = offset;
    return Number(hours) <= 14 && Number(minutes) <= 59 && (Number(hours) !== 14 || Number(minutes) === 0);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function presentOccurrence(value) {
  const allowed = new Set(['start', 'end', 'precision', 'timezone']);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      !Object.hasOwn(value, 'start') || !Object.hasOwn(value, 'end') ||
      !Object.hasOwn(value, 'precision') || !Object.hasOwn(value, 'timezone') ||
      !['instant', 'second', 'minute', 'hour', 'day', 'interval', 'unknown'].includes(value.precision) ||
      !validTimezone(value.timezone)) {
    throw new Error('Health OS returned invalid subjective context.');
  }
  const { start, end, precision, timezone } = value;
  if (precision === 'unknown') {
    if (start !== null || end !== null) throw new Error('Health OS returned invalid subjective context.');
  } else if (precision === 'day') {
    if (!safeDateOrNull(start) || typeof start !== 'string' || end !== null) throw new Error('Health OS returned invalid subjective context.');
  } else if (precision === 'interval') {
    if (!validOccurrenceBound(start) || !validOccurrenceBound(end) ||
        (/^\d{4}-\d{2}-\d{2}$/.test(start) !== /^\d{4}-\d{2}-\d{2}$/.test(end)) ||
        (typeof start === 'string' && (start.length === 10 ? start > end : Date.parse(start) > Date.parse(end)))) {
      throw new Error('Health OS returned invalid subjective context.');
    }
  } else if (!validTimestamp(start) || end !== null) {
    throw new Error('Health OS returned invalid subjective context.');
  }
  return { start, end, precision, timezone };
}

function safeGap(gap, memoryUnavailable) {
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(text(gap?.code)) ? gap.code : 'unspecified_gap';
  const isMemoryGap = code.startsWith('memory_') || code === 'derived_memory_blocked';
  if (memoryUnavailable && isMemoryGap) return { code, detail: SAFE_GAP_DETAIL };
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
  const healthContext = presentHealthContext(data);
  const memoryStatus = safeMemoryStatus(data.memory);
  const memoryUnavailable = memoryStatus !== 'available';
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
    health_context: healthContext,
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
    gaps: data.gaps.slice(0, 50).map((gap) => safeGap(gap, memoryUnavailable)),
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
