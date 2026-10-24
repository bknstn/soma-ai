import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_HOME_MARKER = '.soma-runtime.json';
export const RUNTIME_HOME_SCHEMA_VERSION = 1;

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAFE_ENV_KEYS = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'NO_COLOR',
  'SystemRoot', 'WINDIR', 'PATHEXT'
];
const ISOLATION_ENV_KEY = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_[A-Z0-9_]+|SOMA_[A-Z0-9_]+|HEALTH_OS_[A-Z0-9_]+|HERMES_[A-Z0-9_]+)$/;
const MANAGER_ENV_KEY = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_[A-Z0-9_]+|SOMA_[A-Z0-9_]+|HEALTH_OS_[A-Z0-9_]+)$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_MARKER_BYTES = 8 * 1024;

export class RuntimeError extends Error {
  constructor(message, { code = 'SOMA_RUNTIME_ERROR', exitCode = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function canonicalMaybeMissing(inputPath, label) {
  let current = path.resolve(inputPath);
  const suffix = [];
  while (true) {
    try {
      const stat = fs.statSync(current);
      if (suffix.length > 0 && !stat.isDirectory()) {
        throw new RuntimeError(`${label} has a non-directory parent.`, { code: 'SOMA_RUNTIME_PATH_INVALID' });
      }
      return path.resolve(fs.realpathSync(current), ...suffix.reverse());
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new RuntimeError(`Could not resolve ${label}.`, { code: 'SOMA_RUNTIME_PATH_INVALID', cause: error });
      }
      const parent = path.dirname(current);
      if (parent === current) throw new RuntimeError(`Could not resolve ${label}.`, { code: 'SOMA_RUNTIME_PATH_INVALID' });
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function canonicalRuntimeHomePath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RuntimeError('The runtime home must be a real directory, not a file or symlink.', {
        code: 'SOMA_RUNTIME_HOME_INVALID'
      });
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new RuntimeError('Could not inspect the configured runtime home.', { code: 'SOMA_RUNTIME_HOME_INVALID', cause: error });
    }
  }
  return canonicalMaybeMissing(absolutePath, 'runtime home');
}

function validateManagedDirectory(runtimeHome, name, { create = false } = {}) {
  const directory = path.join(runtimeHome, name);
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new RuntimeError('Could not inspect a managed runtime directory.', { code: 'SOMA_RUNTIME_HOME_INVALID', cause: error });
    }
    if (!create) return false;
    try {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
      stat = fs.lstatSync(directory);
    } catch (createError) {
      throw new RuntimeError('Could not create a managed runtime directory.', { code: 'SOMA_RUNTIME_HOME_INVALID', cause: createError });
    }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RuntimeError('A managed runtime directory is not a private directory.', { code: 'SOMA_RUNTIME_HOME_INVALID' });
  }
  const canonicalHome = fs.realpathSync(runtimeHome);
  const canonicalDirectory = fs.realpathSync(directory);
  if (!isInside(canonicalDirectory, canonicalHome)) {
    throw new RuntimeError('A managed runtime directory escapes SOMA_RUNTIME_HOME.', { code: 'SOMA_RUNTIME_HOME_UNSAFE' });
  }
  return true;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value.trim())) {
    throw new RuntimeError(`${label} must be an explicit absolute path.`, { code: 'SOMA_RUNTIME_PATH_REQUIRED' });
  }
  return path.resolve(value.trim());
}

function minimalEnvironment(source, runtimeHome, runtimeName, operation, provider, contextBase) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  const privateHome = path.join(runtimeHome, 'user-home');
  env.HOME = privateHome;
  env.USERPROFILE = privateHome;
  env.APPDATA = path.join(privateHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(privateHome, 'AppData', 'Local');
  env.XDG_CONFIG_HOME = path.join(privateHome, '.config');
  env.XDG_DATA_HOME = path.join(privateHome, '.local', 'share');
  env.XDG_CACHE_HOME = path.join(privateHome, '.cache');
  env.XDG_STATE_HOME = path.join(privateHome, '.local', 'state');
  env.SOMA_RUNTIME = runtimeName;
  env.SOMA_RUNTIME_HOME = runtimeHome;
  env.SOMA_REPO = contextBase.repoRoot;
  env.SOMA_RUNTIME_OPERATION = operation;
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(privateHome).root.replace(/[\\/]+$/, '');
    env.HOMEPATH = privateHome.slice(env.HOMEDRIVE.length) || path.sep;
  }
  if (typeof provider.environment === 'function') {
    const additions = provider.environment({ ...contextBase, env: { ...env } });
    if (!additions || typeof additions !== 'object' || Array.isArray(additions)) {
      throw new RuntimeError(`Runtime provider "${runtimeName}" returned an invalid environment.`, {
        code: 'SOMA_RUNTIME_PROVIDER_INVALID'
      });
    }
    for (const [key, value] of Object.entries(additions)) {
      if (typeof key !== 'string' || typeof value !== 'string' || key.trim() === '' ||
          MANAGER_ENV_KEY.test(key) ||
          SAFE_ENV_KEYS.includes(key)) {
        throw new RuntimeError(`Runtime provider "${runtimeName}" attempted to override a protected environment value.`, {
          code: 'SOMA_RUNTIME_PROVIDER_INVALID'
        });
      }
      env[key] = value;
    }
  }
  return env;
}

function readMarker(runtimeHome) {
  let homeStat;
  try {
    homeStat = fs.lstatSync(runtimeHome);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw new RuntimeError('Could not inspect the configured runtime home.', { code: 'SOMA_RUNTIME_HOME_INVALID', cause: error });
  }
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new RuntimeError('The runtime home must be a real directory, not a file or symlink.', { code: 'SOMA_RUNTIME_HOME_INVALID' });
  }

  const markerPath = path.join(runtimeHome, RUNTIME_HOME_MARKER);
  let markerStat;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new RuntimeError('Could not inspect the runtime marker.', { code: 'SOMA_RUNTIME_MARKER_INVALID', cause: error });
    return fs.readdirSync(runtimeHome).length === 0 ? { kind: 'empty' } : { kind: 'unmanaged' };
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > MAX_MARKER_BYTES) {
    throw new RuntimeError('The SOMA runtime marker is invalid.', { code: 'SOMA_RUNTIME_MARKER_INVALID' });
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new RuntimeError('The SOMA runtime marker is invalid.', { code: 'SOMA_RUNTIME_MARKER_INVALID', cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema_version !== RUNTIME_HOME_SCHEMA_VERSION || value.managed_by !== 'soma-ai' ||
      typeof value.runtime !== 'string' || typeof value.source_revision !== 'string' ||
      !['setting_up', 'setup_failed', 'ready'].includes(value.setup_status)) {
    throw new RuntimeError('The SOMA runtime marker has an unsupported schema or state.', { code: 'SOMA_RUNTIME_MARKER_INVALID' });
  }
  return { kind: 'managed', value };
}

function writeMarker(runtimeHome, data) {
  const markerPath = path.join(runtimeHome, RUNTIME_HOME_MARKER);
  const tempPath = path.join(runtimeHome, `${RUNTIME_HOME_MARKER}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, markerPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the write failure */ }
    throw new RuntimeError('Could not update SOMA runtime setup state.', { code: 'SOMA_RUNTIME_MARKER_WRITE_FAILED', cause: error });
  }
}

function validateProvider(provider, runtimeName) {
  if (!provider || typeof provider !== 'object' || provider.name !== runtimeName ||
      typeof provider.sourceRevision !== 'string' || provider.sourceRevision.length < 7 ||
      typeof provider.setup !== 'function' || typeof provider.inspect !== 'function' ||
      typeof provider.launch !== 'function' ||
      (provider.environment !== undefined && typeof provider.environment !== 'function') ||
      (provider.validateLaunch !== undefined && typeof provider.validateLaunch !== 'function')) {
    throw new RuntimeError(`Runtime provider "${runtimeName}" has an invalid provider contract.`, {
      code: 'SOMA_RUNTIME_PROVIDER_INVALID'
    });
  }
  const credentials = provider.chatCredentialEnv || [];
  if (!Array.isArray(credentials) || credentials.some((key) => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      SAFE_ENV_KEYS.includes(key) || ISOLATION_ENV_KEY.test(key))) {
    throw new RuntimeError(`Runtime provider "${runtimeName}" has an invalid chat credential allowlist.`, {
      code: 'SOMA_RUNTIME_PROVIDER_INVALID'
    });
  }
  const gatewayCredentials = provider.gatewayCredentialEnv || [];
  if (!Array.isArray(gatewayCredentials) || gatewayCredentials.some((key) => typeof key !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(key) || SAFE_ENV_KEYS.includes(key) || ISOLATION_ENV_KEY.test(key))) {
    throw new RuntimeError(`Runtime provider "${runtimeName}" has an invalid gateway credential allowlist.`, {
      code: 'SOMA_RUNTIME_PROVIDER_INVALID'
    });
  }
  if (provider.forbiddenHomes !== undefined && typeof provider.forbiddenHomes !== 'function' &&
      (!Array.isArray(provider.forbiddenHomes) || provider.forbiddenHomes.some((home) => typeof home !== 'string' || !path.isAbsolute(home)))) {
    throw new RuntimeError(`Runtime provider "${runtimeName}" has an invalid forbidden-home policy.`, {
      code: 'SOMA_RUNTIME_PROVIDER_INVALID'
    });
  }
  return provider;
}

function validateLaunchSpec(spec, runtimeHome) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.executable !== 'string' ||
      spec.executable.trim() === '' || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string') ||
      (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)))) {
    throw new RuntimeError('The runtime provider returned an invalid launch request.', { code: 'SOMA_RUNTIME_LAUNCH_INVALID' });
  }
  const cwd = path.resolve(spec.cwd || runtimeHome);
  const canonicalHome = canonicalMaybeMissing(runtimeHome, 'runtime home');
  const canonicalCwd = canonicalMaybeMissing(cwd, 'runtime working directory');
  if (!isInside(canonicalCwd, canonicalHome)) {
    throw new RuntimeError('The runtime working directory must stay inside SOMA_RUNTIME_HOME.', {
      code: 'SOMA_RUNTIME_CWD_UNSAFE'
    });
  }
  return { ...spec, cwd: canonicalCwd };
}

export class RuntimeManager {
  #runtimeName;
  #runtimeHome;
  #env;
  #provider;
  #repoRoot;
  #spawnProcess;
  #signalSource;

  constructor({ runtime, runtimeHome, env = process.env, providers = {}, repoRoot = moduleRoot, spawnProcess = spawn,
    signalSource = process } = {}) {
    this.#runtimeName = runtime ?? env.SOMA_RUNTIME ?? 'hermes';
    if (typeof this.#runtimeName !== 'string' || !SAFE_SLUG.test(this.#runtimeName)) {
      throw new RuntimeError('SOMA_RUNTIME must be a valid provider name.', { code: 'SOMA_RUNTIME_NAME_INVALID' });
    }
    const provider = providers instanceof Map ? providers.get(this.#runtimeName) : providers[this.#runtimeName];
    if (!provider) {
      throw new RuntimeError(`Unsupported agent runtime "${this.#runtimeName}".`, { code: 'SOMA_RUNTIME_UNSUPPORTED', exitCode: 2 });
    }
    this.#provider = validateProvider(provider, this.#runtimeName);
    const selectedHome = runtimeHome ?? env.SOMA_RUNTIME_HOME;
    this.#runtimeHome = selectedHome === undefined || selectedHome === null || selectedHome === ''
      ? null
      : requireAbsolutePath(selectedHome, 'SOMA_RUNTIME_HOME');
    this.#env = env;
    this.#repoRoot = path.resolve(repoRoot);
    if (typeof spawnProcess !== 'function') {
      throw new RuntimeError('The runtime process runner is invalid.', { code: 'SOMA_RUNTIME_PROVIDER_INVALID' });
    }
    if (!signalSource || typeof signalSource.on !== 'function' || typeof signalSource.off !== 'function') {
      throw new RuntimeError('The runtime signal source is invalid.', { code: 'SOMA_RUNTIME_PROVIDER_INVALID' });
    }
    this.#spawnProcess = spawnProcess;
    this.#signalSource = signalSource;
  }

  get runtimeName() {
    return this.#runtimeName;
  }

  async setup() {
    const context = this.#context({ operation: 'setup' });
    const current = readMarker(context.runtimeHome);
    if (current.kind === 'unmanaged') {
      throw new RuntimeError('Refusing to set up into a populated, unmanaged runtime home. Choose a new empty path.', {
        code: 'SOMA_RUNTIME_HOME_UNMANAGED'
      });
    }
    if (current.kind === 'managed' && (current.value.runtime !== this.#runtimeName ||
        current.value.source_revision !== this.#provider.sourceRevision)) {
      throw new RuntimeError('The runtime home belongs to a different provider or pinned source revision.', {
        code: 'SOMA_RUNTIME_HOME_MISMATCH'
      });
    }
    if (current.kind === 'missing') fs.mkdirSync(context.runtimeHome, { recursive: true, mode: 0o700 });
    validateManagedDirectory(context.runtimeHome, 'user-home', { create: true });
    validateManagedDirectory(context.runtimeHome, 'working-directory', { create: true });
    const createdAt = current.kind === 'managed' ? current.value.created_at : new Date().toISOString();
    writeMarker(context.runtimeHome, {
      schema_version: RUNTIME_HOME_SCHEMA_VERSION,
      managed_by: 'soma-ai',
      runtime: this.#runtimeName,
      source_revision: this.#provider.sourceRevision,
      setup_status: 'setting_up',
      created_at: createdAt,
      updated_at: new Date().toISOString()
    });
    try {
      const result = await this.#provider.setup(context);
      const inspection = await this.#provider.inspect(context);
      if (!inspection || inspection.ready !== true) {
        const status = typeof inspection?.status === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(inspection.status)
          ? ` (${inspection.status})` : '';
        throw new RuntimeError(`Runtime setup finished without a ready status${status}.`, {
          code: 'SOMA_RUNTIME_SETUP_INCOMPLETE'
        });
      }
      writeMarker(context.runtimeHome, {
        schema_version: RUNTIME_HOME_SCHEMA_VERSION,
        managed_by: 'soma-ai',
        runtime: this.#runtimeName,
        source_revision: this.#provider.sourceRevision,
        setup_status: 'ready',
        created_at: createdAt,
        updated_at: new Date().toISOString()
      });
      return { runtime: this.#runtimeName, status: 'ready', result: safeResult(result) };
    } catch (error) {
      writeMarker(context.runtimeHome, {
        schema_version: RUNTIME_HOME_SCHEMA_VERSION,
        managed_by: 'soma-ai',
        runtime: this.#runtimeName,
        source_revision: this.#provider.sourceRevision,
        setup_status: 'setup_failed',
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        last_error_code: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'SOMA_RUNTIME_SETUP_FAILED'
      });
      throw error instanceof RuntimeError ? error : new RuntimeError('Runtime setup failed. Check the local setup output.', {
        code: 'SOMA_RUNTIME_SETUP_FAILED', cause: error
      });
    }
  }

  async inspect() {
    const context = this.#context({ operation: 'inspect' });
    const marker = readMarker(context.runtimeHome);
    if (marker.kind === 'missing' || marker.kind === 'empty') {
      return { runtime: this.#runtimeName, status: 'not_setup', ready: false, source_revision: this.#provider.sourceRevision };
    }
    if (marker.kind === 'unmanaged') {
      return { runtime: this.#runtimeName, status: 'unmanaged_home', ready: false };
    }
    if (marker.value.runtime !== this.#runtimeName || marker.value.source_revision !== this.#provider.sourceRevision) {
      return { runtime: this.#runtimeName, status: 'incompatible_home', ready: false };
    }
    if (marker.value.setup_status !== 'ready') {
      return { runtime: this.#runtimeName, status: marker.value.setup_status, ready: false };
    }
    const result = await this.#provider.inspect(context);
    return {
      runtime: this.#runtimeName,
      status: result?.ready === true ? 'ready' : 'not_ready',
      ready: result?.ready === true,
      source_revision: this.#provider.sourceRevision,
      details: safeResult(result)
    };
  }

  async chat() {
    return this.#launch('chat', [], { requireHealthConfig: true });
  }

  async gateway() {
    return this.#launch('gateway', [], { requireHealthConfig: true, forwardSignals: true });
  }

  async help() {
    return this.#launch('help', [], { requireHealthConfig: false });
  }

  async configure() {
    return this.#launch('configure', [], { requireHealthConfig: false });
  }

  async installProviderDependencies(providerName) {
    if (typeof providerName !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(providerName)) {
      throw new RuntimeError('Choose a supported model provider name.', {
        code: 'SOMA_RUNTIME_PROVIDER_NAME_INVALID', exitCode: 2
      });
    }
    return this.#launch('provider-dependencies', [providerName], { requireHealthConfig: false });
  }

  async skills({ action = 'list', name } = {}) {
    if (action !== 'list' || name !== undefined) {
      throw new RuntimeError('Only the read-only local skills list is available.', { code: 'SOMA_RUNTIME_SKILLS_OPERATION_BLOCKED', exitCode: 2 });
    }
    return this.#launch('skills', [], { requireHealthConfig: false });
  }

  async #launch(action, args, { requireHealthConfig, forwardSignals = false }) {
    const context = this.#context({ operation: action, requireHealthConfig });
    const state = await this.inspect();
    if (!state.ready) {
      throw new RuntimeError(`Agent runtime is not ready (${state.status}). Run runtime setup before launching it.`, {
        code: 'SOMA_RUNTIME_NOT_READY'
      });
    }
    if (typeof this.#provider.validateLaunch === 'function') {
      await this.#provider.validateLaunch({ action, args, context });
    }
    const spec = validateLaunchSpec(await this.#provider.launch({ action, args, context }), context.runtimeHome);
    return spawnInherited(spec, context.env, action, this.#spawnProcess, {
      signalSource: this.#signalSource,
      forwardSignals
    });
  }

  #context({ operation, requireHealthConfig = false }) {
    if (!this.#runtimeHome) {
      throw new RuntimeError('Set SOMA_RUNTIME_HOME or pass --runtime-home to select a fresh isolated runtime directory.', {
        code: 'SOMA_RUNTIME_HOME_REQUIRED'
      });
    }
    const canonicalRuntimeHome = canonicalRuntimeHomePath(this.#runtimeHome);
    const runtimeHome = canonicalRuntimeHome;
    validateManagedDirectory(runtimeHome, 'user-home');
    validateManagedDirectory(runtimeHome, 'working-directory');
    const somaRoot = fs.realpathSync(this.#repoRoot);
    const configuredHealthOsRepo = this.#env.HEALTH_OS_REPO
      ? requireAbsolutePath(this.#env.HEALTH_OS_REPO, 'HEALTH_OS_REPO')
      : null;
    const healthOsRepoPath = configuredHealthOsRepo
      ? requireAbsolutePath(configuredHealthOsRepo, 'HEALTH_OS_REPO')
      : path.resolve(somaRoot, '..', 'health-os');
    const healthOsRepo = canonicalMaybeMissing(healthOsRepoPath, 'Health OS repository path');
    const healthWorkspaceValue = this.#env.HEALTH_OS_WORKSPACE;
    const healthWorkspace = healthWorkspaceValue
      ? canonicalMaybeMissing(requireAbsolutePath(healthWorkspaceValue, 'HEALTH_OS_WORKSPACE'), 'Health OS workspace path')
      : null;
    if (overlaps(canonicalRuntimeHome, somaRoot) || overlaps(canonicalRuntimeHome, healthOsRepo)) {
      throw new RuntimeError('SOMA_RUNTIME_HOME must not overlap the SOMA or Health OS repository.', {
        code: 'SOMA_RUNTIME_HOME_UNSAFE'
      });
    }
    const providerHomes = typeof this.#provider.forbiddenHomes === 'function'
      ? this.#provider.forbiddenHomes({ runtimeHome })
      : (this.#provider.forbiddenHomes || []);
    if (!Array.isArray(providerHomes) || providerHomes.some((home) => typeof home !== 'string' || !path.isAbsolute(home))) {
      throw new RuntimeError(`Runtime provider "${this.#runtimeName}" returned an invalid forbidden-home policy.`, {
        code: 'SOMA_RUNTIME_PROVIDER_INVALID'
      });
    }
    for (const forbiddenHome of providerHomes) {
      if (overlaps(canonicalRuntimeHome, canonicalMaybeMissing(forbiddenHome, 'provider home'))) {
        throw new RuntimeError(`SOMA_RUNTIME_HOME must be separate from the selected ${this.#runtimeName} runtime's global home.`, {
          code: 'SOMA_RUNTIME_HOME_PROVIDER_OVERLAP'
        });
      }
    }
    if (healthWorkspace && (overlaps(healthWorkspace, somaRoot) || overlaps(healthWorkspace, healthOsRepo) ||
        overlaps(canonicalRuntimeHome, healthWorkspace))) {
      throw new RuntimeError('The configured Health OS workspace and runtime home must be separate paths outside both repositories.', {
        code: 'SOMA_RUNTIME_HOME_WORKSPACE_OVERLAP'
      });
    }
    if (requireHealthConfig) {
      if (!configuredHealthOsRepo || !healthWorkspace) {
        throw new RuntimeError('Chat requires explicit HEALTH_OS_REPO and HEALTH_OS_WORKSPACE paths.', {
          code: 'SOMA_RUNTIME_HEALTH_CONFIG_REQUIRED'
        });
      }
      let repoStat;
      try { repoStat = fs.statSync(healthOsRepoPath); } catch (error) {
        throw new RuntimeError('The configured Health OS repository path is not available.', {
          code: 'SOMA_RUNTIME_HEALTH_REPO_INVALID', cause: error
        });
      }
      if (!repoStat.isDirectory()) throw new RuntimeError('HEALTH_OS_REPO must be a directory.', { code: 'SOMA_RUNTIME_HEALTH_REPO_INVALID' });
    }

    const contextBase = {
      runtimeName: this.#runtimeName,
      runtimeHome,
      operation,
      repoRoot: somaRoot,
      healthOsRepo: requireHealthConfig ? configuredHealthOsRepo : null,
      healthOsWorkspace: requireHealthConfig ? this.#env.HEALTH_OS_WORKSPACE : null
    };
    const env = minimalEnvironment(this.#env, runtimeHome, this.#runtimeName, operation, this.#provider, contextBase);
    if (requireHealthConfig) {
      env.HEALTH_OS_REPO = configuredHealthOsRepo;
      env.HEALTH_OS_WORKSPACE = this.#env.HEALTH_OS_WORKSPACE;
    }
    if (operation === 'chat' || operation === 'gateway') {
      const credentialEnv = operation === 'gateway'
        ? [...new Set([...(this.#provider.chatCredentialEnv || []), ...(this.#provider.gatewayCredentialEnv || [])])]
        : this.#provider.chatCredentialEnv || [];
      for (const key of credentialEnv) {
        if (typeof this.#env[key] === 'string' && this.#env[key] !== '') env[key] = this.#env[key];
      }
    }
    return {
      runtime: this.#runtimeName,
      operation,
      runtimeHome,
      somaRoot,
      healthOsRepo: configuredHealthOsRepo || null,
      healthOsWorkspace: requireHealthConfig ? this.#env.HEALTH_OS_WORKSPACE : null,
      env
    };
  }
}

function safeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const sanitized = {};
  for (const key of ['status', 'ready', 'version', 'source_revision', 'python_version', 'installed', 'skill_installed',
    'telegram_sdk', 'gateway_authz']) {
    if (typeof result[key] === 'string' || typeof result[key] === 'boolean' || Number.isFinite(result[key])) sanitized[key] = result[key];
  }
  return sanitized;
}

function spawnInherited(spec, env, action, spawnProcess, { signalSource = process, forwardSignals = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(spec.executable, spec.args, {
        cwd: spec.cwd,
        env,
        shell: false,
        stdio: 'inherit',
        windowsHide: false
      });
    } catch (error) {
      reject(new RuntimeError(`Could not start the ${action} runtime operation.`, {
        code: 'SOMA_RUNTIME_SPAWN_FAILED', cause: error
      }));
      return;
    }
    let settled = false;
    let forwardedSignal = null;
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const cleanup = () => {
      if (forwardSignals) {
        signalSource.off('SIGINT', onSigint);
        signalSource.off('SIGTERM', onSigterm);
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const forwardSignal = (signal) => {
      forwardedSignal = signal;
      try { child.kill(signal); } catch { /* the close event reports the child's final state */ }
    };
    if (forwardSignals) {
      signalSource.on('SIGINT', onSigint);
      signalSource.on('SIGTERM', onSigterm);
    }
    child.once('error', (error) => finish(reject, new RuntimeError(`Could not start the ${action} runtime operation.`, {
      code: 'SOMA_RUNTIME_SPAWN_FAILED', cause: error
    })));
    child.once('close', (code, signal) => {
      if (code === 0 || (forwardedSignal && signal === forwardedSignal)) finish(resolve, 0);
      else if (code !== null) finish(resolve, code);
      else finish(reject, new RuntimeError(`The ${action} runtime operation exited on ${signal || 'an unknown signal'}.`, {
        code: 'SOMA_RUNTIME_EXITED', exitCode: 1
      }));
    });
  });
}

export async function createRuntimeManager(options = {}) {
  let providers = options.providers;
  if (!providers) {
    const { createHermesProvider } = await import('./providers/hermes.js');
    providers = { hermes: createHermesProvider({ repoRoot: options.repoRoot || moduleRoot }) };
  }
  return new RuntimeManager({ ...options, providers });
}
