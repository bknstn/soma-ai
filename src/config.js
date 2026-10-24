import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALTH_OS_EXPECTED_REVISION = '363204694ea805256595bf30c72d25c9361595d1';
export const HEALTH_OS_PACKAGE_VERSION = '0.1.0';
export const HEALTH_OS_CLI_SCHEMA_VERSION = 1;
export const HEALTH_OS_WORKSPACE_SCHEMA_VERSION = 1;
export const HEALTH_OS_PREPARATION_SCHEMA_VERSION = 1;
export const HEALTH_OS_MAX_JSON_OUTPUT_BYTES = 256 * 1024;

const somaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function absolutePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be an absolute path`);
  }
  const candidate = value.trim();
  if (!path.isAbsolute(candidate)) throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(candidate);
}
/**
 * Resolve adapter paths without changing process.env. The repository defaults
 * to the conventional sibling checkout; the workspace is deliberately never
 * guessed because it contains private health data.
 */
export function loadConfig(overrides = {}, env = process.env) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Config overrides must be an object');
  }
  const selectedRepo = overrides.repo ?? overrides.healthOsRepo ?? env.HEALTH_OS_REPO ?? path.resolve(somaRoot, '..', 'health-os');
  const selectedWorkspace = overrides.workspace ?? env.HEALTH_OS_WORKSPACE;
  const repo = absolutePath(selectedRepo, 'Health OS repository path');
  const workspace = selectedWorkspace === undefined || selectedWorkspace === null || selectedWorkspace === ''
    ? null
    : absolutePath(selectedWorkspace, 'Health OS workspace path');

  const timeoutMs = overrides.timeoutMs ?? Number(env.HEALTH_OS_TIMEOUT_MS || 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new TypeError('Health OS timeout must be an integer from 1 to 600000 milliseconds');
  }
  const maxOutputBytes = overrides.maxOutputBytes ?? Number(env.HEALTH_OS_MAX_OUTPUT_BYTES || HEALTH_OS_MAX_JSON_OUTPUT_BYTES);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > HEALTH_OS_MAX_JSON_OUTPUT_BYTES) {
    throw new TypeError(`Health OS output limit must be an integer from 1024 to ${HEALTH_OS_MAX_JSON_OUTPUT_BYTES} bytes`);
  }

  return Object.freeze({
    repo,
    workspace,
    timeoutMs,
    maxOutputBytes,
    expectedRevision: HEALTH_OS_EXPECTED_REVISION,
    expectedPackageVersion: HEALTH_OS_PACKAGE_VERSION,
    cliSchemaVersion: HEALTH_OS_CLI_SCHEMA_VERSION,
    workspaceSchemaVersion: HEALTH_OS_WORKSPACE_SCHEMA_VERSION,
    preparationSchemaVersion: HEALTH_OS_PREPARATION_SCHEMA_VERSION,
    somaRoot
  });
}
