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
const CHAT_CREDENTIAL_ENV = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY'
];
const HERMES_COMMANDS = {
  help: ['--help'],
  chat: ['chat', '--cli'],
  list_local_skills: ['skills', 'list', '--source', 'local']
};
const MODEL_PROVIDER_EXTRAS = new Map([
  ['anthropic', 'anthropic'],
  ['bedrock', 'bedrock'],
  ['vertex', 'vertex']
]);

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
      JSON.stringify(manifest.commands.list_local_skills) !== JSON.stringify(HERMES_COMMANDS.list_local_skills)) {
    throw fail('The pinned Hermes runtime manifest does not match the supported source revision.', 'SOMA_HERMES_MANIFEST_INVALID');
  }
  const runtime = manifest.runtime;
  for (const key of ['hermes_home', 'runtime_dir', 'user_home', 'working_directory', 'python_file']) {
    safeRelativePath(runtime[key], `runtime.${key}`);
  }
  if (runtime.hermes_home !== 'hermes-home' || runtime.runtime_dir !== 'hermes-tools' ||
      runtime.user_home !== 'user-home' || runtime.working_directory !== 'working-directory' ||
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
      typeof result.skill_loaded !== 'boolean' ||
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
    if (!/^3\.14\.\d+$/.test(result.python_version) || !result.cli_help || !result.skill_loaded) {
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
    skill_installed: result.skill_loaded
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
    forbiddenHomes: () => [path.join(os.homedir(), '.hermes')],
    environment(context) {
      const dirs = paths(context.runtimeHome);
      return {
        HERMES_HOME: dirs.hermesHome,
        HERMES_RUNTIME_DIR: dirs.runtimeDir,
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
    validateLaunch({ action, args }) {
      const allowed = {
        chat: [],
        help: [],
        configure: [],
        skills: []
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
      const operationArgs = action === 'chat' ? manifest.commands.chat
        : action === 'help' ? manifest.commands.help
          : action === 'configure' ? ['model']
            : action === 'skills' ? manifest.commands.list_local_skills
              : ['pm', 'install', '--extra', MODEL_PROVIDER_EXTRAS.get(args[0])];
      return {
        executable: pythonPath,
        args: [root.entrypoint, ...operationArgs],
        cwd: path.join(context.runtimeHome, root.runtime.working_directory)
      };
    }
  };
}
