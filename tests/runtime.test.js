import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeError, RuntimeManager } from '../src/runtime/manager.js';
import { runRuntimeCli } from '../src/runtime/cli.js';
import { createHermesProvider, HERMES_SOURCE_REVISION } from '../src/runtime/providers/hermes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-runtime-test-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'temporary test root should be removed');
  });
  return root;
}

function fakeProvider({ onSetup = () => {}, onInspect = () => {}, onLaunch = () => {}, forbiddenHomes = [],
  gatewayCredentialEnv = [] } = {}) {
  return {
    name: 'fake-agent',
    sourceRevision: 'abc123def456',
    chatCredentialEnv: ['FAKE_AGENT_KEY'],
    gatewayCredentialEnv,
    forbiddenHomes,
    environment({ runtimeHome }) {
      return { FAKE_AGENT_HOME: path.join(runtimeHome, 'fake-home') };
    },
    async setup(context) { onSetup(context); return { ready: true, status: 'ready' }; },
    async inspect(context) {
      const result = await onInspect(context);
      return result && typeof result === 'object' ? result : { ready: true, status: 'ready' };
    },
    async launch(args) { return onLaunch(args); }
  };
}

function fakeSpawn(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
}

function hermesFixture(t) {
  const root = temporaryRoot(t);
  const repo = path.join(root, 'repo');
  const source = path.join(repo, 'third_party', 'hermes-agent');
  const runtime = path.join(repo, 'runtimes', 'hermes');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(source, 'hermes'), '# synthetic Hermes entrypoint\n');
  fs.writeFileSync(path.join(runtime, 'setup.sh'), '# synthetic setup helper\n');
  fs.writeFileSync(path.join(runtime, 'check.sh'), '# synthetic check helper\n');
  fs.writeFileSync(path.join(runtime, 'manifest.json'), `${JSON.stringify({
    schema_version: 1,
    name: 'hermes',
    provider: 'hermes',
    source_path: 'third_party/hermes-agent',
    source_revision: HERMES_SOURCE_REVISION,
    upstream: { tag: 'v0.22.5' },
    runtime: {
      user_home: 'user-home',
      working_directory: 'working-directory',
      hermes_home: 'hermes-home',
      managed_dir: 'hermes-managed',
      runtime_dir: 'hermes-tools',
      python_file: 'hermes-python.txt'
    },
    commands: {
      help: ['--help'],
      chat: ['chat', '--cli'],
      list_local_skills: ['skills', 'list', '--source', 'local'],
      gateway: ['gateway', 'run', '--external-supervisor']
    },
    gateway_dependencies: {
      extra: 'telegram',
      telegram_package: 'python-telegram-bot',
      telegram_version: '22.8'
    }
  }, null, 2)}\n`);
  return { root, repo, source, runtime };
}

function validHermesCheck(overrides = {}) {
  return JSON.stringify({
    ok: true,
    provider: 'hermes',
    source_commit: HERMES_SOURCE_REVISION,
    source_clean: true,
    python_version: '3.14.9',
    cli_help: true,
    skill_loaded: true,
    telegram_sdk: true,
    gateway_authz: true,
    error: null,
    ...overrides
  }) + '\n';
}

test('provider-neutral manager isolates env and allows provider-owned argv', async (t) => {
  const root = temporaryRoot(t);
  const runtimeHome = path.join(root, 'managed-runtime');
  const healthRepo = path.join(root, 'health-os');
  const healthWorkspace = path.join(root, 'health-workspace');
  fs.mkdirSync(healthRepo);
  fs.mkdirSync(healthWorkspace);

  const sourceEnv = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'external-home'),
    USERPROFILE: path.join(root, 'external-profile'),
    HERMES_HOME: path.join(root, 'global-hermes'),
    XDG_CONFIG_HOME: path.join(root, 'external-xdg'),
    OPENAI_API_KEY: 'must-not-pass',
    FAKE_AGENT_KEY: 'only-for-chat',
    HEALTH_OS_REPO: healthRepo,
    HEALTH_OS_WORKSPACE: healthWorkspace
  };
  const setupEnvs = [];
  const inspectEnvs = [];
  const spawnCalls = [];
  const provider = fakeProvider({
    onSetup: ({ env }) => setupEnvs.push(env),
    onInspect: ({ env }) => inspectEnvs.push(env),
    onLaunch: ({ action, args, context }) => {
      if (action === 'chat') {
        assert.deepEqual(args, []);
        assert.equal(context.env.FAKE_AGENT_KEY, 'only-for-chat');
        return {
          executable: process.execPath,
          args: ['-p', 'an alternate provider may use this option'],
          cwd: path.join(context.runtimeHome, 'working-directory')
        };
      }
      assert.equal(action, 'skills');
      assert.deepEqual(args, [], 'the generic manager requests a skill list without vendor flags');
      return {
        executable: process.execPath,
        args: ['--vendor-specific-local-list'],
        cwd: path.join(context.runtimeHome, 'working-directory')
      };
    }
  });
  const manager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome, env: sourceEnv, repoRoot,
    providers: { 'fake-agent': provider }, spawnProcess: fakeSpawn(spawnCalls)
  });

  await manager.setup();
  const canonicalRuntimeHome = fs.realpathSync(runtimeHome);
  assert.equal((await manager.inspect()).ready, true);
  assert.ok(setupEnvs.length > 0);
  for (const env of [...setupEnvs, ...inspectEnvs]) {
    assert.equal(env.HOME, path.join(canonicalRuntimeHome, 'user-home'));
    assert.equal(env.USERPROFILE, env.HOME);
    assert.ok(env.XDG_CONFIG_HOME.startsWith(env.HOME));
    assert.equal(env.FAKE_AGENT_HOME, path.join(canonicalRuntimeHome, 'fake-home'));
    assert.equal(env.HERMES_HOME, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.FAKE_AGENT_KEY, undefined, 'provider credentials must not reach setup or inspect');
    assert.equal(env.HEALTH_OS_REPO, undefined);
    assert.equal(env.HEALTH_OS_WORKSPACE, undefined);
  }

  await manager.chat();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].executable, process.execPath);
  assert.deepEqual(spawnCalls[0].args, ['-p', 'an alternate provider may use this option']);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.cwd, path.join(canonicalRuntimeHome, 'working-directory'));
  assert.equal(spawnCalls[0].options.env.FAKE_AGENT_KEY, 'only-for-chat');
  assert.equal(spawnCalls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(spawnCalls[0].options.env.HOME, path.join(canonicalRuntimeHome, 'user-home'));
  assert.equal(spawnCalls[0].options.env.HEALTH_OS_REPO, healthRepo);
  assert.equal(spawnCalls[0].options.env.HEALTH_OS_WORKSPACE, healthWorkspace);
  await manager.skills();
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].args, ['--vendor-specific-local-list']);
  assert.equal(spawnCalls[1].options.env.HEALTH_OS_REPO, undefined);
  assert.equal(spawnCalls[1].options.env.FAKE_AGENT_KEY, undefined);
});

test('managed gateway passes only bounded credentials and forwards clean shutdown signals', async (t) => {
  const root = temporaryRoot(t);
  const runtimeHome = path.join(root, 'runtime');
  const healthRepo = path.join(root, 'health-os');
  const workspace = path.join(root, 'health-workspace');
  fs.mkdirSync(healthRepo);
  fs.mkdirSync(workspace);
  const childCalls = [];
  const signalSource = new EventEmitter();
  let child;
  const provider = fakeProvider({
    gatewayCredentialEnv: ['FAKE_BOT_TOKEN', 'FAKE_ALLOWED_USERS'],
    onLaunch: ({ action, args, context }) => {
      assert.equal(action, 'gateway');
      assert.deepEqual(args, []);
      assert.equal(context.env.FAKE_BOT_TOKEN, 'synthetic-bot-token');
      assert.equal(context.env.FAKE_ALLOWED_USERS, '73142');
      assert.equal(context.env.FAKE_AGENT_KEY, 'synthetic-model-key');
      assert.equal(context.env.STRAY_CHANNEL_TOKEN, undefined);
      assert.equal(context.env.OPENAI_API_KEY, undefined);
      assert.equal(context.env.HEALTH_OS_REPO, healthRepo);
      assert.equal(context.env.HEALTH_OS_WORKSPACE, workspace);
      assert.equal(context.env.HOME, path.join(fs.realpathSync(runtimeHome), 'user-home'));
      return {
        executable: process.execPath,
        args: ['gateway-entry'],
        cwd: path.join(context.runtimeHome, 'working-directory')
      };
    }
  });
  const manager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome, repoRoot,
    env: {
      PATH: process.env.PATH,
      HEALTH_OS_REPO: healthRepo,
      HEALTH_OS_WORKSPACE: workspace,
      FAKE_AGENT_KEY: 'synthetic-model-key',
      FAKE_BOT_TOKEN: 'synthetic-bot-token',
      FAKE_ALLOWED_USERS: '73142',
      STRAY_CHANNEL_TOKEN: 'must-not-pass',
      OPENAI_API_KEY: 'not-allowlisted'
    },
    providers: { 'fake-agent': provider },
    signalSource,
    spawnProcess(executable, args, options) {
      childCalls.push({ executable, args, options });
      child = new EventEmitter();
      child.killedSignals = [];
      child.kill = (signal) => { child.killedSignals.push(signal); return true; };
      return child;
    }
  });
  await manager.setup();

  const gateway = manager.gateway();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childCalls.length, 1);
  assert.deepEqual(childCalls[0].args, ['gateway-entry']);
  assert.equal(childCalls[0].options.shell, false);
  assert.equal(childCalls[0].options.env.SOMA_RUNTIME_OPERATION, 'gateway');
  assert.equal(childCalls[0].options.env.STRAY_CHANNEL_TOKEN, undefined);
  assert.equal(childCalls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(signalSource.listenerCount('SIGTERM'), 1);

  signalSource.emit('SIGTERM');
  assert.deepEqual(child.killedSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  assert.equal(await gateway, 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
});

test('runtime setup refuses populated unmanaged home', async (t) => {
  const root = temporaryRoot(t);
  const runtimeHome = path.join(root, 'not-managed');
  fs.mkdirSync(runtimeHome);
  fs.writeFileSync(path.join(runtimeHome, 'keep.txt'), 'synthetic user file');
  const manager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome, env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider() }
  });
  await assert.rejects(manager.setup(), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'SOMA_RUNTIME_HOME_UNMANAGED');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(runtimeHome, 'keep.txt'), 'utf8'), 'synthetic user file');
});

test('runtime setup reports only bounded readiness status codes', async (t) => {
  const root = temporaryRoot(t);
  const failed = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome: path.join(root, 'failed'), env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider({ onInspect: () => ({ ready: false, status: 'gateway_authz_check_failed' }) }) }
  });
  await assert.rejects(failed.setup(), (error) => {
    assert.equal(error.code, 'SOMA_RUNTIME_SETUP_INCOMPLETE');
    assert.match(error.message, /gateway_authz_check_failed/);
    return true;
  });

  const unsafe = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome: path.join(root, 'unsafe'), env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider({ onInspect: () => ({ ready: false, status: 'sk-secret-with-dashes' }) }) }
  });
  await assert.rejects(unsafe.setup(), (error) => {
    assert.equal(error.code, 'SOMA_RUNTIME_SETUP_INCOMPLETE');
    assert.doesNotMatch(error.message, /sk-secret/);
    return true;
  });
});

test('runtime home cannot be a symlink and managed HOME cannot escape after setup', async (t) => {
  const root = temporaryRoot(t);
  const target = path.join(root, 'target');
  const linkedHome = path.join(root, 'runtime-link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linkedHome, 'dir');
  const linkedManager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome: linkedHome, env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider() }
  });
  await assert.rejects(linkedManager.setup(), { code: 'SOMA_RUNTIME_HOME_INVALID' });

  const runtimeHome = path.join(root, 'managed');
  const manager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome, env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider() }
  });
  await manager.setup();
  fs.rmSync(path.join(runtimeHome, 'user-home'), { recursive: true });
  fs.symlinkSync(target, path.join(runtimeHome, 'user-home'), 'dir');
  await assert.rejects(manager.inspect(), { code: 'SOMA_RUNTIME_HOME_INVALID' });
});

test('runtime home cannot overlap a forbidden provider home or symlinked Health OS workspace', async (t) => {
  const root = temporaryRoot(t);
  const globalHome = path.join(root, 'global-agent-home');
  const blockedManager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome: path.join(globalHome, 'nested'), env: {}, repoRoot,
    providers: { 'fake-agent': fakeProvider({ forbiddenHomes: [globalHome] }) }
  });
  await assert.rejects(blockedManager.setup(), { code: 'SOMA_RUNTIME_HOME_PROVIDER_OVERLAP' });

  const runtimeHome = path.join(root, 'separate-runtime');
  const workspaceLink = path.join(root, 'workspace-link');
  fs.mkdirSync(runtimeHome);
  fs.symlinkSync(runtimeHome, workspaceLink, 'dir');
  const workspaceManager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome, env: { HEALTH_OS_WORKSPACE: workspaceLink }, repoRoot,
    providers: { 'fake-agent': fakeProvider() }
  });
  await assert.rejects(workspaceManager.setup(), { code: 'SOMA_RUNTIME_HOME_WORKSPACE_OVERLAP' });

  const configuredHealthRepo = path.join(root, 'configured-health-os');
  fs.mkdirSync(configuredHealthRepo);
  const nestedRuntimeManager = new RuntimeManager({
    runtime: 'fake-agent', runtimeHome: path.join(configuredHealthRepo, 'runtime'),
    env: { HEALTH_OS_REPO: configuredHealthRepo }, repoRoot,
    providers: { 'fake-agent': fakeProvider() }
  });
  await assert.rejects(nestedRuntimeManager.setup(), { code: 'SOMA_RUNTIME_HOME_UNSAFE' });
});

test('runtime CLI accepts command options after the command and converts rejected launches to errors', async () => {
  const stdout = { content: '', write(value) { this.content += value; } };
  const stderr = { content: '', write(value) { this.content += value; } };
  let managerOptions;
  const code = await runRuntimeCli(['doctor', '--runtime', 'fake-agent', '--runtime-home', '/tmp/runtime-cli-test-home', '--json'], {
    stdout, stderr,
    async createRuntimeManager(options) {
      managerOptions = options;
      return { async inspect() { return { runtime: 'fake-agent', status: 'ready', ready: true }; } };
    }
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.content), {
    schema_version: 1,
    command: 'runtime-doctor',
    ok: true,
    data: { runtime: 'fake-agent', status: 'ready', ready: true }
  });
  assert.equal(managerOptions.runtime, 'fake-agent');
  assert.equal(managerOptions.runtimeHome, '/tmp/runtime-cli-test-home');

  stdout.content = '';
  stderr.content = '';
  const launchCode = await runRuntimeCli(['chat'], {
    stdout, stderr,
    manager: { async chat() { throw new RuntimeError('safe local message', { code: 'SOMA_RUNTIME_NOT_READY' }); } }
  });
  assert.equal(launchCode, 1);
  assert.match(stderr.content, /SOMA_RUNTIME_NOT_READY/);
  assert.equal(stdout.content, '');

  let gatewayCalls = 0;
  const gatewayCode = await runRuntimeCli(['gateway', '--runtime', 'fake-agent', '--runtime-home', '/tmp/runtime-cli-test-home'], {
    stdout, stderr, env: {},
    manager: { async gateway() { gatewayCalls += 1; return 0; } }
  });
  assert.equal(gatewayCode, 0);
  assert.equal(gatewayCalls, 1);
  const unsafeGatewayCode = await runRuntimeCli(['gateway', '--replace'], {
    stdout, stderr, env: {},
    manager: { async gateway() { assert.fail('gateway flags must be rejected before manager call'); } }
  });
  assert.equal(unsafeGatewayCode, 2);
  assert.match(stderr.content, /SOMA_RUNTIME_USAGE/);

  let helpCalls = 0;
  const helpCode = await runRuntimeCli(['chat', '--help'], {
    stdout, stderr, env: {},
    manager: {
      async help() { helpCalls += 1; return 0; },
      async chat() { assert.fail('chat --help must use the offline help path'); }
    }
  });
  assert.equal(helpCode, 0);
  assert.equal(helpCalls, 1);

  let installedProvider;
  const dependencyCode = await runRuntimeCli(['provider-deps', 'anthropic'], {
    stdout, stderr, env: {},
    manager: { async installProviderDependencies(name) { installedProvider = name; return 0; } }
  });
  assert.equal(dependencyCode, 0);
  assert.equal(installedProvider, 'anthropic');

  const invalidDependencyCode = await runRuntimeCli(['provider-deps', 'anthropic;echo unsafe'], {
    stdout, stderr, env: {},
    manager: { async installProviderDependencies() { assert.fail('unsafe provider name must be rejected before manager call'); } }
  });
  assert.equal(invalidDependencyCode, 2);
  assert.match(stderr.content, /SOMA_RUNTIME_USAGE/);
});

test('Hermes adapter accepts the pinned helper JSON and uses an argv-only helper boundary', async (t) => {
  const fixture = hermesFixture(t);
  const calls = [];
  const provider = createHermesProvider({
    repoRoot: fixture.repo,
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: validHermesCheck(), stderr: '' };
    }
  });
  const result = await provider.inspect({ runtimeHome: path.join(fixture.root, 'runtime-home'), env: { SOMA_RUNTIME_HOME: '/synthetic/home' } });
  assert.equal(result.ready, true);
  assert.equal(result.source_revision, HERMES_SOURCE_REVISION);
  assert.equal(result.python_version, '3.14.9');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'bash');
  assert.deepEqual(calls[0].args, [path.join(fixture.repo, 'runtimes', 'hermes', 'check.sh')]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, fixture.repo);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('Hermes adapter rejects malformed, dirty, mismatched, excessive, and timed-out checks', async (t) => {
  const fixture = hermesFixture(t);
  let runResult = { status: 0, stdout: validHermesCheck(), stderr: '' };
  const provider = createHermesProvider({
    repoRoot: fixture.repo,
    spawnSyncImpl() { return runResult; }
  });
  const context = { runtimeHome: path.join(fixture.root, 'runtime-home'), env: {} };

  runResult = { status: 1, stdout: validHermesCheck({ ok: false, skill_loaded: false, error: 'skill_not_loaded' }), stderr: '' };
  const unavailable = await provider.inspect(context);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.status, 'skill_not_loaded');

  runResult = { status: 1, stdout: validHermesCheck({
    ok: false, source_clean: false, python_version: '', cli_help: false, skill_loaded: false, error: 'persona_missing'
  }), stderr: '' };
  const missingRuntimeFile = await provider.inspect(context);
  assert.equal(missingRuntimeFile.ready, false);
  assert.equal(missingRuntimeFile.status, 'persona_missing');

  const rejectedCases = [
    [{ status: 0, stdout: '{bad json}\n', stderr: '' }, 'SOMA_HERMES_CHECK_INVALID'],
    [{ status: 0, stdout: `${validHermesCheck()}{}\n`, stderr: '' }, 'SOMA_HERMES_CHECK_INVALID'],
    [{ status: 0, stdout: validHermesCheck({ source_commit: 'deadbeef' }), stderr: '' }, 'SOMA_HERMES_REVISION_MISMATCH'],
    [{ status: 0, stdout: validHermesCheck({ source_commit: '' }), stderr: '' }, 'SOMA_HERMES_REVISION_MISMATCH'],
    [{ status: 0, stdout: validHermesCheck({ python_version: '3.15.0' }), stderr: '' }, 'SOMA_HERMES_CHECK_INVALID'],
    [{ status: 0, stdout: validHermesCheck({ cli_help: false }), stderr: '' }, 'SOMA_HERMES_CHECK_INVALID'],
    [{ status: 1, stdout: validHermesCheck({
      ok: false, source_clean: false, python_version: '', cli_help: false, skill_loaded: false, error: 'source_dirty'
    }), stderr: '' }, 'SOMA_HERMES_SOURCE_DIRTY'],
    [{ status: 0, stdout: 'x'.repeat(65 * 1024), stderr: '' }, 'SOMA_HERMES_OUTPUT_LIMIT'],
    [{ status: null, error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }, 'SOMA_HERMES_HELPER_TIMEOUT'],
    [{ status: 2, stdout: '{}\n', stderr: '' }, 'SOMA_HERMES_HELPER_FAILED']
  ];
  for (const [result, code] of rejectedCases) {
    runResult = result;
    await assert.rejects(provider.inspect(context), { code });
  }
});

test('Hermes provider maps generic skills action to pinned local-only CLI argv', async (t) => {
  const fixture = hermesFixture(t);
  const provider = createHermesProvider({ repoRoot: fixture.repo, spawnSyncImpl: () => ({ status: 0, stdout: validHermesCheck(), stderr: '' }) });
  const runtimeHome = path.join(fixture.root, 'runtime-home');
  const pythonPath = path.join(runtimeHome, 'hermes-tools', 'python-3.14', 'bin', 'python3');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, 'synthetic interpreter');
  fs.chmodSync(pythonPath, 0o700);
  fs.writeFileSync(path.join(runtimeHome, 'hermes-python.txt'), `${pythonPath}\n`);

  provider.validateLaunch({ action: 'skills', args: [] });
  const launch = await provider.launch({ action: 'skills', args: [], context: { runtimeHome } });
  assert.equal(launch.executable, fs.realpathSync(pythonPath));
  assert.deepEqual(launch.args, [path.join(fixture.source, 'hermes'), 'skills', 'list', '--source', 'local']);
  assert.equal(launch.cwd, path.join(runtimeHome, 'working-directory'));
  assert.throws(() => provider.validateLaunch({ action: 'chat', args: ['--profile', 'private'] }), {
    code: 'SOMA_HERMES_OPERATION_BLOCKED'
  });

  provider.validateLaunch({ action: 'provider-dependencies', args: ['anthropic'] });
  const dependencyLaunch = await provider.launch({ action: 'provider-dependencies', args: ['anthropic'], context: { runtimeHome } });
  assert.deepEqual(dependencyLaunch.args, [path.join(fixture.source, 'hermes'), 'pm', 'install', '--extra', 'anthropic']);
  assert.throws(() => provider.validateLaunch({ action: 'provider-dependencies', args: ['openai'] }), {
    code: 'SOMA_HERMES_PROVIDER_DEPENDENCIES_UNSUPPORTED'
  });
  const providerEnv = provider.environment({ runtimeHome });
  assert.equal(providerEnv.HERMES_HOME, path.join(runtimeHome, 'hermes-home'));
  assert.equal(providerEnv.HERMES_MANAGED_DIR, path.join(runtimeHome, 'hermes-managed'));
  assert.equal(providerEnv.HERMES_RUNTIME_DIR, path.join(runtimeHome, 'hermes-tools'));
  assert.equal(providerEnv.HERMES_DISABLE_LAZY_INSTALLS, '1');
});

test('Hermes gateway launch is Telegram-only, isolated, and externally supervised', async (t) => {
  const fixture = hermesFixture(t);
  const requestedRuntimeHome = path.join(fixture.root, 'runtime-home');
  for (const name of ['user-home', 'working-directory', 'hermes-home', 'hermes-managed', 'hermes-tools']) {
    fs.mkdirSync(path.join(requestedRuntimeHome, name), { recursive: true });
  }
  const runtimeHome = fs.realpathSync(requestedRuntimeHome);
  const pythonPath = path.join(runtimeHome, 'hermes-tools', 'python-3.14', 'bin', 'python3');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, 'synthetic interpreter');
  fs.chmodSync(pythonPath, 0o700);
  fs.writeFileSync(path.join(runtimeHome, 'hermes-python.txt'), `${pythonPath}\n`);
  const calls = [];
  const provider = createHermesProvider({
    repoRoot: fixture.repo,
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
  });
  const env = {
    ...provider.environment({ runtimeHome }),
    HOME: path.join(runtimeHome, 'user-home'),
    SOMA_RUNTIME_HOME: runtimeHome,
    TELEGRAM_BOT_TOKEN: '123456:synthetic_token_for_gateway_tests',
    TELEGRAM_ALLOWED_USERS: '73142,88109',
    OPENAI_API_KEY: 'synthetic-model-key'
  };
  const context = { runtimeHome, env };

  provider.validateLaunch({ action: 'gateway', args: [] });
  const launch = await provider.launch({ action: 'gateway', args: [], context });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, fs.realpathSync(pythonPath));
  assert.deepEqual(calls[0].args[0], '-c');
  assert.match(calls[0].args[1], /non_telegram_platform_configured/);
  assert.match(calls[0].args[1], /unauthorized_dm_behavior_not_ignore/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, fixture.source);
  assert.equal(calls[0].options.env.HERMES_HOME, path.join(runtimeHome, 'hermes-home'));
  assert.equal(calls[0].options.env.HERMES_MANAGED_DIR, path.join(runtimeHome, 'hermes-managed'));
  assert.equal(calls[0].options.env.TELEGRAM_ALLOWED_USERS, '73142,88109');
  assert.equal(launch.executable, fs.realpathSync(pythonPath));
  assert.deepEqual(launch.args, [path.join(fixture.source, 'hermes'), 'gateway', 'run', '--external-supervisor']);
  assert.doesNotMatch(launch.args.join(' '), /--force|--replace/);
  assert.equal(launch.cwd, path.join(runtimeHome, 'working-directory'));

  await assert.rejects(provider.launch({
    action: 'gateway', args: [], context: { ...context, env: { ...env, TELEGRAM_ALLOWED_USERS: '*' } }
  }), { code: 'SOMA_HERMES_GATEWAY_TELEGRAM_ALLOWLIST_REQUIRED' });
  await assert.rejects(provider.launch({
    action: 'gateway', args: [], context: { ...context, env: { ...env, TELEGRAM_ALLOWED_USERS: '73142,-88109' } }
  }), { code: 'SOMA_HERMES_GATEWAY_TELEGRAM_ALLOWLIST_REQUIRED' });
  await assert.rejects(provider.launch({
    action: 'gateway', args: [], context: { ...context, env: { ...env, GATEWAY_ALLOW_ALL_USERS: 'true' } }
  }), { code: 'SOMA_HERMES_GATEWAY_ALLOW_ALL_BLOCKED' });
});

test('Hermes gateway refuses hidden secret files, named profiles, and widened config', async (t) => {
  const fixture = hermesFixture(t);
  const requestedRuntimeHome = path.join(fixture.root, 'runtime-home');
  for (const name of ['user-home', 'working-directory', 'hermes-home', 'hermes-managed', 'hermes-tools']) {
    fs.mkdirSync(path.join(requestedRuntimeHome, name), { recursive: true });
  }
  const runtimeHome = fs.realpathSync(requestedRuntimeHome);
  const pythonPath = path.join(runtimeHome, 'hermes-tools', 'python-3.14', 'bin', 'python3');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, 'synthetic interpreter');
  fs.chmodSync(pythonPath, 0o700);
  fs.writeFileSync(path.join(runtimeHome, 'hermes-python.txt'), `${pythonPath}\n`);
  let configResult = { status: 0, stdout: '{"ok":true}\n', stderr: '' };
  const calls = [];
  const provider = createHermesProvider({
    repoRoot: fixture.repo,
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return configResult;
    }
  });
  const env = {
    ...provider.environment({ runtimeHome }),
    HOME: path.join(runtimeHome, 'user-home'),
    SOMA_RUNTIME_HOME: runtimeHome,
    TELEGRAM_BOT_TOKEN: '123456:synthetic_token_for_gateway_tests',
    TELEGRAM_ALLOWED_USERS: '73142'
  };
  const context = { runtimeHome, env };
  const launch = () => provider.launch({ action: 'gateway', args: [], context });

  fs.writeFileSync(path.join(runtimeHome, 'hermes-home', '.env'), 'DISCORD_BOT_TOKEN=synthetic\n');
  await assert.rejects(launch(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(calls.length, 0, 'hidden env files must be rejected before config loader execution');
  fs.rmSync(path.join(runtimeHome, 'hermes-home', '.env'));

  fs.mkdirSync(path.join(runtimeHome, 'hermes-home', 'profiles', 'buddy-profile'), { recursive: true });
  await assert.rejects(launch(), { code: 'SOMA_HERMES_GATEWAY_PROFILES_BLOCKED' });
  fs.rmSync(path.join(runtimeHome, 'hermes-home', 'profiles'), { recursive: true });

  configResult = { status: 0, stdout: '{"ok":false,"code":"non_telegram_platform_configured"}\n', stderr: '' };
  await assert.rejects(launch(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /^import hermes_bootstrap\n/,
    'gateway config preflight must enter Hermes PM environment before imports');
});

test('pinned Telegram dependency remains native and offline-verifiable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtimes/hermes/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.gateway_dependencies, {
    extra: 'telegram',
    telegram_package: 'python-telegram-bot',
    telegram_version: '22.8'
  });
  assert.match(fs.readFileSync(path.join(repoRoot, 'third_party/hermes-agent/pyproject.toml'), 'utf8'),
    /telegram = \["python-telegram-bot\[webhooks\]==22\.8"\]/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'third_party/hermes-agent/uv.lock'), 'utf8'),
    /name = "python-telegram-bot"\nversion = "22\.8"/);
  const checkScript = fs.readFileSync(path.join(repoRoot, 'runtimes/hermes/check.sh'), 'utf8');
  assert.match(checkScript, /import hermes_bootstrap; import telegram;/,
    'Telegram dependency probe must activate Hermes PM environment');
  assert.match(checkScript, /import hermes_bootstrap\nimport os\nfrom gateway\.authz_mixin/,
    'authorization probe must activate Hermes PM environment');
  assert.match(checkScript, /gateway_authz_check_failed/);
});

test('provider dependency installs stay managed, credential-free, and allowlisted', async (t) => {
  const fixture = hermesFixture(t);
  const runtimeHome = path.join(fixture.root, 'managed-runtime');
  const pythonPath = path.join(runtimeHome, 'hermes-tools', 'python-3.14', 'bin', 'python3');
  const helperEnvs = [];
  const helperRunner = (executable, args, options) => {
    helperEnvs.push(options.env);
    if (args[0].endsWith('setup.sh')) {
      fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
      fs.writeFileSync(pythonPath, 'synthetic interpreter');
      fs.chmodSync(pythonPath, 0o700);
      fs.writeFileSync(path.join(runtimeHome, 'hermes-python.txt'), `${pythonPath}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: validHermesCheck(), stderr: '' };
  };
  const childCalls = [];
  const provider = createHermesProvider({ repoRoot: fixture.repo, spawnSyncImpl: helperRunner });
  const manager = new RuntimeManager({
    runtime: 'hermes', runtimeHome, repoRoot,
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'never pass to setup or provider installs',
      HEALTH_OS_REPO: path.join(fixture.root, 'not-a-health-repo'),
      HEALTH_OS_WORKSPACE: path.join(fixture.root, 'not-a-workspace')
    },
    providers: { hermes: provider },
    spawnProcess: fakeSpawn(childCalls)
  });
  await manager.setup();
  assert.equal(await manager.installProviderDependencies('anthropic'), 0);
  assert.equal(childCalls.length, 1);
  assert.deepEqual(childCalls[0].args, [path.join(fixture.source, 'hermes'), 'pm', 'install', '--extra', 'anthropic']);
  assert.equal(childCalls[0].options.shell, false);
  assert.equal(childCalls[0].options.env.HOME, path.join(fs.realpathSync(runtimeHome), 'user-home'));
  assert.equal(childCalls[0].options.env.HERMES_DISABLE_LAZY_INSTALLS, '1');
  assert.equal(childCalls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(childCalls[0].options.env.HEALTH_OS_REPO, undefined);
  assert.equal(childCalls[0].options.env.HEALTH_OS_WORKSPACE, undefined);
  assert.ok(helperEnvs.every((env) => env.OPENAI_API_KEY === undefined && env.HEALTH_OS_REPO === undefined));

  await assert.rejects(manager.installProviderDependencies('openai'), {
    code: 'SOMA_HERMES_PROVIDER_DEPENDENCIES_UNSUPPORTED'
  });
  await assert.rejects(manager.installProviderDependencies('anthropic;echo unsafe'), {
    code: 'SOMA_RUNTIME_PROVIDER_NAME_INVALID'
  });
  assert.equal(childCalls.length, 1, 'unsupported values must not reach a child process');
});

test('managed Hermes setup reaches ready with the helper null-error success response', async (t) => {
  const fixture = hermesFixture(t);
  const runtimeHome = path.join(fixture.root, 'managed-runtime');
  const setupDiagnostics = [];
  const stderr = { write(value) { setupDiagnostics.push(value); } };
  const calls = [];
  const provider = createHermesProvider({
    repoRoot: fixture.repo,
    stderr,
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return args[0].endsWith('setup.sh')
        ? { status: 0, stdout: '', stderr: 'setup progress\n' }
        : { status: 0, stdout: validHermesCheck(), stderr: '' };
    }
  });
  const manager = new RuntimeManager({
    runtime: 'hermes', runtimeHome, repoRoot,
    providers: { hermes: provider }
  });
  const setup = await manager.setup();
  assert.equal(setup.status, 'ready');
  assert.equal((await manager.inspect()).ready, true);
  assert.deepEqual(setupDiagnostics, ['setup progress\n']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ executable, options }) => executable === 'bash' && options.shell === false));
});
