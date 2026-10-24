#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { HealthOsClient } from './health-os-client.js';
import {
  presentDoctor,
  presentPreparation,
  renderDoctor,
  renderPreparation
} from './presenter.js';

const COMMANDS = new Set(['doctor', 'init', 'prepare-training']);
const VALUE_FLAGS = new Set(['--workspace', '--health-os-repo', '--as-of']);
const SAFE_ERROR_MESSAGES = Object.freeze({
  HEALTH_OS_WORKSPACE_REQUIRED: 'Set HEALTH_OS_WORKSPACE or pass --workspace PATH.',
  HEALTH_OS_REPOSITORY_INVALID: 'Set --health-os-repo to the root of the Health OS checkout.',
  HEALTH_OS_REVISION_MISMATCH: 'Health OS checkout does not match the pinned compatible revision.',
  HEALTH_OS_DIRTY_ENGINE: 'Health OS runtime files have local changes; the pinned runtime cannot be used as-is.',
  HEALTH_OS_CAPABILITIES_INCOMPATIBLE: 'Health OS does not advertise the required SOMA integration contract.',
  HEALTH_OS_VERSION_MISMATCH: 'Health OS package version is not compatible with this SOMA build.',
  HEALTH_OS_NODE_VERSION_UNSUPPORTED: 'Use Node.js 22.13.0 or newer.',
  HEALTH_OS_WORKSPACE_PATH_INVALID: 'The workspace path cannot be safely resolved.',
  HEALTH_OS_WORKSPACE_PATH_UNSAFE: 'Choose a workspace outside both the SOMA and Health OS repositories.',
  HEALTH_OS_WORKSPACE_SCHEMA_MISMATCH: 'The workspace uses an unsupported Health OS schema.',
  HEALTH_OS_WORKSPACE_INVALID: 'The workspace or selected profile is invalid; inspect it before using SOMA.',
  HEALTH_OS_WORKSPACE_UNINITIALIZED: 'The workspace is not initialized. Run `init` before preparing training.',
  HEALTH_OS_WORKSPACE_UNVERSIONED: 'The workspace is unversioned. Choose a new empty workspace for SOMA.',
  HEALTH_OS_INIT_REFUSED: 'Init only works when the selected workspace is absent or empty.',
  HEALTH_OS_PREPARATION_POLICY_MISSING: 'The preparation policy is missing. Initialize or restore the workspace configuration.',
  HEALTH_OS_PREPARATION_POLICY_INVALID: 'The preparation policy is invalid. Check the workspace configuration before retrying.',
  HEALTH_OS_PREPARATION_INVALID: 'Health OS could not prepare the workspace. Check its required training configuration.',
  HEALTH_OS_PREPARATION_OUTPUT_LIMIT: 'Health OS exceeded the structured preparation limit; SOMA refused a partial result.',
  HEALTH_OS_TIMEOUT: 'Health OS did not finish before the configured timeout.',
  HEALTH_OS_OUTPUT_LIMIT: 'Health OS exceeded the configured response limit.',
  HEALTH_OS_STDERR_LIMIT: 'Health OS exceeded the configured diagnostic output limit.',
  HEALTH_OS_OUTPUT_TRUNCATED: 'Health OS returned truncated output; SOMA refused to use the partial result.',
  HEALTH_OS_SCHEMA_MISMATCH: 'Health OS returned an unsupported response schema.',
  HEALTH_OS_INVALID_ENVELOPE: 'Health OS returned an invalid response envelope.',
  HEALTH_OS_INVALID_JSON: 'Health OS did not return one valid JSON response.',
  HEALTH_OS_INVALID_DOMAIN: 'Health OS returned an unsupported training preparation result.',
  HEALTH_OS_INVALID_WORKSPACE: 'Health OS returned an unsupported workspace status.',
  HEALTH_OS_SPAWN_FAILED: 'SOMA could not start the Health OS CLI.',
  HEALTH_OS_COMMAND_FAILED: 'Health OS reported that the command failed.'
});
const INIT_MAY_HAVE_COMPLETED = new Set([
  'HEALTH_OS_TIMEOUT', 'HEALTH_OS_OUTPUT_LIMIT', 'HEALTH_OS_STDERR_LIMIT',
  'HEALTH_OS_OUTPUT_TRUNCATED', 'HEALTH_OS_INVALID_ENVELOPE', 'HEALTH_OS_INVALID_JSON',
  'HEALTH_OS_INVALID_WORKSPACE', 'HEALTH_OS_COMMAND_FAILED', 'HEALTH_OS_SPAWN_FAILED'
]);

export const HELP_TEXT = `Usage: node src/cli.js <command> [options]

Commands:
  doctor             Check Health OS compatibility and workspace status
  init               Initialize a new empty Health OS workspace
  prepare-training   Prepare the scheduled training plan for an exact time

Options:
  --health-os-repo PATH  Health OS checkout (or HEALTH_OS_REPO)
  --workspace PATH      Health OS workspace (or HEALTH_OS_WORKSPACE)
  --as-of RFC3339       Exact cutoff; omitted cutoff means the current instant
  --json                Emit a small schema-versioned JSON response
  --help                Show this help
`;

class CliError extends Error {
  constructor(message, code = 'SOMA_USAGE', exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const command = argv[0];
  if (argv.length === 0 || command === '--help' || command === '-h') return { help: true, command: null };
  if (!COMMANDS.has(command)) throw new CliError('Choose doctor, init, or prepare-training.');

  const options = { command, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true, command };
    if (flag === '--json') {
      if (options.json) throw new CliError('Use --json only once.');
      options.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new CliError('An unsupported command option was supplied.');
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new CliError(`${flag} requires a value.`);
    }
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new CliError(`${flag} may be supplied only once.`);
    options[key] = value;
    index += 1;
  }

  if (options['as-of'] !== undefined && command !== 'prepare-training') {
    throw new CliError('--as-of is available only with prepare-training.');
  }
  return { help: false, ...options };
}

function isValidRfc3339Instant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] = match;
  if (Number(year) < 1) return false;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(offsetHour) > 14 || Number(offsetMinute) > 59 ||
      (Number(offsetHour) === 14 && Number(offsetMinute) !== 0))) return false;
  return Number.isFinite(Date.parse(value));
}

function currentInstant(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new CliError('The current time could not be read.', 'SOMA_CLOCK_ERROR', 1);
  return date.toISOString();
}

function safeFailure(error, command) {
  if (error instanceof CliError) return { code: error.code, message: error.message, exitCode: error.exitCode };
  if (error?.code === 'SOMA_INVALID_AS_OF') {
    return { code: error.code, message: 'Use a full RFC3339 timestamp with a timezone, such as 2026-10-24T10:30:00Z.', exitCode: 2 };
  }
  const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'SOMA_OPERATION_FAILED';
  const message = command === 'init' && INIT_MAY_HAVE_COMPLETED.has(code)
    ? 'Init may have completed but SOMA could not verify the result. Run doctor to inspect the workspace before trying init again.'
    : SAFE_ERROR_MESSAGES[code] || 'Health OS operation failed. Check the configured repository, workspace, and compatibility.';
  return {
    code,
    message,
    exitCode: Number.isInteger(error?.exitCode) && error.exitCode !== 0 ? error.exitCode : 1
  };
}

function writeResponse(command, json, data, human, stdout) {
  if (json) {
    stdout.write(`${JSON.stringify({ schema_version: 1, command, ok: true, data })}\n`);
  } else {
    stdout.write(human);
  }
}

function writeFailure(command, json, error, stdout, stderr) {
  const safe = safeFailure(error, command);
  if (json) {
    stdout.write(`${JSON.stringify({
      schema_version: 1,
      command: command || 'cli',
      ok: false,
      error: { code: safe.code, message: safe.message }
    })}\n`);
  } else {
    stderr.write(`SOMA [${safe.code}]: ${safe.message}\n`);
  }
  return safe.exitCode;
}

/** Run one CLI request. Dependencies are injectable for deterministic behavioral tests. */
export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const env = dependencies.env || process.env;
  let command = null;
  let json = argv.includes('--json');
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    json = parsed.json === true;
    if (parsed.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }

    if (command === 'prepare-training' && parsed['as-of'] !== undefined && !isValidRfc3339Instant(parsed['as-of'])) {
      throw new CliError('Use a full RFC3339 timestamp with a timezone; date-only values are not exact cutoffs.', 'SOMA_INVALID_AS_OF', 2);
    }
    const asOf = command === 'prepare-training'
      ? parsed['as-of'] || currentInstant(dependencies.now || (() => new Date()))
      : undefined;
    let config = dependencies.config;
    if (!config && !dependencies.client) {
      const repo = parsed['health-os-repo'] || env.HEALTH_OS_REPO;
      const workspace = parsed.workspace || env.HEALTH_OS_WORKSPACE;
      if (!repo) throw new CliError('Set HEALTH_OS_REPO or pass --health-os-repo PATH.', 'SOMA_CONFIG_REQUIRED', 2);
      if (!workspace) throw new CliError('Set HEALTH_OS_WORKSPACE or pass --workspace PATH.', 'SOMA_CONFIG_REQUIRED', 2);
      config = (dependencies.loadConfig || loadConfig)({ healthOsRepo: repo, workspace });
    }
    const client = dependencies.client || (dependencies.createClient || ((value) => new HealthOsClient(value)))(config);

    if (command === 'doctor') {
      const data = presentDoctor(await client.doctor());
      writeResponse(command, json, data, renderDoctor(data), stdout);
      return 0;
    }
    if (command === 'init') {
      await client.initWorkspace();
      const data = { initialized: true, profile: 'neutral starter profile' };
      writeResponse(command, json, data, 'Initialized a new Health OS workspace with the neutral starter profile.\n', stdout);
      return 0;
    }
    if (command === 'prepare-training') {
      const data = presentPreparation(await client.prepareTraining({ asOf }));
      writeResponse(command, json, data, renderPreparation(data), stdout);
      return 0;
    }
    throw new CliError('Choose doctor, init, or prepare-training.');
  } catch (error) {
    return writeFailure(command, json, error, stdout, stderr);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = await runCli(process.argv.slice(2));
}
