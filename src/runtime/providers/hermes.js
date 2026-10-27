import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RuntimeError } from '../manager.js';

export const HERMES_SOURCE_REVISION = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e';
const HERMES_SOURCE_PATH = 'third_party/hermes-agent';
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024;
const MAX_SETUP_OUTPUT_BYTES = 4 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const GATEWAY_CONFIG_CHECK_TIMEOUT_MS = 20 * 1000;
const GATEWAY_CONFIG_CHECK_MAX_BYTES = 16 * 1024;
const CHAT_CREDENTIAL_ENV = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY'
];
const GATEWAY_CREDENTIAL_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS'];
const HERMES_COMMANDS = {
  help: ['--help'],
  chat: ['chat', '--cli'],
  list_local_skills: ['skills', 'list', '--source', 'local'],
  gateway: ['gateway', 'run', '--external-supervisor']
};
const MODEL_PROVIDER_EXTRAS = new Map([
  ['anthropic', 'anthropic'],
  ['bedrock', 'bedrock'],
  ['vertex', 'vertex']
]);

// Bootstrap only the pinned, isolated interpreter; the helper never resolves model metadata online.
const CONTEXT_POLICY_RUNNER = `
import hermes_bootstrap
import runpy
import sys
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

function contextPolicyResult(result) {
  const invalid = () => fail('The context policy helper failed. Check the policy JSON and isolated runtime configuration.',
    'SOMA_HERMES_CONTEXT_INVALID');
  if (result?.error || result?.signal || ![0, 2].includes(result?.status)) throw invalid();
  let payload;
  try { payload = JSON.parse(boundedString(result.stdout, 'SOMA_HERMES_OUTPUT_LIMIT')); } catch { throw invalid(); }
  if (result.status !== 0) {
    const messages = {
      invalid_policy: 'Context policy must match the documented schema and supported value ranges.',
      invalid_config: 'The isolated context configuration is invalid or uses unsafe file paths.',
      config_changed: 'Runtime configuration changed during this operation. Retry while configuration is idle.',
      budget_unavailable: 'Could not calculate context budgets with the pinned runtime. No policy changes were applied.'
    };
    throw fail(messages[payload?.error] || 'The context policy helper failed without applying changes.',
      'SOMA_HERMES_CONTEXT_INVALID');
  }
  const settings = payload?.policy?.compression;
  const budget = payload?.budget;
  const fields = ['enabled', 'threshold', 'threshold_tokens', 'target_ratio', 'tail_mode', 'protect_first_n',
    'protect_last_n', 'min_tail_user_messages', 'hygiene_hard_message_limit'];
  if (payload?.schema_version !== 1 || typeof payload?.changed !== 'boolean' || payload.policy?.schema_version !== 1 ||
      !settings || typeof settings !== 'object' || fields.some((key) => !Object.hasOwn(settings, key)) ||
      Object.keys(settings).length !== fields.length || typeof settings.enabled !== 'boolean' ||
      !['lean', 'legacy'].includes(settings.tail_mode) ||
      fields.filter((key) => !['enabled', 'tail_mode'].includes(key)).some((key) =>
        !(key === 'threshold_tokens' && settings[key] === null) && !Number.isFinite(settings[key])) ||
      !budget || !['window_required', 'route_required', 'configured_window', 'preview_window',
        'external_engine', 'native_compaction', 'disabled'].includes(budget.status)) throw invalid();
  const budgetFields = ['context_window', 'output_reservation', 'effective_threshold_ratio', 'trigger_tokens',
    'tail_budget_tokens', 'summary_max_tokens', 'gateway_trigger_tokens'];
  if (budgetFields.some((key) => budget[key] !== null && !Number.isFinite(budget[key]))) throw invalid();
  return {
    schema_version: 1,
    changed: payload.changed,
    policy: { schema_version: 1, compression: Object.fromEntries(fields.map((key) => [key, settings[key]])) },
    budget: { status: budget.status, ...Object.fromEntries(budgetFields.map((key) => [key, budget[key]])) }
  };
}

function fail(message, code) {
  return new RuntimeError(message, { code });
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\0') ||
      value.split(/[\\/]+/).includes('..')) {
    throw fail(`The pinned Hermes manifest has an invalid ${label}.`, 'SOMA_HERMES_MANIFEST_INVALID');
  }
  return value;
}

function readManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, 'runtimes', 'hermes', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw fail('The pinned Hermes runtime manifest is missing or invalid.', 'SOMA_HERMES_MANIFEST_INVALID');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schema_version !== 1 ||
      manifest.name !== 'hermes' || manifest.provider !== 'hermes' ||
      manifest.source_revision !== HERMES_SOURCE_REVISION || manifest.source_path !== HERMES_SOURCE_PATH ||
      !manifest.runtime || typeof manifest.runtime !== 'object' || Array.isArray(manifest.runtime) ||
      !manifest.commands || JSON.stringify(manifest.commands.help) !== JSON.stringify(HERMES_COMMANDS.help) ||
      JSON.stringify(manifest.commands.chat) !== JSON.stringify(HERMES_COMMANDS.chat) ||
      JSON.stringify(manifest.commands.list_local_skills) !== JSON.stringify(HERMES_COMMANDS.list_local_skills) ||
      JSON.stringify(manifest.commands.gateway) !== JSON.stringify(HERMES_COMMANDS.gateway) ||
      !manifest.assets || manifest.assets.soul_template !== 'runtimes/hermes/SOUL.md' ||
      manifest.assets.skill_source !== 'skills/soma-health' ||
      manifest.assets.skill_destination !== 'hermes-home/skills/soma-health' ||
      manifest.assets.action_skill_source !== 'skills/soma-health-actions' ||
      manifest.assets.action_skill_destination !== 'hermes-home/skills/soma-health-actions' ||
      !manifest.gateway_dependencies || manifest.gateway_dependencies.extra !== 'telegram' ||
      manifest.gateway_dependencies.telegram_package !== 'python-telegram-bot' ||
      manifest.gateway_dependencies.telegram_version !== '22.8') {
    throw fail('The pinned Hermes runtime manifest does not match the supported source revision.', 'SOMA_HERMES_MANIFEST_INVALID');
  }
  const runtime = manifest.runtime;
  for (const key of ['hermes_home', 'runtime_dir', 'user_home', 'working_directory', 'python_file', 'managed_dir']) {
    safeRelativePath(runtime[key], `runtime.${key}`);
  }
  if (runtime.hermes_home !== 'hermes-home' || runtime.runtime_dir !== 'hermes-tools' ||
      runtime.user_home !== 'user-home' || runtime.working_directory !== 'working-directory' ||
      runtime.managed_dir !== 'hermes-managed' ||
      runtime.python_file !== 'hermes-python.txt') {
    throw fail('The pinned Hermes runtime manifest has an invalid runtime directory.', 'SOMA_HERMES_MANIFEST_INVALID');
  }
  const sourceRoot = path.resolve(repoRoot, HERMES_SOURCE_PATH);
  const setupScript = path.resolve(repoRoot, 'runtimes', 'hermes', 'setup.sh');
  const checkScript = path.resolve(repoRoot, 'runtimes', 'hermes', 'check.sh');
  const entrypoint = path.join(sourceRoot, 'hermes');
  return { manifest, runtime, sourceRoot, setupScript, checkScript, entrypoint };
}

function assertNoSourceDotenv(sourceRoot) {
  try {
    fs.lstatSync(path.join(sourceRoot, '.env'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw fail('Could not safely inspect the pinned Hermes source configuration.', 'SOMA_HERMES_SOURCE_INVALID');
  }
  throw fail('The pinned Hermes source contains a .env file. Remove it before using this runtime.', 'SOMA_HERMES_SOURCE_ENV_BLOCKED');
}

function sourceFiles(root) {
  const { manifest, sourceRoot, setupScript, checkScript, entrypoint } = root;
  assertNoSourceDotenv(sourceRoot);
  for (const file of [sourceRoot, entrypoint, setupScript, checkScript]) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      throw fail('The pinned Hermes runtime source or helper is unavailable.', 'SOMA_HERMES_SOURCE_INVALID');
    }
    if (stat.isSymbolicLink() || (file === sourceRoot ? !stat.isDirectory() : !stat.isFile())) {
      throw fail('The pinned Hermes runtime source or helper is unavailable.', 'SOMA_HERMES_SOURCE_INVALID');
    }
  }
  return manifest;
}

function invokeScript({ executable, args, cwd, env, timeout, outputMode, run, stderrSink }) {
  let result;
  try {
    result = run(executable, args, {
      cwd,
      env,
      shell: false,
      encoding: 'utf8',
      timeout,
      maxBuffer: outputMode === 'setup' ? MAX_SETUP_OUTPUT_BYTES : MAX_CHECK_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw fail('Could not run the pinned Hermes helper.', 'SOMA_HERMES_HELPER_FAILED');
  }
  if (result?.error) {
    if (result.error.code === 'ETIMEDOUT') throw fail('The Hermes helper timed out.', 'SOMA_HERMES_HELPER_TIMEOUT');
    if (result.error.code === 'ENOBUFS') throw fail('The Hermes helper exceeded its output limit.', 'SOMA_HERMES_OUTPUT_LIMIT');
    throw fail('Could not run the pinned Hermes helper.', 'SOMA_HERMES_HELPER_FAILED');
  }
  if (result?.signal) throw fail('The Hermes helper stopped unexpectedly.', 'SOMA_HERMES_HELPER_FAILED');
  const outputLimit = outputMode === 'setup' ? MAX_SETUP_OUTPUT_BYTES : MAX_CHECK_OUTPUT_BYTES;
  const stdout = boundedString(result?.stdout, 'SOMA_HERMES_OUTPUT_LIMIT', outputLimit);
  const stderr = boundedString(result?.stderr, 'SOMA_HERMES_OUTPUT_LIMIT', outputLimit);
  if (outputMode === 'setup') {
    if (stderr !== '') stderrSink?.write(stderr);
    if (result?.status !== 0) throw fail('The pinned Hermes setup helper reported that setup failed.', 'SOMA_HERMES_SETUP_FAILED');
    if (stdout.trim() !== '') throw fail('The Hermes setup helper returned unexpected standard output.', 'SOMA_HERMES_SETUP_OUTPUT_INVALID');
    return '';
  }
  if (result?.status !== 0 && result?.status !== 1) {
    throw fail('The pinned Hermes compatibility check failed unexpectedly.', 'SOMA_HERMES_HELPER_FAILED');
  }
  return stdout;
}

function boundedString(value, code, maxBytes = MAX_CHECK_OUTPUT_BYTES) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw fail('The Hermes helper output was invalid or exceeded its output limit.', code);
  }
  return value;
}

function parseCheck(stdout, manifest) {
  const content = boundedString(stdout, 'SOMA_HERMES_OUTPUT_LIMIT').trim();
  if (!content || content.includes('\n') || content.includes('\r')) {
    throw fail('The Hermes compatibility check returned an invalid response.', 'SOMA_HERMES_CHECK_INVALID');
  }
  let result;
  try { result = JSON.parse(content); } catch {
    throw fail('The Hermes compatibility check returned an invalid response.', 'SOMA_HERMES_CHECK_INVALID');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.ok !== 'boolean' || result.provider !== 'hermes' ||
      typeof result.source_commit !== 'string' || typeof result.source_clean !== 'boolean' ||
      typeof result.python_version !== 'string' || typeof result.cli_help !== 'boolean' ||
      typeof result.skill_loaded !== 'boolean' || typeof result.telegram_sdk !== 'boolean' ||
      typeof result.gateway_authz !== 'boolean' ||
      (result.error !== null && typeof result.error !== 'string')) {
    throw fail('The Hermes compatibility check returned an invalid response.', 'SOMA_HERMES_CHECK_INVALID');
  }
  const errorStatus = validStatusCode(result.error);
  if ((result.source_commit && result.source_commit !== manifest.source_revision) || errorStatus === 'source_revision_mismatch') {
    throw fail('The installed Hermes runtime does not match the pinned source revision.', 'SOMA_HERMES_REVISION_MISMATCH');
  }
  if (errorStatus === 'source_dirty') {
    throw fail('The pinned Hermes runtime has modified executable source files.', 'SOMA_HERMES_SOURCE_DIRTY');
  }
  if (errorStatus === 'source_env_present') {
    throw fail('The pinned Hermes source contains a .env file. Remove it before using this runtime.', 'SOMA_HERMES_SOURCE_ENV_BLOCKED');
  }
  if (result.ok) {
    if (result.source_commit !== manifest.source_revision) {
      throw fail('The installed Hermes runtime does not match the pinned source revision.', 'SOMA_HERMES_REVISION_MISMATCH');
    }
    if (!result.source_clean || (result.error !== null && result.error !== '')) {
      throw fail('The Hermes compatibility check returned inconsistent readiness data.', 'SOMA_HERMES_CHECK_INVALID');
    }
    if (!/^3\.14\.\d+$/.test(result.python_version) || !result.cli_help || !result.skill_loaded ||
        !result.telegram_sdk || !result.gateway_authz) {
      throw fail('The Hermes compatibility check returned unsupported success data.', 'SOMA_HERMES_CHECK_INVALID');
    }
  } else {
    return {
      ready: false,
      status: errorStatus || 'not_ready',
      version: manifest.upstream?.tag || 'pinned',
      source_revision: manifest.source_revision,
      python_version: result.python_version
    };
  }
  return {
    ready: true,
    status: 'ready',
    version: manifest.upstream?.tag || 'pinned',
    source_revision: manifest.source_revision,
    python_version: result.python_version,
    skill_installed: result.skill_loaded,
    telegram_sdk: result.telegram_sdk,
    gateway_authz: result.gateway_authz
  };
}

function validStatusCode(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value.toLowerCase() : null;
}

function readPythonPath(context, pythonFile, runtimeDirectory) {
  const filename = path.resolve(context.runtimeHome, pythonFile);
  let stat;
  try { stat = fs.lstatSync(filename); } catch {
    throw fail('The managed Hermes Python interpreter is unavailable. Run runtime setup.', 'SOMA_HERMES_PYTHON_MISSING');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw fail('The managed Hermes Python interpreter path is invalid.', 'SOMA_HERMES_PYTHON_INVALID');
  }
  let value;
  try { value = fs.readFileSync(filename, 'utf8').trim(); } catch {
    throw fail('The managed Hermes Python interpreter path is invalid.', 'SOMA_HERMES_PYTHON_INVALID');
  }
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail('The managed Hermes Python interpreter path is invalid.', 'SOMA_HERMES_PYTHON_INVALID');
  }
  const home = fs.realpathSync(context.runtimeHome);
  let executable;
  try { executable = fs.realpathSync(value); } catch {
    throw fail('The managed Hermes Python interpreter is unavailable. Run runtime setup.', 'SOMA_HERMES_PYTHON_MISSING');
  }
  const toolsPath = path.resolve(context.runtimeHome, runtimeDirectory);
  let toolsStat;
  try { toolsStat = fs.lstatSync(toolsPath); } catch {
    throw fail('The managed Hermes runtime tools are unavailable. Run runtime setup.', 'SOMA_HERMES_PYTHON_MISSING');
  }
  if (!toolsStat.isDirectory() || toolsStat.isSymbolicLink()) {
    throw fail('The managed Hermes runtime tools path is invalid.', 'SOMA_HERMES_PYTHON_INVALID');
  }
  const canonicalTools = fs.realpathSync(toolsPath);
  const relative = path.relative(home, executable);
  const toolsRelative = path.relative(canonicalTools, executable);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      toolsRelative === '..' || toolsRelative.startsWith(`..${path.sep}`) || path.isAbsolute(toolsRelative) ||
      !fs.statSync(executable).isFile()) {
    throw fail('The managed Hermes Python interpreter is outside SOMA_RUNTIME_HOME.', 'SOMA_HERMES_PYTHON_INVALID');
  }
  return executable;
}

const GATEWAY_CONFIG_CHECK = String.raw`import hermes_bootstrap
import json, os, sys
from pathlib import Path

def refuse(code):
    print(json.dumps({"ok": False, "code": code}))
    raise SystemExit(0)

try:
    from gateway.config import Platform, load_gateway_config
    from gateway.config_loader import read_yaml_layers
    home = Path(os.environ["HERMES_HOME"])
    raw = read_yaml_layers(home)
    if raw.get("secrets"):
        refuse("external_secret_sources")
    model = raw.get("model")
    if not isinstance(model, dict) or not isinstance(model.get("provider"), str) or not model["provider"].strip() or \
            model["provider"].strip().lower() == "auto" or not isinstance(model.get("default"), str) or \
            not model["default"].strip() or set(model) - {"provider", "default"}:
        refuse("model_provider_config_invalid")
    config = load_gateway_config()
except Exception:
    refuse("configuration_unreadable")

def truthy(name):
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}

if truthy("GATEWAY_ALLOW_ALL_USERS") or truthy("TELEGRAM_ALLOW_ALL_USERS"):
    refuse("allow_all_enabled")
if config.profile_routes:
    refuse("profile_routes_enabled")
for platform, item in config.platforms.items():
    if platform == Platform.TELEGRAM:
        continue
    if item.enabled or item.token or item.api_key or item.home_channel or item.extra:
        refuse("non_telegram_platform_configured")
telegram = config.platforms.get(Platform.TELEGRAM)
if telegram is None or not telegram.enabled or not telegram.token:
    refuse("telegram_not_enabled")
extra = telegram.extra if isinstance(telegram.extra, dict) else {}
if set(extra) - {"unauthorized_dm_behavior"}:
    refuse("telegram_extra_config_not_allowed")
if telegram.api_key or telegram.home_channel or telegram.channel_overrides:
    refuse("telegram_nonminimal_config")
if config.get_unauthorized_dm_behavior(Platform.TELEGRAM) != "ignore" or \
        extra.get("unauthorized_dm_behavior") not in (None, "ignore"):
    refuse("unauthorized_dm_behavior_not_ignore")
print(json.dumps({"ok": True}))`;

function validateTelegramCredentials(env) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === 'string' ? env.TELEGRAM_BOT_TOKEN.trim() : '';
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw fail('Gateway requires a non-placeholder Telegram bot token in the private service environment.',
      'SOMA_HERMES_GATEWAY_TELEGRAM_TOKEN_REQUIRED');
  }
  const allowlist = typeof env.TELEGRAM_ALLOWED_USERS === 'string' ? env.TELEGRAM_ALLOWED_USERS.trim() : '';
  const users = allowlist.split(',').map((value) => value.trim());
  if (!allowlist || users.some((user) => !/^\d+$/.test(user) || BigInt(user) <= 0n) ||
      new Set(users).size !== users.length) {
    throw fail('Gateway requires a comma-separated allowlist of positive numeric Telegram user IDs.',
      'SOMA_HERMES_GATEWAY_TELEGRAM_ALLOWLIST_REQUIRED');
  }
  if (['GATEWAY_ALLOW_ALL_USERS', 'TELEGRAM_ALLOW_ALL_USERS'].some((key) => {
    const value = typeof env[key] === 'string' ? env[key].trim().toLowerCase() : '';
    return ['1', 'true', 'yes', 'on'].includes(value);
  })) {
    throw fail('Gateway refuses all-users authorization overrides.', 'SOMA_HERMES_GATEWAY_ALLOW_ALL_BLOCKED');
  }
}

function assertPrivateGatewayFiles(context, runtime) {
  const runtimeHome = fs.realpathSync(context.runtimeHome);
  const home = path.resolve(runtimeHome, runtime.hermes_home);
  const managed = path.resolve(runtimeHome, runtime.managed_dir);
  for (const directory of [home, managed]) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch {
      throw fail('The isolated Hermes gateway configuration directory is missing. Run runtime setup.',
        'SOMA_HERMES_GATEWAY_HOME_INVALID');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !isPathInside(fs.realpathSync(directory), runtimeHome)) {
      throw fail('The isolated Hermes gateway configuration directory is invalid.',
        'SOMA_HERMES_GATEWAY_HOME_INVALID');
    }
  }
  for (const directory of [home, managed]) {
    for (const name of ['.env', '.op.env']) {
      try { fs.lstatSync(path.join(directory, name)); } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw fail('Could not safely inspect isolated Hermes secret files.', 'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED');
      }
      throw fail('Gateway refuses unmanaged Hermes environment or secret-source files; use the private systemd environment file.',
        'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED');
    }
  }
  const profiles = path.join(home, 'profiles');
  try {
    const stat = fs.lstatSync(profiles);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(profiles).length > 0) {
      throw fail('Gateway refuses Hermes named profiles in its isolated home.', 'SOMA_HERMES_GATEWAY_PROFILES_BLOCKED');
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error?.code !== 'ENOENT') {
      throw fail('Could not safely inspect isolated Hermes profiles.', 'SOMA_HERMES_GATEWAY_PROFILES_BLOCKED');
    }
  }
  if (context.env.HERMES_HOME !== home || context.env.HERMES_MANAGED_DIR !== managed ||
      context.env.HOME !== path.resolve(runtimeHome, runtime.user_home)) {
    throw fail('Gateway environment paths must remain inside the managed SOMA runtime.',
      'SOMA_HERMES_GATEWAY_HOME_INVALID');
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateGatewayLaunch({ context, root, pythonPath, run }) {
  validateTelegramCredentials(context.env || {});
  assertPrivateGatewayFiles(context, root.runtime);
  let result;
  try {
    result = run(pythonPath, ['-c', GATEWAY_CONFIG_CHECK], {
      cwd: root.sourceRoot,
      env: context.env,
      shell: false,
      encoding: 'utf8',
      timeout: GATEWAY_CONFIG_CHECK_TIMEOUT_MS,
      maxBuffer: GATEWAY_CONFIG_CHECK_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw fail('Could not verify the isolated Telegram gateway configuration.', 'SOMA_HERMES_GATEWAY_CONFIG_INVALID');
  }
  if (result?.error || result?.signal || result?.status !== 0 || typeof result?.stdout !== 'string' ||
      Buffer.byteLength(result.stdout, 'utf8') > GATEWAY_CONFIG_CHECK_MAX_BYTES) {
    throw fail('Could not verify the isolated Telegram gateway configuration.', 'SOMA_HERMES_GATEWAY_CONFIG_INVALID');
  }
  let policy;
  try { policy = JSON.parse(result.stdout.trim()); } catch {
    throw fail('The isolated Telegram gateway configuration check returned invalid data.',
      'SOMA_HERMES_GATEWAY_CONFIG_INVALID');
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.ok !== true) {
    throw fail('The isolated Hermes configuration enables another channel or weakens Telegram authorization.',
      'SOMA_HERMES_GATEWAY_CONFIG_BLOCKED');
  }
}

export function createHermesProvider({ repoRoot, spawnSyncImpl = spawnSync, stderr = process.stderr } = {}) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || typeof spawnSyncImpl !== 'function') {
    throw fail('The Hermes runtime provider configuration is invalid.', 'SOMA_HERMES_PROVIDER_INVALID');
  }
  const root = readManifest(path.resolve(repoRoot));
  const manifest = root.manifest;
  const paths = (runtimeHome) => ({
    hermesHome: path.resolve(runtimeHome, root.runtime.hermes_home),
    runtimeDir: path.resolve(runtimeHome, root.runtime.runtime_dir)
  });

  return {
    name: 'hermes',
    sourceRevision: HERMES_SOURCE_REVISION,
    chatCredentialEnv: CHAT_CREDENTIAL_ENV,
    gatewayCredentialEnv: GATEWAY_CREDENTIAL_ENV,
    forbiddenHomes: () => [path.join(os.homedir(), '.hermes')],
    environment(context) {
      const dirs = paths(context.runtimeHome);
      return {
        HERMES_HOME: dirs.hermesHome,
        HERMES_RUNTIME_DIR: dirs.runtimeDir,
        HERMES_MANAGED_DIR: path.resolve(context.runtimeHome, root.runtime.managed_dir),
        HERMES_DISABLE_LAZY_INSTALLS: '1'
      };
    },
    async setup(context) {
      sourceFiles(root);
      invokeScript({
        executable: 'bash', args: [root.setupScript], cwd: path.resolve(repoRoot), env: context.env,
        timeout: SETUP_TIMEOUT_MS, outputMode: 'setup', run: spawnSyncImpl, stderrSink: stderr
      });
      return { ready: true, status: 'setup_complete', source_revision: manifest.source_revision };
    },
    async inspect(context) {
      sourceFiles(root);
      const stdout = invokeScript({
        executable: 'bash', args: [root.checkScript], cwd: path.resolve(repoRoot), env: context.env,
        timeout: CHECK_TIMEOUT_MS, outputMode: 'check', run: spawnSyncImpl
      });
      return parseCheck(stdout, manifest);
    },
    async contextPolicy({ context, file, contextWindow }) {
      sourceFiles(root);
      if ((file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) ||
          (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > 10000000))) {
        throw fail('Invalid context policy file or preview window.', 'SOMA_HERMES_CONTEXT_INVALID');
      }
      const helper = path.resolve(repoRoot, 'runtimes/hermes/context-policy.py');
      let stat;
      try { stat = fs.lstatSync(helper); } catch { throw fail('The context policy helper is missing.', 'SOMA_HERMES_CONTEXT_INVALID'); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('The context policy helper is invalid.', 'SOMA_HERMES_CONTEXT_INVALID');
      const python = readPythonPath(context, root.runtime.python_file, root.runtime.runtime_dir);
      const args = ['-B', '-c', CONTEXT_POLICY_RUNNER, helper];
      if (file !== undefined) args.push('--file', file);
      if (contextWindow !== undefined) args.push('--context-window', String(contextWindow));
      let result;
      try {
        result = spawnSyncImpl(python, args, {
          cwd: root.sourceRoot, env: context.env, shell: false, encoding: 'utf8',
          timeout: GATEWAY_CONFIG_CHECK_TIMEOUT_MS, maxBuffer: MAX_CHECK_OUTPUT_BYTES,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch { throw fail('Could not run the context policy helper.', 'SOMA_HERMES_CONTEXT_INVALID'); }
      return contextPolicyResult(result);
    },
    validateLaunch({ action, args }) {
      const allowed = {
        chat: [],
        help: [],
        configure: [],
        skills: [],
        gateway: []
      };
      if (action === 'provider-dependencies') {
        if (args.length !== 1 || !MODEL_PROVIDER_EXTRAS.has(args[0])) {
          throw fail('The selected Hermes model provider has no supported optional dependency install.',
            'SOMA_HERMES_PROVIDER_DEPENDENCIES_UNSUPPORTED');
        }
      } else if (!Object.hasOwn(allowed, action) || JSON.stringify(args) !== JSON.stringify(allowed[action])) {
        throw fail('This Hermes operation is not available through SOMA.', 'SOMA_HERMES_OPERATION_BLOCKED');
      }
      if (args.some((arg) => arg === '-p' || arg === '--profile' || arg.startsWith('--profile='))) {
        throw fail('Hermes profile overrides are disabled; use the isolated managed profile.', 'SOMA_HERMES_PROFILE_OVERRIDE_BLOCKED');
      }
    },
    async launch({ action, args, context }) {
      sourceFiles(root);
      const pythonPath = readPythonPath(context, root.runtime.python_file, root.runtime.runtime_dir);
      if (action === 'gateway') validateGatewayLaunch({ context, root, pythonPath, run: spawnSyncImpl });
      const operationArgs = action === 'chat' ? manifest.commands.chat
        : action === 'help' ? manifest.commands.help
          : action === 'configure' ? ['model']
            : action === 'skills' ? manifest.commands.list_local_skills
              : action === 'gateway' ? manifest.commands.gateway
              : ['pm', 'install', '--extra', MODEL_PROVIDER_EXTRAS.get(args[0])];
      return {
        executable: pythonPath,
        args: [root.entrypoint, ...operationArgs],
        cwd: path.join(context.runtimeHome, root.runtime.working_directory)
      };
    }
  };
}
