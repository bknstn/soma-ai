#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuntimeError, createRuntimeManager } from './manager.js';

export const RUNTIME_HELP = `Usage: node src/runtime/cli.js <command> [options]

Commands:
  setup      Install the pinned agent runtime into an isolated runtime home
  doctor     Inspect the selected runtime without contacting Health OS
  chat       Start the selected runtime's local interactive chat
  configure  Open the selected runtime's model provider configuration
  provider-deps <name>  Install an optional SDK for anthropic, bedrock, or vertex
  skills     List locally installed skills (read-only)

Options:
  --runtime NAME       Agent runtime (default: hermes, or SOMA_RUNTIME)
  --runtime-home PATH  Isolated runtime state directory (or SOMA_RUNTIME_HOME)
  --json               Emit a versioned response for setup or doctor
  --help               Show this help

Chat smoke check:
  node src/runtime/cli.js chat --help
`;

class RuntimeCliError extends Error {
  constructor(message, code = 'SOMA_RUNTIME_USAGE', exitCode = 2) {
    super(message);
    this.name = 'RuntimeCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = { json: false };
  let command;
  const extra = [];
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if ((token === '--help' || token === '-h') && !command) return { help: true };
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--runtime' || token === '--runtime-home') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new RuntimeCliError(`${token} requires a value.`);
      const key = token === '--runtime' ? 'runtime' : 'runtimeHome';
      if (options[key] !== undefined) throw new RuntimeCliError(`${token} may be supplied only once.`);
      options[key] = value;
      index += 2;
      continue;
    }
    if (!command && token.startsWith('-')) throw new RuntimeCliError('An unsupported runtime option was supplied.');
    if (!command) command = token;
    else extra.push(token);
    index += 1;
  }

  if (!command) throw new RuntimeCliError('Choose setup, doctor, chat, configure, provider-deps, or skills.');
  if (!['setup', 'doctor', 'chat', 'configure', 'provider-deps', 'skills'].includes(command)) {
    throw new RuntimeCliError('Choose setup, doctor, chat, configure, provider-deps, or skills.');
  }
  if (command === 'chat') {
    if (extra.length === 1 && (extra[0] === '--help' || extra[0] === '-h')) options.chatHelp = true;
    else if (extra.length > 0) throw new RuntimeCliError('Chat accepts no extra agent-runtime arguments.');
  } else if (command === 'skills') {
    if (extra.length > 1 || (extra.length === 1 && extra[0] !== 'list')) {
      throw new RuntimeCliError('Only `skills list` is available; it reads the local managed skill index.');
    }
  } else if (command === 'provider-deps') {
    if (extra.length !== 1 || !/^[a-z][a-z0-9-]{0,39}$/.test(extra[0])) {
      throw new RuntimeCliError('Use `provider-deps <name>` to install an explicitly supported model SDK.');
    }
    options.providerName = extra[0];
  } else if (extra.length > 0) {
    throw new RuntimeCliError(`${command} does not accept additional arguments.`);
  }
  if (options.json && !['setup', 'doctor'].includes(command)) {
    throw new RuntimeCliError('--json is available only with setup or doctor.');
  }
  return { help: false, command, ...options };
}

function response(command, json, value, human, stdout) {
  if (json) stdout.write(`${JSON.stringify({ schema_version: 1, command: `runtime-${command}`, ok: true, data: value })}\n`);
  else stdout.write(human);
}

function fail(command, json, error, stdout, stderr) {
  const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'SOMA_RUNTIME_FAILED';
  const message = error instanceof RuntimeError || error instanceof RuntimeCliError
    ? error.message
    : 'The selected agent runtime failed. Run runtime doctor for local setup details.';
  const exitCode = Number.isInteger(error?.exitCode) && error.exitCode !== 0 ? error.exitCode : 1;
  if (json) stdout.write(`${JSON.stringify({
    schema_version: 1,
    command: `runtime-${command || 'cli'}`,
    ok: false,
    error: { code, message }
  })}\n`);
  else stderr.write(`SOMA runtime [${code}]: ${message}\n`);
  return exitCode;
}

/** Run the isolated agent runtime entry point. Health OS is never imported or invoked here. */
export async function runRuntimeCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const env = dependencies.env || process.env;
  let command;
  let json = argv.includes('--json');
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    json = parsed.json === true;
    if (parsed.help) {
      stdout.write(RUNTIME_HELP);
      return 0;
    }
    const managerFactory = dependencies.createRuntimeManager || createRuntimeManager;
    const manager = dependencies.manager || await managerFactory({
      runtime: parsed.runtime,
      runtimeHome: parsed.runtimeHome,
      env,
      providers: dependencies.providers
    });

    if (command === 'setup') {
      const data = await manager.setup();
      response(command, json, data, `Agent runtime ${data.runtime} is ready.\n`, stdout);
      return 0;
    }
    if (command === 'doctor') {
      const data = await manager.inspect();
      response(command, json, data, `Agent runtime ${data.runtime}: ${data.status}.\n`, stdout);
      return 0;
    }
    if (command === 'chat') return await (parsed.chatHelp ? manager.help() : manager.chat());
    if (command === 'configure') return await manager.configure();
    if (command === 'provider-deps') return await manager.installProviderDependencies(parsed.providerName);
    if (command === 'skills') return await manager.skills({ action: 'list' });
    throw new RuntimeCliError('Choose setup, doctor, chat, configure, provider-deps, or skills.');
  } catch (error) {
    return fail(command, json, error, stdout, stderr);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = await runRuntimeCli(process.argv.slice(2));
}
