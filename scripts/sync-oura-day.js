#!/usr/bin/env node
/** Operator-only, single-day sync. Credentials are loaded only by the native child. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../src/config.js';
import { HealthOsClient, parseHealthOsEnvelope } from '../src/health-os-client.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function localDay(timezone, now = new Date()) {
  if (typeof timezone !== 'string' || !timezone.trim()) fail('SOMA_SYNC_TIMEZONE_REQUIRED');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  } catch {
    fail('SOMA_SYNC_TIMEZONE_INVALID');
  }
}

export function credentialFile(filename, excludedRoots) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('SOMA_SYNC_ENV_FILE_INVALID');
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved ||
      typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    fail('SOMA_SYNC_ENV_FILE_INVALID');
  }
  for (const root of excludedRoots) {
    const relative = path.relative(fs.realpathSync(root), resolved);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      fail('SOMA_SYNC_ENV_FILE_LOCATION_INVALID');
    }
  }
  return resolved;
}

/** A verified provider write is distinct from a training/readiness decision. */
export function syncAndVerify({ date, requestId, invoke }) {
  const key = `oura:${date}:${requestId}`;
  let envelope;
  try {
    envelope = invoke('oura-sync-from-token', ['--date', date, '--idempotency-key', key], true);
  } catch {
    fail('SOMA_SYNC_OUTCOME_UNKNOWN');
  }
  const data = envelope.data;
  const observation = data?.observation_set;
  if (!['completed', 'replayed'].includes(envelope.idempotency?.status) ||
      data?.connector !== 'oura' || data?.date !== date || observation?.source?.id !== 'oura' ||
      observation?.date !== date || !Array.isArray(observation.physical_metrics) ||
      !Array.isArray(observation.proprietary_scores)) fail('SOMA_SYNC_OUTCOME_UNKNOWN');
  let saved;
  try {
    saved = invoke('wearable-observations', ['--source', 'oura', '--date', date], false).data;
  } catch {
    fail('SOMA_SYNC_READBACK_UNVERIFIED');
  }
  if (saved?.truncated !== false || saved?.matched_count !== 1 ||
      !isDeepStrictEqual(saved.observations, [observation])) fail('SOMA_SYNC_READBACK_UNVERIFIED');
  const samples = [...observation.physical_metrics, ...observation.proprietary_scores];
  if (!samples.some((sample) => sample.status === 'observed' && Number.isFinite(sample.value))) {
    fail('SOMA_SYNC_NO_OBSERVATIONS');
  }
  return { date, source: 'oura', status: 'verified', idempotency_status: envelope.idempotency.status };
}

export async function runSync(argv, env = process.env) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--date', '--env-file', '--request-id'].includes(name) || options[name] !== undefined ||
        !argv[index + 1] || argv[index + 1].startsWith('--')) fail('SOMA_SYNC_USAGE');
    options[name] = argv[index + 1];
  }
  if (env.SOMA_HEALTH_ACTION_MODE !== 'confirmed-writes') fail('SOMA_SYNC_WRITES_DISABLED');
  const today = localDay(env.TZ);
  const date = options['--date'] ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > today) fail('SOMA_SYNC_DATE_INVALID');
  const requestId = options['--request-id'] ?? 'soma-daily-sync';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(requestId)) fail('SOMA_SYNC_REQUEST_ID_INVALID');
  const config = loadConfig({}, env);
  const client = new HealthOsClient(config);
  const { capabilities, workspace } = await client.doctor();
  if (workspace.status !== 'versioned' || workspace.schema_version !== 1) fail('SOMA_SYNC_WORKSPACE_UNINITIALIZED');
  for (const command of ['oura-sync-from-token', 'wearable-observations']) {
    if (!capabilities.commands.includes(command) ||
        !capabilities.contracts.json_envelope_commands.includes(command)) fail('SOMA_SYNC_CAPABILITIES_INVALID');
  }
  if (!capabilities.contracts.idempotency_commands.includes('oura-sync-from-token')) fail('SOMA_SYNC_CAPABILITIES_INVALID');
  const filename = credentialFile(options['--env-file'] ?? env.SOMA_HEALTH_ENV_FILE,
    [config.repo, config.workspace, config.somaRoot]);
  const childEnv = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: env.TZ,
    HEALTH_OS_REPO: config.repo, HEALTH_OS_WORKSPACE: config.workspace
  };
  // Inspect credential values only inside the same isolated child that loads them.
  // No values or token contents are returned to this process or to logs.
  const check = spawnSync(process.execPath, [`--env-file=${filename}`, '--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import { parseEnv } from 'node:util';
    const allowed = ['HEALTH_OS_REPO', 'HEALTH_OS_WORKSPACE', 'OURA_CLIENT_ID',
      'OURA_CLIENT_SECRET', 'OURA_REDIRECT_URI', 'OURA_TOKEN_FILE'];
    const mapping = parseEnv(fs.readFileSync(process.argv[1], 'utf8'));
    if (Object.keys(mapping).length !== allowed.length ||
        !allowed.every(key => typeof mapping[key] === 'string' && mapping[key].trim())) process.exit(1);
    const filename = process.env.OURA_TOKEN_FILE;
    if (!filename || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) process.exit(1);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) process.exit(1);
    for (const root of process.argv.slice(2)) {
      const relative = path.relative(fs.realpathSync(root), filename);
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) process.exit(1);
    }
  `, filename, config.repo, config.workspace, config.somaRoot], {
    env: childEnv, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024
  });
  if (check.error || check.status !== 0) fail('SOMA_SYNC_CREDENTIAL_METADATA_INVALID');
  const invoke = (command, args, credentials) => {
    const result = spawnSync(process.execPath, [
      ...(credentials ? [`--env-file=${filename}`] : []), path.join(config.repo, 'src/cli.js'),
      command, '--workspace', config.workspace, '--json', ...args
    ], { env: childEnv, encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024 });
    if (result.error || result.signal) fail('SOMA_SYNC_SUBPROCESS_FAILED');
    return parseHealthOsEnvelope({ command, status: result.status, stdout: result.stdout });
  };
  return syncAndVerify({ date, requestId, invoke });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: sync-oura-day.js [--date YYYY-MM-DD] [--env-file ABSOLUTE_PATH] [--request-id STABLE_ID]\nRequires explicit Health OS paths, TZ, a private credential env file, and operator confirmed-writes.\n');
  } else {
    try {
      const data = await runSync(process.argv.slice(2));
      process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'sync-oura-day', ok: true, data })}\n`);
    } catch (error) {
      const code = /^SOMA_SYNC_[A-Z_]+$/.test(error?.code || '') ? error.code : 'SOMA_SYNC_PREFLIGHT_FAILED';
      process.stderr.write(`${JSON.stringify({ schema_version: 1, command: 'sync-oura-day', ok: false, error: { code } })}\n`);
      process.exitCode = 1;
    }
  }
}
