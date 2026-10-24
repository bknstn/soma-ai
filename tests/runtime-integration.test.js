import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeManager } from '../src/runtime/manager.js';
import { createHermesProvider } from '../src/runtime/providers/hermes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.SOMA_RUNTIME_INTEGRATION === '1';

function runRuntime(args) {
  const result = spawnSync(process.execPath, ['src/runtime/cli.js', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: process.env.CI,
      SOMA_RUNTIME: 'hermes',
      SOMA_RUNTIME_HOME: process.env.SOMA_RUNTIME_HOME,
      HEALTH_OS_REPO: process.env.HEALTH_OS_REPO
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `runtime ${args.join(' ')} failed with ${result.status}: ${result.stderr.slice(0, 500)}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('managed Hermes runtime runs offline doctor, CLI help, and local skill loading', { skip: !enabled }, () => {
  const runnerTemp = process.env.RUNNER_TEMP;
  const runtimeHome = process.env.SOMA_RUNTIME_HOME;
  assert.ok(runnerTemp && path.isAbsolute(runnerTemp), 'RUNNER_TEMP must be an explicit absolute CI path');
  assert.equal(runtimeHome, path.resolve(runnerTemp, 'soma-hermes-runtime'), 'runtime home must use the fresh CI-only path');

  const homeStat = fs.lstatSync(runtimeHome);
  assert.ok(homeStat.isDirectory() && !homeStat.isSymbolicLink(), 'runtime home must be a real directory');
  const marker = JSON.parse(fs.readFileSync(path.join(runtimeHome, '.soma-runtime.json'), 'utf8'));
  assert.equal(marker.managed_by, 'soma-ai');
  assert.equal(marker.runtime, 'hermes');
  assert.equal(marker.setup_status, 'ready');

  assert.match(runRuntime(['doctor']), /hermes: ready/i);
  assert.match(runRuntime(['chat', '--help']), /usage/i);
  assert.match(runRuntime(['skills', 'list']), /soma-health/);
});

test('isolated Telegram gateway preflight uses pinned config and auth with mocked final spawn', { skip: !enabled }, async (t) => {
  const runnerTemp = process.env.RUNNER_TEMP;
  const runtimeHome = process.env.SOMA_RUNTIME_HOME;
  const ownershipSentinel = process.env.SOMA_RUNTIME_CI_SENTINEL;
  assert.ok(runnerTemp && path.isAbsolute(runnerTemp), 'RUNNER_TEMP must be an explicit absolute CI path');
  assert.equal(runtimeHome, path.resolve(runnerTemp, 'soma-hermes-runtime'), 'runtime home must use the fresh CI-only path');
  assert.equal(ownershipSentinel, path.resolve(runnerTemp, '.soma-hermes-runtime-ci-owned'));
  assert.equal(fs.readFileSync(ownershipSentinel, 'utf8'), 'created by this CI job\n', 'runtime must be owned by this CI job');
  const marker = JSON.parse(fs.readFileSync(path.join(runtimeHome, '.soma-runtime.json'), 'utf8'));
  assert.equal(marker.managed_by, 'soma-ai');
  assert.equal(marker.runtime, 'hermes');
  assert.equal(marker.setup_status, 'ready');

  const hermesHome = path.join(runtimeHome, 'hermes-home');
  const hermesManaged = path.join(runtimeHome, 'hermes-managed');
  for (const directory of [hermesHome, hermesManaged]) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Hermes configuration roots must be real CI-owned directories');
  }

  const configPaths = [path.join(hermesHome, 'config.yaml'), path.join(hermesHome, 'gateway.json')];
  const snapshots = new Map();
  for (const filename of configPaths) {
    try {
      const stat = fs.lstatSync(filename);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `refusing to modify non-regular CI config ${path.basename(filename)}`);
      snapshots.set(filename, { data: fs.readFileSync(filename), mode: stat.mode & 0o777 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      snapshots.set(filename, null);
    }
  }
  t.after(() => {
    for (const [filename, snapshot] of snapshots) {
      if (snapshot) {
        fs.writeFileSync(filename, snapshot.data, { mode: snapshot.mode });
        fs.chmodSync(filename, snapshot.mode);
        assert.deepEqual(fs.readFileSync(filename), snapshot.data, 'CI-owned config must be restored exactly');
      } else {
        fs.rmSync(filename, { force: true });
        assert.equal(fs.existsSync(filename), false, 'test-created config must be removed');
      }
    }
  });
  for (const name of ['.env', '.op.env']) {
    assert.equal(fs.existsSync(path.join(hermesHome, name)), false, `fresh CI runtime must not contain ${name}`);
    assert.equal(fs.existsSync(path.join(hermesManaged, name)), false, `fresh managed scope must not contain ${name}`);
  }

  const syntheticHealthRoot = fs.mkdtempSync(path.join(runnerTemp, 'soma-gateway-health-os-'));
  t.after(() => {
    fs.rmSync(syntheticHealthRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(syntheticHealthRoot), false, 'synthetic Health OS paths must be removed');
  });
  const healthRepo = path.join(syntheticHealthRoot, 'repo');
  const healthWorkspace = path.join(syntheticHealthRoot, 'workspace');
  fs.mkdirSync(healthRepo);
  fs.mkdirSync(healthWorkspace);

  const baseConfig = `model:\n  provider: openai-api\n  default: gpt-6.1-sol\nagent:\n  reasoning_effort: medium\nplatforms:\n  telegram:\n    enabled: true\nunauthorized_dm_behavior: ignore\n`;
  const finalSpawns = [];
  const sourceEnv = {
    PATH: process.env.PATH,
    SOMA_RUNTIME: 'hermes',
    SOMA_RUNTIME_HOME: runtimeHome,
    HEALTH_OS_REPO: healthRepo,
    HEALTH_OS_WORKSPACE: healthWorkspace,
    TELEGRAM_BOT_TOKEN: '123456789:synthetic_token_for_gateway_integration',
    TELEGRAM_ALLOWED_USERS: '73142',
    OPENAI_API_KEY: 'synthetic_openai_api_key'
  };
  const provider = createHermesProvider({ repoRoot });
  const makeManager = () => new RuntimeManager({
    runtime: 'hermes', runtimeHome, env: sourceEnv, repoRoot, providers: { hermes: provider },
    spawnProcess(executable, args, options) {
      finalSpawns.push({ executable, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }
  });
  const configFile = configPaths[0];
  const writeConfig = (value) => fs.writeFileSync(configFile, value, { encoding: 'utf8', mode: 0o600 });

  writeConfig(baseConfig);
  assert.equal(await makeManager().gateway(), 0, 'minimal Telegram config should pass pinned preflight');
  assert.equal(finalSpawns.length, 1);
  assert.deepEqual(finalSpawns[0].args.slice(-3), ['gateway', 'run', '--external-supervisor']);
  assert.equal(finalSpawns[0].options.env.TELEGRAM_ALLOWED_USERS, '73142');
  assert.equal(finalSpawns[0].options.env.OPENAI_API_KEY, 'synthetic_openai_api_key');
  assert.equal(finalSpawns[0].options.env.TELEGRAM_ALLOW_ALL_USERS, undefined);
  assert.equal(finalSpawns[0].options.env.GATEWAY_ALLOW_ALL_USERS, undefined);

  writeConfig(`${baseConfig}allow_all_users: true\n`);
  await assert.rejects(makeManager().gateway(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(finalSpawns.length, 1, 'allow-all config must fail before gateway spawn');

  writeConfig(baseConfig.replace('platforms:\n  telegram:\n    enabled: true',
    'platforms:\n  telegram:\n    enabled: true\n  discord:\n    enabled: true'));
  await assert.rejects(makeManager().gateway(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(finalSpawns.length, 1, 'another enabled channel must fail before gateway spawn');

  writeConfig(baseConfig.replace('    enabled: true', "    enabled: true\n    extra:\n      allow_from: ['*']"));
  await assert.rejects(makeManager().gateway(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(finalSpawns.length, 1, 'Telegram adapter allowlists must fail before gateway spawn');

  writeConfig(baseConfig.replace('    enabled: true', "    enabled: true\n    extra:\n      group_allow_from: ['*']"));
  await assert.rejects(makeManager().gateway(), { code: 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED' });
  assert.equal(finalSpawns.length, 1, 'Telegram group adapter allowlists must fail before gateway spawn');
});
