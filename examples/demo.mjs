#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'src', 'cli.js');

function minimalEnvironment(workspace) {
  const env = {
    PATH: process.env.PATH || '',
    TZ: process.env.TZ || 'UTC',
    HEALTH_OS_WORKSPACE: workspace
  };
  if (process.env.HEALTH_OS_REPO) env.HEALTH_OS_REPO = process.env.HEALTH_OS_REPO;
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function run(command, workspace, env) {
  const result = spawnSync(process.execPath, [cliPath, command, '--workspace', workspace, '--json'], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Demo command ${command} failed${result.status === null ? '' : ` (exit ${result.status})`}.`);
  }
  const output = result.stdout.trim();
  try {
    const envelope = JSON.parse(output);
    if (envelope.ok !== true || envelope.command !== command) throw new Error('invalid demo response');
  } catch {
    throw new Error(`Demo command ${command} returned an invalid response.`);
  }
  process.stdout.write(`${output}\n`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-demo-'));
const workspace = path.join(tempRoot, 'workspace');
const env = minimalEnvironment(workspace);
let taskError;
let cleanupError;

try {
  run('init', workspace, env);
  run('prepare-training', workspace, env);
} catch (error) {
  taskError = error;
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (fs.existsSync(tempRoot)) throw new Error('Temporary demo directory still exists after cleanup.');
  } catch (error) {
    cleanupError = error;
  }
}

if (taskError || cleanupError) {
  if (taskError) process.stderr.write(`SOMA demo: ${taskError.message}\n`);
  if (cleanupError) process.stderr.write('SOMA demo: temporary workspace cleanup could not be verified.\n');
  process.exitCode = 1;
}
