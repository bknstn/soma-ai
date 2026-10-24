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

function fakeProvider({ onSetup = () => {}, onInspect = () => {}, onLaunch = () => {}, forbiddenHomes = [] } = {}) {
  return {
    name: 'fake-agent',
    sourceRevision: 'abc123def456',
    chatCredentialEnv: ['FAKE_AGENT_KEY'],
    forbiddenHomes,
    environment({ runtimeHome }) {
      return { FAKE_AGENT_HOME: path.join(runtimeHome, 'fake-home') };
    },
    async setup(context) { onSetup(context); return { ready: true, status: 'ready' }; },
    async inspect(context) { onInspect(context); return { ready: true, status: 'ready' }; },
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
      runtime_dir: 'hermes-tools',
      python_file: 'hermes-python.txt'
    },
    commands: {
      help: ['--help'],
      chat: ['chat', '--cli'],
      list_local_skills: ['skills', 'list', '--source', 'local']
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
  assert.equal(providerEnv.HERMES_RUNTIME_DIR, path.join(runtimeHome, 'hermes-tools'));
  assert.equal(providerEnv.HERMES_DISABLE_LAZY_INSTALLS, '1');
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
