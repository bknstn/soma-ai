# Hermes runtime

SOMA includes Hermes as its first swappable conversation runtime. The source is the `third_party/hermes-agent` Git submodule, pinned to upstream release **v0.22.5** at commit [`bf0203a794a07aac3ff764972ab9087baa4e4f4e`](https://github.com/NousResearch/hermes-agent/commit/bf0203a794a07aac3ff764972ab9087baa4e4f4e). The checked-in [runtime manifest](../runtimes/hermes/manifest.json) records the source and isolated install contract. Do not advance the submodule with `git submodule update --remote`; review a runtime update as a pinned source change.

## Requirements and checkout

The installer targets macOS and Linux and requires Bash. Use Git, Node.js 22.13.0 or newer, and system Python 3.11 through 3.14 for bootstrap. The setup script installs the pinned `uv` and Python 3.14 under the isolated runtime home; it does not require a globally installed Hermes or `uv`. From an existing SOMA checkout, initialize the pinned source:

```sh
git submodule update --init --recursive
```

The source is checked out under `third_party/hermes-agent`. SOMA does not install a global `hermes` command.

## Isolated setup

Choose a new absolute runtime home outside the SOMA and Health OS repositories. Do not reuse `~/.hermes`, another Hermes profile, or a directory containing an existing installation or personal data.

```sh
export SOMA_RUNTIME=hermes
export SOMA_RUNTIME_HOME="$HOME/.local/share/soma/hermes-runtime"
npm run runtime:setup
npm run runtime:doctor
```

`runtime:setup` bootstraps the pinned `uv` 0.13.5, Python 3.14, and Hermes dependencies into the isolated runtime home. The managed layout includes `hermes-home` for Hermes settings, `hermes-tools` for runtime tools, `user-home` for `HOME` and XDG paths, `working-directory` for Hermes launches, and separate Python and uv cache locations. Setup may download the pinned runtime dependencies; it does not call a model provider, import an existing Hermes home, initialize Health OS, or read Health OS records. `runtime:doctor` checks the selected runtime and pin without calling Health OS or requiring provider credentials.

Keep the same `SOMA_RUNTIME` and `SOMA_RUNTIME_HOME` values for setup, checks, and chat. They can be placed in a local `.env` copied from [.env.example](../.env.example); SOMA does not load `.env` files automatically, so export or source the file in the shell before running a command.

## Configure a model provider

`SOMA_RUNTIME=hermes` selects the agent runtime. It is separate from Hermes' model provider and model selection. If no model is configured, run the managed configuration command:

```sh
npm run runtime:configure
```

This opens Hermes' provider and model flow with the isolated `hermes-home`. Enter credentials only in the interactive provider prompt; do not pass API keys as command-line arguments or export an existing account's secrets into the runtime. Credentials may also be supplied through the adapter's allowlisted provider environment variables for chat only; setup and doctor never inherit them. Configured credentials are stored in the isolated runtime home, not in `~/.hermes`, the SOMA repository, or the Health OS workspace.

Hermes needs an optional SDK extra for the native **Anthropic**, **AWS Bedrock**, and **Google Vertex AI** providers. After `runtime:setup` and before configuring one of those providers, install its pinned extra into the managed runtime:

```sh
npm run runtime:provider-deps -- anthropic # or bedrock or vertex
```

This command accepts only those three names, installs through Hermes' pinned package manager, and uses no model credentials or Health OS paths. OpenAI-compatible providers use Hermes' core SDK and need no extra. This optional SDK selection is separate from `SOMA_RUNTIME`, which selects the conversation-runtime module.

Use the provider selector again to change providers. That changes the LLM connection inside Hermes; changing `SOMA_RUNTIME` selects a different SOMA conversation-runtime module. The current module is Hermes. For available providers and their setup requirements, see the pinned upstream [provider guide](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/website/docs/integrations/providers.md) and [configuration guide](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/website/docs/user-guide/configuration.md).

## Managed Telegram gateway

`npm run gateway` starts the pinned Telegram adapter in the foreground for an external service manager. The command requires explicit `HEALTH_OS_REPO` and `HEALTH_OS_WORKSPACE` paths, a private runtime home, `TELEGRAM_BOT_TOKEN`, and a comma-separated numeric `TELEGRAM_ALLOWED_USERS` list. It passes only credential variables on the runtime adapter's allowlist and these two Telegram values; the OpenAI example uses `OPENAI_API_KEY`. It refuses other enabled channels, Hermes named profiles, `.env`/`.op.env` secret files, adapter-level Telegram allowlists, and a configuration that does not silently ignore unauthorized DMs. The managed gateway supports Telegram polling; webhook and other channel settings are not supported.

The private gateway environment also accepts `SOMA_HEALTH_ACTION_MODE`. Keep it at `read-only` while another service owns workspace writes; an operator may set `confirmed-writes` only after an explicit ownership transfer. User requests and skill instructions cannot change this mode.

The gateway's provider and model selection live in `hermes-home/config.yaml`. For an OpenAI API configuration, use the canonical `openai-api` provider (the short alias `openai` can resolve ambiguously) and keep the key in the private service environment. The following is an example; choose the provider and model for your deployment:

```yaml
model:
  provider: openai-api
  default: gpt-6.1-sol
agent:
  reasoning_effort: medium
platforms:
  telegram:
    enabled: true
unauthorized_dm_behavior: ignore
```

`runtime:configure` is the interactive local-chat setup and can save a provider key in `hermes-home/.env`; the managed gateway deliberately refuses that file. For a service, use an owner-only private environment file instead. Start from [the non-secret environment example](../deploy/systemd/gateway.env.example), replace every example path with an absolute path and each placeholder with private values, then set mode `0600`. Do not put real tokens or API keys in the example, repository, chat, command arguments, or logs. Add the new Telegram bot's positive numeric user IDs to the allowlist. A fresh runtime has no pairing grants; unauthorized DMs remain ignored.

On a Linux VPS, adapt [the user service template](../deploy/systemd/hermes-soma.service) for the account's absolute source, runtime, config, and Node paths. Choose a unit name that is distinct from other services on your host. The Node CLI forwards SIGTERM/SIGINT to Hermes and waits for its clean exit; systemd restarts only on failure. Follow the [deployment guide](vps.md) for installation and acceptance checks.

## Start SOMA

Prepare Health OS separately by following [the checkout, path configuration, and workspace initialization guide](getting-started.md). Health OS remains an independent data engine; Hermes setup and provider configuration do not initialize or read its workspace. After initialization, start the conversational runtime:

```sh
npm run chat
```

Use `/soma-health` to prepare the training scenario. The separate `/soma-health-actions` capability provides bounded profile/history reads and operator-gated explicit writes. Latest-workout lookups require `--through` from the configured local calendar. The Hermes skills call SOMA's bounded JSON interface and do not initialize, import, sync, or migrate Health OS records. Review [the privacy model](privacy.md) before including private health context in a provider conversation.

For an offline native-skill check, use `node src/runtime/cli.js skills list`. It reads the local skill list from the isolated Hermes home and does not contact a model provider or remote skill registry.

The deterministic command-line flow works independently of Hermes and any model provider:

```sh
node src/cli.js doctor
node src/cli.js prepare-training --as-of 2026-10-24T08:00:00+02:00 --json
```

## Verification

`npm test` checks the runtime manager, provider boundary, and synthetic Health OS integration. CI installs into a new temporary `SOMA_RUNTIME_HOME`, runs runtime doctor, exercises the actual Hermes help and native skill loader without making a model request, and removes the runtime home even after failure. No live model account or provider key is used in tests.
