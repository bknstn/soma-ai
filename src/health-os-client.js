import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  HEALTH_OS_CLI_SCHEMA_VERSION,
  HEALTH_OS_MAX_JSON_OUTPUT_BYTES,
  HEALTH_OS_PACKAGE_VERSION,
  HEALTH_OS_PREPARATION_SCHEMA_VERSION,
  HEALTH_OS_WORKSPACE_SCHEMA_VERSION,
  loadConfig
} from './config.js';

const DIRTY_RUNTIME_PATHS = ['src', 'package.json', 'config', 'templates'];
const MAX_STDERR_BYTES = 64 * 1024;
const MIN_NODE_VERSION = [22, 13, 0];
const REQUIRED_COMMANDS = ['version', 'capabilities', 'workspace-inspect', 'init-workspace', 'prepare-training',
  'profile-show', 'timeline', 'log-workout', 'set-working-weight'];
const HEALTH_OS_PROFILE_MAX_CHARS = 50_000;
const HEALTH_OS_TIMELINE_LIMIT = 50;
const WORKOUT_SOURCES = new Set(['legacy.workout_session']);
const DOMAIN_GAP_FIELDS = ['code', 'detail'];
const MEMORY_STATUSES = new Set(['available', 'empty', 'missing', 'blocked']);
const RECOVERY_STATUSES = new Set(['available', 'unavailable']);
const RECOVERY_MODES = new Set(['FULL', 'BASE', 'LIGHT']);
const PROVENANCE_FIELDS = ['training_plan', 'preparation_policy', 'rules', 'exercise_settings', 'workout_sessions', 'exercise_logs', 'recovery'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validProfilePath(value) {
  if (typeof value !== 'string' || !value.startsWith('personal/files/') ||
      !value.endsWith('.md') || value.includes(String.fromCharCode(92)) || value.startsWith('/')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new HealthOsError('A valid idempotency key is required for this write.', { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
  }
  return key;
}

function validateWorkoutPayload(payload) {
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const fail = () => { throw new HealthOsError('Workout payload does not match the supported Health OS JSON shape.', { code: 'HEALTH_OS_ACTION_INPUT_INVALID' }); };
  if (!isRecord(payload) || !isRecord(payload.session) || !Array.isArray(payload.exercises) ||
      Object.keys(payload).some((key) => !['session', 'exercises'].includes(key))) fail();
  const sessionKeys = ['day', 'actual_mode', 'duration_minutes', 'session_rpe', 'energy_pre', 'soreness_pre', 'notes'];
  if (Object.keys(payload.session).some((key) => !sessionKeys.includes(key)) ||
      !['A', 'B'].includes(payload.session.day) || !['FULL', 'BASE', 'LIGHT'].includes(payload.session.actual_mode) ||
      !['duration_minutes', 'session_rpe', 'energy_pre', 'soreness_pre'].every((key) =>
        typeof payload.session[key] === 'number' && Number.isFinite(payload.session[key])) ||
      (payload.session.notes !== undefined && typeof payload.session.notes !== 'string') ||
      payload.exercises.length < 1 || payload.exercises.length > 50) fail();
  for (const exercise of payload.exercises) {
    if (!isRecord(exercise) || Object.keys(exercise).some((key) => !['exercise_key', 'sets'].includes(key)) ||
        typeof exercise.exercise_key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(exercise.exercise_key) ||
        !Array.isArray(exercise.sets) || exercise.sets.length < 1 || exercise.sets.length > 100) fail();
    for (const set of exercise.sets) {
      if (!isRecord(set) || Object.keys(set).some((key) => !['weight', 'reps'].includes(key)) ||
          !(set.weight === 'bw' || (typeof set.weight === 'number' && Number.isFinite(set.weight) && set.weight >= 0)) ||
          !Number.isInteger(set.reps) || set.reps < 1) fail();
    }
  }
  return payload;
}

function workoutTimelineComplete(data) {
  if (data.truncated !== false || data.content_truncated !== false ||
      data.omitted_legacy_rows !== 0 || data.records_with_truncated_content !== 0 ||
      data.source_issues_truncated === true || data.matched_count !== data.returned_count ||
      (data.omission_counts && Object.values(data.omission_counts).some((count) => count !== 0))) return false;
  if (Number.isSafeInteger(data.source_issue_count) && Array.isArray(data.source_issues) &&
      data.source_issue_count > data.source_issues.length) return false;
  if (Array.isArray(data.source_issues) && data.source_issues.some((issue) =>
    ['workout_sessions.csv', 'exercise_logs.csv'].includes(issue.source))) return false;
  return data.items.every((item) => item.data_truncated === false &&
    item.data?.exercises_truncated === undefined &&
    Array.isArray(item.data?.exercises) &&
    Array.isArray(item.data?.issues) && item.data.issues.length === 0 &&
    item.data.exercises.every((exercise) => Array.isArray(exercise.issues) && exercise.issues.length === 0));
}

function validateTimelineResult(data) {
  if (!isObject(data) || !Array.isArray(data.items) ||
      !Number.isSafeInteger(data.matched_count) || data.matched_count < 0 ||
      !Number.isSafeInteger(data.returned_count) || data.returned_count !== data.items.length ||
      data.matched_count < data.returned_count || !Number.isSafeInteger(data.limit) || data.limit < 1 ||
      data.returned_count > data.limit || typeof data.truncated !== 'boolean' ||
      typeof data.content_truncated !== 'boolean' ||
      !Number.isSafeInteger(data.records_with_truncated_content) || data.records_with_truncated_content < 0 ||
      !Number.isSafeInteger(data.omitted_legacy_rows) || data.omitted_legacy_rows < 0 ||
      !isObject(data.omission_counts) || Object.values(data.omission_counts).some((count) =>
        !Number.isSafeInteger(count) || count < 0) ||
      !Number.isSafeInteger(data.source_issue_count) || data.source_issue_count < 0 ||
      !Array.isArray(data.source_issues) ||
      data.source_issues.some((issue) => !isObject(issue) || !nonEmptyString(issue.source) || !nonEmptyString(issue.reason)) ||
      typeof data.source_issues_truncated !== 'boolean') {
    throw new HealthOsError('Health OS returned an invalid bounded workout history.', { code: 'HEALTH_OS_INVALID_HISTORY' });
  }
  const itemDataTruncations = data.items.filter((item) => isObject(item) && item.data_truncated === true).length;
  const expectedContentTruncation = itemDataTruncations > 0 ||
    data.returned_count < Math.min(data.matched_count, data.limit);
  const expectedTopLevelTruncation = data.matched_count > data.limit || data.content_truncated;
  if (data.records_with_truncated_content !== itemDataTruncations ||
      (expectedContentTruncation && !data.content_truncated) ||
      (expectedTopLevelTruncation && !data.truncated)) {
    throw new HealthOsError('Health OS returned inconsistent workout history completeness metadata.', {
      code: 'HEALTH_OS_INVALID_HISTORY'
    });
  }

  const normalizedItems = [];
  for (const item of data.items) {
    if (!isObject(item) || !nonEmptyString(item.id) || item.type !== 'workout' ||
        !WORKOUT_SOURCES.has(item.source?.kind) || !nonEmptyString(item.source?.ref) ||
        typeof item.source?.fragment_id !== 'string' ||
        !validDay(item.occurred?.start) || item.occurred.end !== null ||
        item.occurred.precision !== 'day' || item.occurred.timezone !== null ||
        typeof item.data_truncated !== 'boolean' || !Object.hasOwn(item, 'data')) {
      throw new HealthOsError('Health OS returned an unsupported workout history record.', { code: 'HEALTH_OS_INVALID_HISTORY' });
    }
    if (item.data_truncated) {
      normalizedItems.push({ ...item, data: null });
      continue;
    }
    if (!isObject(item.data) || !isObject(item.data.session) || !Array.isArray(item.data.exercises) ||
        !Array.isArray(item.data.issues) ||
        (item.data.exercises_truncated !== undefined &&
          (!Number.isSafeInteger(item.data.exercises_truncated) || item.data.exercises_truncated < 1))) {
      throw new HealthOsError('Health OS returned an unsupported workout history record.', { code: 'HEALTH_OS_INVALID_HISTORY' });
    }
    if (item.data.exercises.length === 0 && item.data.exercises_truncated === undefined) {
      throw new HealthOsError('Health OS returned a workout session without its linked exercise rows.', { code: 'HEALTH_OS_INVALID_HISTORY' });
    }
    for (const issue of item.data.issues) {
      if (!isObject(issue) || !nonEmptyString(issue.reason)) {
        throw new HealthOsError('Health OS returned malformed workout issue metadata.', { code: 'HEALTH_OS_INVALID_HISTORY' });
      }
    }
    for (const exercise of item.data.exercises) {
      if (!isObject(exercise) || typeof exercise.exercise_key !== 'string' ||
          typeof exercise.reps !== 'string' || exercise.reps.length === 0 ||
          exercise.reps.split('|').length !== exercise.set_count ||
          !(typeof exercise.notes === 'string' || exercise.notes === null) ||
          !(typeof exercise.weight === 'number' || exercise.weight === 'bw' || exercise.weight === null) ||
          !Number.isInteger(exercise.set_count) || exercise.set_count < 1 ||
          (exercise.issues !== undefined && (!Array.isArray(exercise.issues) || exercise.issues.some((issue) =>
            !isObject(issue) || !nonEmptyString(issue.reason))))) {
        throw new HealthOsError('Health OS returned incomplete exercise set details.', { code: 'HEALTH_OS_INVALID_HISTORY' });
      }
    }
    const knownPartial = item.data.exercises_truncated !== undefined || item.data.issues.length > 0 ||
      item.data.exercises.some((exercise) => Array.isArray(exercise.issues) && exercise.issues.length > 0);
    normalizedItems.push(knownPartial ? { ...item, data: null } : item);
  }
  for (let index = 1; index < normalizedItems.length; index += 1) {
    if (normalizedItems[index - 1].occurred.start > normalizedItems[index].occurred.start) {
      throw new HealthOsError('Health OS returned workout rows out of chronological order.', { code: 'HEALTH_OS_INVALID_HISTORY' });
    }
  }
  return { ...data, items: normalizedItems };
}

export class HealthOsError extends Error {
  constructor(message, { code = 'HEALTH_OS_ERROR', command, exitCode, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HealthOsError';
    this.code = code;
    if (command) this.command = command;
    if (exitCode !== undefined && exitCode !== null) this.exitCode = exitCode;
  }
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalMaybeMissing(inputPath) {
  let current = path.resolve(inputPath);
  const suffix = [];
  while (true) {
    try {
      const stat = fs.statSync(current);
      if (suffix.length > 0 && !stat.isDirectory()) {
        throw new HealthOsError('The workspace path has a non-directory parent', { code: 'HEALTH_OS_WORKSPACE_PATH_INVALID' });
      }
      const resolved = fs.realpathSync(current);
      return path.resolve(resolved, ...suffix.reverse());
    } catch (error) {
      if (error instanceof HealthOsError) throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new HealthOsError('Could not resolve the Health OS workspace path', {
          code: 'HEALTH_OS_WORKSPACE_PATH_INVALID', cause: error
        });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new HealthOsError('Could not resolve the Health OS workspace path', { code: 'HEALTH_OS_WORKSPACE_PATH_INVALID' });
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  return match ? match.slice(1).map(Number) : null;
}

function nodeVersionSupported() {
  const actual = parseNodeVersion(process.versions.node);
  if (!actual) return false;
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (actual[index] > MIN_NODE_VERSION[index]) return true;
    if (actual[index] < MIN_NODE_VERSION[index]) return false;
  }
  return true;
}

function minimalEnvironment() {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'TZ']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function gitOutput(repo, args) {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: minimalEnvironment(),
      timeout: 5_000,
      maxBuffer: 16 * 1024
    }).trim();
  } catch (error) {
    throw new HealthOsError('Could not verify the Health OS checkout', {
      code: 'HEALTH_OS_REPOSITORY_INVALID', cause: error
    });
  }
}

function validateDomainResult(data, command) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HealthOsError('Health OS preparation returned no domain object', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (data.schema_version !== HEALTH_OS_PREPARATION_SCHEMA_VERSION) {
    throw new HealthOsError('Health OS returned an unsupported preparation schema', { code: 'HEALTH_OS_SCHEMA_MISMATCH', command });
  }
  if (!data.as_of || typeof data.as_of !== 'object' || typeof data.as_of.value !== 'string') {
    throw new HealthOsError('Health OS preparation omitted its as-of value', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!isObject(data.session_selection) || !isObject(data.workout)) {
    throw new HealthOsError('Health OS preparation omitted its session or workout result', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!nonEmptyString(data.session_selection.selected_day_type) || !nonEmptyString(data.session_selection.strategy) ||
      !nonEmptyString(data.session_selection.reason)) {
    throw new HealthOsError('Health OS preparation returned incomplete session-selection details', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (typeof data.workout.scheduled_only !== 'boolean' || !nonEmptyString(data.workout.mode) || !Array.isArray(data.workout.exercises)) {
    throw new HealthOsError('Health OS preparation returned incomplete workout details', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  for (const exercise of data.workout.exercises) {
    if (!isObject(exercise) || !nonEmptyString(exercise.exercise_name) || !nonEmptyString(exercise.exercise_key) ||
        !Number.isInteger(exercise.target_sets) || exercise.target_sets < 0 || !nonEmptyString(exercise.target_reps) ||
        !(typeof exercise.target_weight === 'string' || exercise.target_weight === null)) {
      throw new HealthOsError('Health OS preparation returned an invalid exercise candidate', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
    }
  }
  if (!isObject(data.recovery) || !isObject(data.recovery.decision)) {
    throw new HealthOsError('Health OS preparation omitted its recovery decision state', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!RECOVERY_STATUSES.has(data.recovery.decision.status) || data.recovery.status !== data.recovery.decision.status) {
    throw new HealthOsError('Health OS returned an unsupported recovery decision status', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!nonEmptyString(data.recovery.decision.explanation) || !Array.isArray(data.recovery.decision.reasons) ||
      data.recovery.decision.reasons.some((reason) => !nonEmptyString(reason))) {
    throw new HealthOsError('Health OS returned incomplete recovery explanation details', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!isObject(data.memory) || !MEMORY_STATUSES.has(data.memory.status)) {
    throw new HealthOsError('Health OS returned an unsupported memory status', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (data.memory.status !== 'available' && Array.isArray(data.memory.evidence) && data.memory.evidence.length > 0) {
    throw new HealthOsError('Health OS exposed derived memory while its review status was blocked', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!Array.isArray(data.gaps) || data.gaps.some((gap) => !gap || typeof gap !== 'object' ||
    DOMAIN_GAP_FIELDS.some((field) => typeof gap[field] !== 'string'))) {
    throw new HealthOsError('Health OS preparation returned invalid gap details', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  if (!isObject(data.profile) || !['available', 'missing'].includes(data.profile.status) ||
      !isObject(data.subjective) || !isObject(data.provenance) ||
      PROVENANCE_FIELDS.some((field) => !nonEmptyString(data.provenance[field]))) {
    throw new HealthOsError('Health OS preparation omitted subjectivity or provenance metadata', { code: 'HEALTH_OS_INVALID_DOMAIN', command });
  }
  const decision = data.recovery.decision;
  if (decision.status === 'available') {
    if (!RECOVERY_MODES.has(decision.mode) || !Number.isFinite(decision.score) ||
        data.workout.scheduled_only || data.workout.mode !== decision.mode) {
      throw new HealthOsError('Health OS returned an inconsistent available-recovery workout', {
        code: 'HEALTH_OS_INVALID_DOMAIN', command
      });
    }
  } else if (decision.mode !== null || decision.score !== null || data.workout.mode !== 'UNAVAILABLE' || !data.workout.scheduled_only) {
    throw new HealthOsError('Health OS returned an inconsistent unavailable-recovery workout', {
      code: 'HEALTH_OS_INVALID_DOMAIN', command
    });
  }
  return data;
}

export function parseHealthOsEnvelope({ command, status, stdout, expectedSchemaVersion = HEALTH_OS_CLI_SCHEMA_VERSION }) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch (error) {
    throw new HealthOsError(`Health OS ${command} did not return one valid JSON envelope`, {
      code: 'HEALTH_OS_INVALID_JSON', command, exitCode: status, cause: error
    });
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.schema_version !== expectedSchemaVersion || envelope.command !== command || typeof envelope.ok !== 'boolean') {
    throw new HealthOsError(`Health OS ${command} returned an unsupported JSON envelope`, {
      code: 'HEALTH_OS_INVALID_ENVELOPE', command, exitCode: status
    });
  }
  if (envelope.truncation !== undefined &&
      (!envelope.truncation || typeof envelope.truncation !== 'object' || envelope.truncation.truncated !== true)) {
    throw new HealthOsError(`Health OS ${command} returned invalid truncation metadata`, {
      code: 'HEALTH_OS_INVALID_ENVELOPE', command, exitCode: status
    });
  }
  if (envelope.truncation?.truncated) {
    throw new HealthOsError(`Health OS ${command} output was truncated; refusing to use partial context`, {
      code: 'HEALTH_OS_OUTPUT_TRUNCATED', command, exitCode: status
    });
  }
  if (status !== 0 || !envelope.ok) {
    const error = envelope.error;
    if (!error || typeof error !== 'object' || Array.isArray(error) ||
        typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new HealthOsError(`Health OS ${command} failed without a valid JSON error`, {
        code: 'HEALTH_OS_COMMAND_FAILED', command, exitCode: status
      });
    }
    throw new HealthOsError(`Health OS ${command} failed (${error.code}): ${error.message}`, {
      code: error.code, command, exitCode: status
    });
  }
  if (!Object.hasOwn(envelope, 'data') || Object.hasOwn(envelope, 'error')) {
    throw new HealthOsError(`Health OS ${command} returned an invalid success envelope`, {
      code: 'HEALTH_OS_INVALID_ENVELOPE', command, exitCode: status
    });
  }
  return envelope;
}

export class HealthOsClient {
  #config;
  #repo;
  #cliPath;
  #discovery;

  constructor(config = {}) {
    this.#config = loadConfig(config);
    if (!this.#config.workspace) {
      throw new HealthOsError('Set HEALTH_OS_WORKSPACE or provide an explicit workspace path', {
        code: 'HEALTH_OS_WORKSPACE_REQUIRED'
      });
    }
    this.#repo = this.#config.repo;
    this.#cliPath = path.join(this.#repo, 'src', 'cli.js');
    if (!nodeVersionSupported()) {
      throw new HealthOsError('Health OS requires Node.js 22.13.0 or newer', { code: 'HEALTH_OS_NODE_VERSION_UNSUPPORTED' });
    }
  }

  async discover() {
    this.#assertRepositoryCompatibility();
    const version = await this.#runEnvelope('version', []);
    if (!version.data || version.data.name !== 'health-os' || version.data.version !== HEALTH_OS_PACKAGE_VERSION) {
      throw new HealthOsError('Health OS returned an unsupported package identity or version', {
        code: 'HEALTH_OS_VERSION_MISMATCH', command: 'version'
      });
    }
    const capabilitiesEnvelope = await this.#runEnvelope('capabilities', []);
    const capabilities = capabilitiesEnvelope.data;
    this.#validateCapabilities(capabilities);
    const discovered = Object.freeze({ version: version.data, capabilities });
    this.#discovery = discovered;
    return discovered;
  }

  async doctor() {
    const { version, capabilities } = await this.#ensureDiscovered();
    const workspace = await this.inspectWorkspace();
    return { version, capabilities, workspace };
  }

  async inspectWorkspace() {
    const { capabilities } = await this.#ensureDiscovered();
    this.#assertRepositoryCompatibility();
    this.#assertWorkspaceLocation();
    const envelope = await this.#runEnvelope('workspace-inspect', [], capabilities.cli_json_schema_version);
    const inspection = envelope.data;
    const knownStatuses = new Set(['uninitialized', 'unversioned', 'versioned']);
    if (!inspection || typeof inspection !== 'object' || !knownStatuses.has(inspection.status)) {
      throw new HealthOsError('Health OS returned an unsupported workspace inspection result', {
        code: 'HEALTH_OS_INVALID_WORKSPACE', command: 'workspace-inspect'
      });
    }
    if (inspection.status === 'versioned' && inspection.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError('Health OS workspace schema is incompatible', {
        code: 'HEALTH_OS_WORKSPACE_SCHEMA_MISMATCH', command: 'workspace-inspect'
      });
    }
    if (inspection.status !== 'versioned' && inspection.schema_version !== null) {
      throw new HealthOsError('Health OS returned an invalid workspace schema marker', {
        code: 'HEALTH_OS_INVALID_WORKSPACE', command: 'workspace-inspect'
      });
    }
    return inspection;
  }

  async prepareTraining({ asOf, session, substitute } = {}) {
    const { capabilities } = await this.#ensureDiscovered();
    this.#assertRepositoryCompatibility();
    this.#assertWorkspaceLocation();
    const workspace = await this.#inspectWorkspaceAfterChecks(capabilities);
    if (workspace.status !== 'versioned' || workspace.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError(`Preparation requires an initialized, compatible workspace (status: ${workspace.status})`, {
        code: workspace.status === 'unversioned' ? 'HEALTH_OS_WORKSPACE_UNVERSIONED' : 'HEALTH_OS_WORKSPACE_UNINITIALIZED',
        command: 'prepare-training'
      });
    }
    if (typeof asOf !== 'string' || asOf.trim() === '') {
      throw new TypeError('prepareTraining requires an explicit `asOf` date or RFC3339 instant');
    }
    const args = ['--as-of', asOf.trim()];
    if (session !== undefined) {
      if (typeof session !== 'string' || session.trim() === '') throw new TypeError('session must be a non-empty string');
      args.push('--session', session.trim());
    }
    if (substitute !== undefined) {
      if (typeof substitute !== 'string' || substitute.trim() === '') throw new TypeError('substitute must be a non-empty string');
      args.push('--substitute', substitute.trim());
    }
    const envelope = await this.#runEnvelope('prepare-training', args, capabilities.cli_json_schema_version);
    return validateDomainResult(envelope.data, 'prepare-training');
  }

  async showProfile() {
    const { capabilities } = await this.#ensureDiscovered();
    this.#assertRepositoryCompatibility();
    this.#assertWorkspaceLocation();
    const workspace = await this.#inspectWorkspaceAfterChecks(capabilities);
    if (workspace.status !== 'versioned' || workspace.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError('Profile access requires an initialized compatible workspace.', {
        code: 'HEALTH_OS_WORKSPACE_UNINITIALIZED', command: 'profile-show'
      });
    }
    const envelope = await this.#runEnvelope('profile-show', ['--max-chars', String(HEALTH_OS_PROFILE_MAX_CHARS)],
      capabilities.cli_json_schema_version);
    const data = envelope.data;
    if (!isObject(data) || !validProfilePath(data.profile_path) ||
        data.profile_path !== workspace.profile_path || typeof data.markdown !== 'string' ||
        !isObject(data.metadata) || data.metadata.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION ||
        !(data.metadata.updated === null || validDay(data.metadata.updated)) ||
        !Number.isSafeInteger(data.total_chars) || data.total_chars < 0 ||
        !Number.isSafeInteger(data.returned_chars) || data.returned_chars !== [...data.markdown].length ||
        typeof data.truncated !== 'boolean' || data.returned_chars > HEALTH_OS_PROFILE_MAX_CHARS ||
        data.truncated !== (data.returned_chars < data.total_chars)) {
      throw new HealthOsError('Health OS returned invalid profile retrieval metadata.', { code: 'HEALTH_OS_INVALID_PROFILE' });
    }
    return {
      ...data,
      complete: data.truncated === false && data.returned_chars === data.total_chars,
      partial_reason: data.truncated ? 'native_profile_character_limit' : null
    };
  }

  async workoutHistory({ since, through } = {}) {
    if (!validDay(since) || !validDay(through) || since > through) {
      throw new HealthOsError('Workout history requires valid inclusive since and through dates.', {
        code: 'HEALTH_OS_ACTION_INPUT_INVALID'
      });
    }
    const data = await this.#readTimeline({ since, through, limit: HEALTH_OS_TIMELINE_LIMIT });
    const complete = workoutTimelineComplete(data) && data.matched_count <= HEALTH_OS_TIMELINE_LIMIT;
    return {
      ...data,
      complete,
      completeness: complete ? 'complete_for_requested_dates' : 'partial_or_native_limit_reached'
    };
  }

  async latestWorkout({ through } = {}) {
    const endDate = through;
    if (!validDay(endDate)) {
      throw new HealthOsError('Latest workout lookup requires an explicit valid through date.', { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
    }
    const { capabilities } = await this.#prepareActionWorkspace();
    const earliestDate = '0001-01-01';
    const initial = await this.#readTimeline({
      since: earliestDate, through: endDate, limit: HEALTH_OS_TIMELINE_LIMIT, capabilities
    });
    const initialComplete = workoutTimelineComplete(initial) &&
      initial.matched_count <= HEALTH_OS_TIMELINE_LIMIT;
    if (initial.matched_count === 0) {
      const verifyEmpty = await this.#readTimeline({
        since: earliestDate, through: endDate, limit: 1, capabilities
      });
      if (verifyEmpty.matched_count !== 0) {
        return { status: 'source_changed_during_query', latest: null, history_complete: false };
      }
      if (!workoutTimelineComplete(verifyEmpty)) {
        return { status: 'unknown_incomplete_source', latest: null, history_complete: false };
      }
      return { status: 'empty', latest: null, history_complete: true, consistency: 'count_guarded' };
    }
    if (initialComplete) {
      return this.#latestFromDayRows(initial.items, endDate, 'single_native_timeline_result');
    }

    const toDayNumber = (value) => Date.parse(value + 'T00:00:00.000Z') / 86_400_000;
    const fromDayNumber = (value) => new Date(value * 86_400_000).toISOString().slice(0, 10);
    let low = toDayNumber(earliestDate);
    let high = toDayNumber(endDate);
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      const probe = await this.#readTimeline({
        since: fromDayNumber(middle), through: endDate, limit: 1, capabilities
      });
      if (probe.omitted_legacy_rows > 0 || probe.source_issue_count > 0) {
        return { status: 'unknown_incomplete_source', latest: null, history_complete: false };
      }
      if (probe.matched_count > 0) low = middle;
      else high = middle - 1;
    }
    const latestDate = fromDayNumber(low);
    const dayResult = await this.#readTimeline({
      since: latestDate, through: latestDate, limit: HEALTH_OS_TIMELINE_LIMIT, capabilities
    });
    const verifyGlobal = await this.#readTimeline({
      since: earliestDate, through: endDate, limit: 1, capabilities
    });
    const verifyUpperWindow = await this.#readTimeline({
      since: latestDate, through: endDate, limit: 1, capabilities
    });
    const verifyDay = await this.#readTimeline({
      since: latestDate, through: latestDate, limit: HEALTH_OS_TIMELINE_LIMIT, capabilities
    });
    if (verifyGlobal.matched_count !== initial.matched_count ||
        verifyUpperWindow.matched_count !== dayResult.matched_count ||
        verifyDay.matched_count !== dayResult.matched_count ||
        JSON.stringify(verifyDay.items) !== JSON.stringify(dayResult.items)) {
      return {
        status: 'source_changed_during_query',
        latest_date: latestDate,
        latest: null,
        history_complete: false
      };
    }
    if (dayResult.omitted_legacy_rows > 0 || dayResult.source_issue_count > 0 ||
        verifyGlobal.omitted_legacy_rows > 0 || verifyGlobal.source_issue_count > 0 ||
        verifyUpperWindow.omitted_legacy_rows > 0 || verifyUpperWindow.source_issue_count > 0 ||
        verifyDay.omitted_legacy_rows > 0 || verifyDay.source_issue_count > 0) {
      return { status: 'unknown_incomplete_source', latest: null, history_complete: false };
    }
    const complete = workoutTimelineComplete(dayResult) &&
      dayResult.matched_count <= HEALTH_OS_TIMELINE_LIMIT;
    if (!complete || dayResult.items.length === 0) {
      return {
        status: 'unknown_incomplete_latest_day',
        latest_date: latestDate,
        latest: null,
        history_complete: false,
        matched_on_latest_date: dayResult.matched_count
      };
    }
    return this.#latestFromDayRows(dayResult.items, latestDate, 'count_guarded_nontransactional_queries');
  }

  #latestFromDayRows(items, date, consistency) {
    if (items.length === 0) {
      return { status: 'empty', latest: null, history_complete: true, consistency };
    }
    const latestDate = items[items.length - 1].occurred.start;
    if (items.some((item) => item.occurred.start > latestDate) || latestDate > date) {
      throw new HealthOsError('Health OS returned workout rows out of chronological order.', { code: 'HEALTH_OS_INVALID_HISTORY' });
    }
    const sameDay = items.filter((item) => item.occurred.start === latestDate);
    if (sameDay.length !== 1) {
      return {
        status: 'ambiguous_same_day_order',
        latest_date: latestDate,
        latest: null,
        same_day_workouts: sameDay,
        history_complete: true,
        consistency,
        chronology_note: 'Native workout dates have day precision; order within a day is not known.'
      };
    }
    return {
      status: 'available',
      latest_date: latestDate,
      latest: sameDay[0],
      history_complete: true,
      consistency
    };
  }

  async logWorkout({ payload, date, idempotencyKey } = {}) {
    if (this.#config.healthActionMode !== 'confirmed-writes') {
      throw new HealthOsError('Health writes are disabled by the operator action mode.', {
        code: 'HEALTH_OS_ACTION_WRITES_DISABLED'
      });
    }
    requireIdempotencyKey(idempotencyKey);
    if (!validDay(date)) {
      throw new HealthOsError('Workout logging requires an explicit valid date.', { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
    }
    validateWorkoutPayload(payload);
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 64 * 1024) {
      throw new HealthOsError('Workout payload exceeds the supported input size.', { code: 'HEALTH_OS_ACTION_INPUT_INVALID' });
    }
    const { capabilities } = await this.#prepareActionWorkspace();
    if (!capabilities.contracts.json_stdin_commands.includes('log-workout') ||
        !capabilities.contracts.idempotency_commands.includes('log-workout')) {
      throw new HealthOsError('Health OS does not advertise safe idempotent workout logging.', {
        code: 'HEALTH_OS_CAPABILITIES_INCOMPATIBLE'
      });
    }
    let envelope;
    try {
      envelope = await this.#runEnvelope('log-workout', [
        '--input-json', '--date', date, '--idempotency-key', idempotencyKey
      ], capabilities.cli_json_schema_version, JSON.stringify(payload));
    } catch (error) {
      throw new HealthOsError('Workout write outcome is unknown. Do not create a new key; inspect the workspace and retry only with this same key after review.', {
        code: 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN', command: 'log-workout', cause: error
      });
    }
    if (!isObject(envelope.data) || !nonEmptyString(envelope.data.session_id) ||
        envelope.data.date !== date || !['completed', 'replayed'].includes(envelope.idempotency?.status)) {
      throw new HealthOsError('Workout write outcome is unknown. Do not create a new key; inspect the workspace and retry only with this same key after review.', {
        code: 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN', command: 'log-workout'
      });
    }
    return { ...envelope.data, idempotency_status: envelope.idempotency.status, idempotency_key: idempotencyKey };
  }

  async setWorkingWeight({ exercise, weight, increment, idempotencyKey } = {}) {
    if (this.#config.healthActionMode !== 'confirmed-writes') {
      throw new HealthOsError('Health writes are disabled by the operator action mode.', {
        code: 'HEALTH_OS_ACTION_WRITES_DISABLED'
      });
    }
    requireIdempotencyKey(idempotencyKey);
    if (typeof exercise !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(exercise) ||
        typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 ||
        (increment !== undefined && (typeof increment !== 'number' || !Number.isFinite(increment) || increment < 0))) {
      throw new HealthOsError('Working weight requires a valid exercise key and finite weight values.', {
        code: 'HEALTH_OS_ACTION_INPUT_INVALID'
      });
    }
    const { capabilities } = await this.#prepareActionWorkspace();
    if (!capabilities.contracts.idempotency_commands.includes('set-working-weight')) {
      throw new HealthOsError('Health OS does not advertise idempotent working-weight updates.', {
        code: 'HEALTH_OS_CAPABILITIES_INCOMPATIBLE'
      });
    }
    const args = ['--exercise', exercise, '--weight', String(weight), '--idempotency-key', idempotencyKey];
    if (increment !== undefined) args.push('--increment', String(increment));
    let envelope;
    try {
      envelope = await this.#runEnvelope('set-working-weight', args, capabilities.cli_json_schema_version);
    } catch (error) {
      throw new HealthOsError('Working-weight write outcome is unknown. Do not create a new key; inspect the workspace and retry only with this same key after review.', {
        code: 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN', command: 'set-working-weight', cause: error
      });
    }
    if (!isObject(envelope.data) || envelope.data.exercise !== exercise || envelope.data.weight_kg !== weight ||
        envelope.data.increment_kg !== (increment ?? null) ||
        !['completed', 'replayed'].includes(envelope.idempotency?.status)) {
      throw new HealthOsError('Working-weight write outcome is unknown. Do not create a new key; inspect the workspace and retry only with this same key after review.', {
        code: 'HEALTH_OS_WRITE_OUTCOME_UNKNOWN', command: 'set-working-weight'
      });
    }
    return { ...envelope.data, idempotency_status: envelope.idempotency.status, idempotency_key: idempotencyKey };
  }

  async #prepareActionWorkspace() {
    const { capabilities } = await this.#ensureDiscovered();
    this.#assertRepositoryCompatibility();
    this.#assertWorkspaceLocation();
    const workspace = await this.#inspectWorkspaceAfterChecks(capabilities);
    if (workspace.status !== 'versioned' || workspace.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError('Health action requires an initialized compatible workspace.', {
        code: 'HEALTH_OS_WORKSPACE_UNINITIALIZED'
      });
    }
    return { capabilities, workspace };
  }

  async #readTimeline({ since, through, limit, capabilities: knownCapabilities }) {
    const capabilities = knownCapabilities || (await this.#prepareActionWorkspace()).capabilities;
    if (!capabilities.contracts.read_only_event_commands.includes('timeline')) {
      throw new HealthOsError('Health OS does not advertise read-only timeline queries.', {
        code: 'HEALTH_OS_CAPABILITIES_INCOMPATIBLE'
      });
    }
    const args = ['--source', 'legacy.workout_session', '--limit', String(limit)];
    if (since !== undefined) args.push('--since', since);
    if (through !== undefined) args.push('--through', through);
    const envelope = await this.#runEnvelope('timeline', args, capabilities.cli_json_schema_version);
    return validateTimelineResult(envelope.data);
  }

  async initWorkspace() {
    const { capabilities } = await this.#ensureDiscovered();
    this.#assertRepositoryCompatibility();
    this.#assertWorkspaceLocation();
    const workspace = await this.#inspectWorkspaceAfterChecks(capabilities);
    if (workspace.status !== 'uninitialized') {
      throw new HealthOsError(`Refusing to initialize a workspace with status ${workspace.status}`, {
        code: 'HEALTH_OS_INIT_REFUSED', command: 'init-workspace'
      });
    }
    this.#assertWorkspacePathMissingOrEmpty();
    const envelope = await this.#runEnvelope('init-workspace', [], capabilities.cli_json_schema_version);
    const initialized = envelope.data;
    if (!initialized || initialized.status !== 'initialized' || initialized.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError('Health OS did not return a valid initialized-workspace result', {
        code: 'HEALTH_OS_INVALID_WORKSPACE', command: 'init-workspace'
      });
    }
    return initialized;
  }

  async #ensureDiscovered() {
    if (!this.#discovery) return this.discover();
    this.#assertRepositoryCompatibility();
    return this.#discovery;
  }

  #assertRepositoryCompatibility() {
    let repoReal;
    try {
      repoReal = fs.realpathSync(this.#repo);
    } catch (error) {
      throw new HealthOsError('Health OS repository path does not exist or cannot be read', {
        code: 'HEALTH_OS_REPOSITORY_INVALID', cause: error
      });
    }
    if (!fs.existsSync(this.#cliPath)) {
      throw new HealthOsError('Health OS CLI was not found at <repo>/src/cli.js', { code: 'HEALTH_OS_REPOSITORY_INVALID' });
    }
    const topLevel = gitOutput(repoReal, ['rev-parse', '--show-toplevel']);
    if (path.resolve(topLevel) !== repoReal) {
      throw new HealthOsError('HEALTH_OS_REPO must point to the Health OS Git root', { code: 'HEALTH_OS_REPOSITORY_INVALID' });
    }
    const head = gitOutput(repoReal, ['rev-parse', 'HEAD']);
    if (head !== this.#config.expectedRevision) {
      throw new HealthOsError('Health OS checkout does not match the pinned compatible revision', {
        code: 'HEALTH_OS_REVISION_MISMATCH'
      });
    }
    const dirtyRuntime = gitOutput(repoReal, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...DIRTY_RUNTIME_PATHS]);
    if (dirtyRuntime !== '') {
      throw new HealthOsError('Health OS runtime code or seed configuration has local changes', {
        code: 'HEALTH_OS_DIRTY_ENGINE'
      });
    }
  }

  #assertWorkspaceLocation() {
    const workspace = canonicalMaybeMissing(this.#config.workspace);
    const somaRoot = fs.realpathSync(this.#config.somaRoot);
    const healthRoot = fs.realpathSync(this.#repo);
    if (isInside(workspace, somaRoot) || isInside(workspace, healthRoot)) {
      throw new HealthOsError('Health OS workspace must be outside the SOMA and Health OS repositories', {
        code: 'HEALTH_OS_WORKSPACE_PATH_UNSAFE'
      });
    }
  }

  #assertWorkspacePathMissingOrEmpty() {
    try {
      const stat = fs.statSync(this.#config.workspace);
      if (!stat.isDirectory()) {
        throw new HealthOsError('Workspace initialization requires a missing or empty directory', {
          code: 'HEALTH_OS_INIT_REFUSED', command: 'init-workspace'
        });
      }
      if (fs.readdirSync(this.#config.workspace).length > 0) {
        throw new HealthOsError('Workspace initialization refuses to write into a populated directory', {
          code: 'HEALTH_OS_INIT_REFUSED', command: 'init-workspace'
        });
      }
    } catch (error) {
      if (error instanceof HealthOsError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new HealthOsError('Could not verify that the workspace is empty', {
          code: 'HEALTH_OS_INIT_REFUSED', command: 'init-workspace', cause: error
        });
      }
    }
  }

  async #inspectWorkspaceAfterChecks(capabilities) {
    const envelope = await this.#runEnvelope('workspace-inspect', [], capabilities.cli_json_schema_version);
    const inspection = envelope.data;
    const knownStatuses = new Set(['uninitialized', 'unversioned', 'versioned']);
    if (!inspection || typeof inspection !== 'object' || !knownStatuses.has(inspection.status)) {
      throw new HealthOsError('Health OS returned an unsupported workspace inspection result', {
        code: 'HEALTH_OS_INVALID_WORKSPACE', command: 'workspace-inspect'
      });
    }
    if (inspection.status === 'versioned' && inspection.schema_version !== HEALTH_OS_WORKSPACE_SCHEMA_VERSION) {
      throw new HealthOsError('Health OS workspace schema is incompatible', {
        code: 'HEALTH_OS_WORKSPACE_SCHEMA_MISMATCH', command: 'workspace-inspect'
      });
    }
    if (inspection.status !== 'versioned' && inspection.schema_version !== null) {
      throw new HealthOsError('Health OS returned an invalid workspace schema marker', {
        code: 'HEALTH_OS_INVALID_WORKSPACE', command: 'workspace-inspect'
      });
    }
    return inspection;
  }

  #validateCapabilities(capabilities) {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
        capabilities.name !== 'health-os' || capabilities.version !== HEALTH_OS_PACKAGE_VERSION ||
        capabilities.cli_json_schema_version !== HEALTH_OS_CLI_SCHEMA_VERSION ||
        !Array.isArray(capabilities.workspace_schema_versions) ||
        !capabilities.workspace_schema_versions.includes(HEALTH_OS_WORKSPACE_SCHEMA_VERSION) ||
        !Array.isArray(capabilities.commands) || REQUIRED_COMMANDS.some((command) => !capabilities.commands.includes(command)) ||
        !capabilities.contracts || !Array.isArray(capabilities.contracts.json_envelope_commands) ||
        REQUIRED_COMMANDS.some((command) => !capabilities.contracts.json_envelope_commands.includes(command)) ||
        !Array.isArray(capabilities.contracts.json_stdin_commands) ||
        !capabilities.contracts.json_stdin_commands.includes('log-workout') ||
        !Array.isArray(capabilities.contracts.idempotency_commands) ||
        !['log-workout', 'set-working-weight'].every((command) => capabilities.contracts.idempotency_commands.includes(command)) ||
        !Array.isArray(capabilities.contracts.read_only_event_commands) ||
        !capabilities.contracts.read_only_event_commands.includes('timeline') ||
        !Array.isArray(capabilities.contracts.read_only_preparation_commands) ||
        !capabilities.contracts.read_only_preparation_commands.includes('prepare-training') ||
        !Array.isArray(capabilities.contracts.workspace_read_lock_commands) ||
        !capabilities.contracts.workspace_read_lock_commands.includes('prepare-training') ||
        capabilities.limits?.json_output_bytes !== HEALTH_OS_MAX_JSON_OUTPUT_BYTES) {
      throw new HealthOsError('Health OS capabilities do not advertise the required SOMA integration contract', {
        code: 'HEALTH_OS_CAPABILITIES_INCOMPATIBLE', command: 'capabilities'
      });
    }
  }

  async #runEnvelope(command, args, expectedSchemaVersion = HEALTH_OS_CLI_SCHEMA_VERSION, stdinInput) {
    const { status, stdout } = await this.#spawn(command, args, stdinInput);
    return parseHealthOsEnvelope({ command, status, stdout, expectedSchemaVersion });
  }

  #spawn(command, args, stdinInput) {
    return new Promise((resolve, reject) => {
      const argv = [this.#cliPath, command, ...args, '--workspace', this.#config.workspace, '--json'];
      let child;
      try {
        child = spawn(process.execPath, argv, {
          cwd: this.#repo,
          env: minimalEnvironment(),
          stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (error) {
        reject(new HealthOsError(`Could not start Health OS ${command}`, {
          code: 'HEALTH_OS_SPAWN_FAILED', command, cause: error
        }));
        return;
      }

      let terminalError;
      if (stdinInput !== undefined) {
        child.stdin.on('error', (error) => {
          if (!terminalError) {
            terminalError = new HealthOsError('Health OS did not accept the complete workout input stream.', {
              code: 'HEALTH_OS_STDIN_FAILED', command, cause: error
            });
          }
        });
      }

      const stdout = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let killTimer;
      const timeoutTimer = setTimeout(() => {
        terminalError = new HealthOsError(`Health OS ${command} timed out`, {
          code: 'HEALTH_OS_TIMEOUT', command
        });
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      }, this.#config.timeoutMs);

      const stopForLimit = (code, message) => {
        if (terminalError) return;
        terminalError = new HealthOsError(message, { code, command });
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      };

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.#config.maxOutputBytes) {
          stopForLimit('HEALTH_OS_OUTPUT_LIMIT', `Health OS ${command} exceeded the output limit`);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) stopForLimit('HEALTH_OS_STDERR_LIMIT', `Health OS ${command} exceeded the diagnostic output limit`);
      });
      child.on('error', (error) => {
        terminalError = new HealthOsError(`Could not start Health OS ${command}`, {
          code: 'HEALTH_OS_SPAWN_FAILED', command, cause: error
        });
      });
      if (stdinInput !== undefined) {
        try {
          child.stdin.end(stdinInput);
        } catch (error) {
          terminalError = new HealthOsError('Health OS did not accept the complete workout input stream.', {
            code: 'HEALTH_OS_STDIN_FAILED', command, cause: error
          });
          child.kill('SIGTERM');
        }
      }

      child.on('close', (status) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (terminalError) {
          reject(terminalError);
          return;
        }
        resolve({ status, stdout: Buffer.concat(stdout).toString('utf8') });
      });
    });
  }
}
