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
const REQUIRED_COMMANDS = ['version', 'capabilities', 'workspace-inspect', 'init-workspace', 'prepare-training'];
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

  async #runEnvelope(command, args, expectedSchemaVersion = HEALTH_OS_CLI_SCHEMA_VERSION) {
    const { status, stdout } = await this.#spawn(command, args);
    return parseHealthOsEnvelope({ command, status, stdout, expectedSchemaVersion });
  }

  #spawn(command, args) {
    return new Promise((resolve, reject) => {
      const argv = [this.#cliPath, command, ...args, '--workspace', this.#config.workspace, '--json'];
      let child;
      try {
        child = spawn(process.execPath, argv, {
          cwd: this.#repo,
          env: minimalEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (error) {
        reject(new HealthOsError(`Could not start Health OS ${command}`, {
          code: 'HEALTH_OS_SPAWN_FAILED', command, cause: error
        }));
        return;
      }

      const stdout = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError;
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
