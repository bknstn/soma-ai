import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runRuntimeCli } from '../src/runtime/cli.js';
import { RuntimeManager } from '../src/runtime/manager.js';
import { createHermesProvider, HERMES_SOURCE_REVISION } from '../src/runtime/providers/hermes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('context policy validation and configuration transactions pass offline synthetic contracts', () => {
  const result = spawnSync('python3', ['-I', '-B', 'tests/context_policy_test.py'], {
    cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('runtime context CLI resolves explicit options and emits a versioned response', async () => {
  const calls = [];
  let output = '';
  const result = await runRuntimeCli(['context', '--file', 'examples/context-policy.json', '--context-window', '128000', '--json'], {
    stdout: { write: (value) => { output += value; } },
    manager: { async contextPolicy(options) { calls.push(options); return { changed: true }; } }
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, [{ file: path.resolve('examples/context-policy.json'), contextWindow: 128000 }]);
  assert.deepEqual(JSON.parse(output), { schema_version: 1, command: 'runtime-context', ok: true, data: { changed: true } });
});

test('invalid context CLI arguments fail before constructing a runtime manager', async () => {
  for (const args of [
    ['doctor', '--file', 'unused'], ['chat', '--context-window', '128000'],
    ['context', '--context-window', '0'], ['context', '--context-window', 'NaN'],
    ['context', '--context-window', '10000001'], ['context', '--context-window', '1.5'],
    ['context', '--file'], ['context', '--file', 'a', '--file', 'b'], ['context', '--unknown']
  ]) {
    let constructed = false;
    const code = await runRuntimeCli(args, {
      stderr: { write() {} },
      createRuntimeManager() { constructed = true; throw new Error('should not construct'); }
    });
    assert.equal(code, 2, args.join(' '));
    assert.equal(constructed, false);
  }
});

test('context manager isolates configuration operations from credentials and Health OS', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-context-manager-'));
  t.after(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    assert.equal(fs.existsSync(temporary), false);
  });
  const runtimeHome = path.join(temporary, 'runtime');
  const contexts = [];
  const provider = {
    name: 'synthetic', sourceRevision: 'synthetic123', chatCredentialEnv: ['SYNTHETIC_API_KEY'],
    async setup() {}, async inspect() { return { ready: true }; }, async launch() {},
    async contextPolicy({ context, file, contextWindow }) {
      contexts.push(context);
      assert.equal(file, '/synthetic/policy.json');
      assert.equal(contextWindow, 128000);
      return { changed: false };
    }
  };
  const manager = new RuntimeManager({ runtime: 'synthetic', runtimeHome, providers: { synthetic: provider },
    env: { PATH: process.env.PATH, SYNTHETIC_API_KEY: 'do-not-pass', OPENAI_API_KEY: 'do-not-pass',
      HERMES_HOME: '/synthetic/global-home', HEALTH_OS_REPO: path.join(temporary, 'health-repo'),
      HEALTH_OS_WORKSPACE: path.join(temporary, 'health-workspace') }
  });
  await assert.rejects(manager.contextPolicy(), { code: 'SOMA_RUNTIME_NOT_READY' });
  assert.equal(contexts.length, 0);
  await manager.setup();
  await manager.contextPolicy({ file: '/synthetic/policy.json', contextWindow: 128000 });
  assert.equal(contexts.length, 1);
  const context = contexts[0];
  for (const key of ['SYNTHETIC_API_KEY', 'OPENAI_API_KEY', 'HEALTH_OS_REPO', 'HEALTH_OS_WORKSPACE', 'HERMES_HOME']) {
    assert.equal(context.env[key], undefined);
  }
  assert.equal(context.env.HOME, path.join(fs.realpathSync(runtimeHome), 'user-home'));
  assert.equal(context.operation, 'context-policy');
  delete provider.contextPolicy;
  await assert.rejects(manager.contextPolicy(), { code: 'SOMA_RUNTIME_CONTEXT_UNSUPPORTED' });
});

test('Hermes context adapter bounds helper argv, output, and errors', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-context-adapter-'));
  t.after(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    assert.equal(fs.existsSync(temporary), false);
  });
  const root = fs.realpathSync(temporary);
  const repo = path.join(root, 'repo');
  for (const relative of ['third_party/hermes-agent', 'runtimes/hermes']) fs.mkdirSync(path.join(repo, relative), { recursive: true });
  for (const relative of ['runtimes/hermes/manifest.json', 'runtimes/hermes/context-policy.py']) {
    fs.copyFileSync(path.join(repoRoot, relative), path.join(repo, relative));
  }
  for (const relative of ['third_party/hermes-agent/hermes', 'runtimes/hermes/setup.sh', 'runtimes/hermes/check.sh']) {
    fs.writeFileSync(path.join(repo, relative), 'synthetic');
  }
  const runtimeHome = path.join(root, 'runtime');
  for (const relative of ['hermes-tools/bin', 'user-home', 'working-directory']) fs.mkdirSync(path.join(runtimeHome, relative), { recursive: true });
  const python = path.join(runtimeHome, 'hermes-tools/bin/python');
  fs.writeFileSync(python, 'synthetic interpreter');
  fs.writeFileSync(path.join(runtimeHome, 'hermes-python.txt'), python);
  const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, 'examples/context-policy.json'), 'utf8'));
  const payload = {
    schema_version: 1, changed: false, policy: settings,
    budget: { status: 'window_required', context_window: null, output_reservation: null,
      effective_threshold_ratio: null, trigger_tokens: null, tail_budget_tokens: null,
      summary_max_tokens: null, gateway_trigger_tokens: null },
    unexpected_private_field: 'SYNTHETIC_PRIVATE_VALUE'
  };
  const calls = [];
  let result = { status: 0, stdout: JSON.stringify(payload), stderr: 'SYNTHETIC_PRIVATE_VALUE' };
  const provider = createHermesProvider({ repoRoot: repo, spawnSyncImpl(executable, args, options) {
    calls.push({ executable, args, options });
    return result;
  } });
  const context = { runtimeHome, env: { HOME: path.join(runtimeHome, 'user-home'), HERMES_HOME: path.join(runtimeHome, 'hermes-home') } };
  assert.equal(provider.sourceRevision, HERMES_SOURCE_REVISION);
  const file = path.join(root, 'policy $(no-shell).json');
  const report = await provider.contextPolicy({ context, file, contextWindow: 128000 });
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  assert.equal(calls[0].executable, python);
  assert.deepEqual(calls[0].args.slice(-4), ['--file', file, '--context-window', '128000']);
  assert.equal(calls[0].options.env, context.env);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, path.join(repo, 'third_party/hermes-agent'));
  for (const bad of [
    { status: 2, stdout: '{"error":"invalid_policy","private":"SYNTHETIC_PRIVATE_VALUE"}' },
    { status: 0, stdout: 'SYNTHETIC_PRIVATE_VALUE' },
    { status: 0, stdout: JSON.stringify({ ...payload, budget: { status: 'unknown' } }) },
    { status: 0, stdout: 'X'.repeat(65537) },
    { status: null, error: { code: 'ETIMEDOUT' }, stdout: 'SYNTHETIC_PRIVATE_VALUE' }
  ]) {
    result = bad;
    await assert.rejects(provider.contextPolicy({ context }), (error) => {
      assert.equal(error.code, 'SOMA_HERMES_CONTEXT_INVALID');
      assert.equal(error.message.includes('SYNTHETIC_PRIVATE_VALUE'), false);
      return true;
    });
  }
});
