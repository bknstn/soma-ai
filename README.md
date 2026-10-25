# SOMA

SOMA is an AI agent that helps you understand and care for your body as a whole. Its goal is to bring wearable data, daily activities, and habits together into a clear picture of your body's state and how it changes over time.

## Current implementation

The first implemented workflow is manual training preparation from workout history and sleep/recovery context already stored in a local Health OS workspace. Health OS validates the context and calculates the session; a native Hermes skill lets you ask for it conversationally.

The result explains the session strategy, rationale, sources, and missing inputs. Original records stay in the local workspace; Hermes receives a bounded summary.

A separate allowlisted `health-action` interface can read the selected profile and bounded workout history, or record an explicitly requested workout/working-weight change through native Health OS commands. It requires JSON output so the human formatter omits private excerpts. Writes are operator-gated: `SOMA_HEALTH_ACTION_MODE` defaults to `read-only`; `--confirmed` alone cannot enable them. Latest-history lookup requires an explicit `--through YYYY-MM-DD` date from the configured local calendar, avoiding an implicit UTC cutoff. See [architecture](docs/architecture.md) and [privacy](docs/privacy.md) for bounds and limitations.

## Run

After configuring Health OS paths and initializing the workspace, install and check the isolated Hermes runtime. Configure a model provider when needed, then start chat:

```sh
npm run runtime:setup
npm run runtime:doctor
npm run runtime:configure # when no model provider is configured
npm run chat
```

The deterministic flow also runs directly, without a model provider:

```sh
npm start -- prepare-training
```

See the [Hermes setup and usage guide](docs/hermes.md) for isolated runtime setup, provider configuration, and Health OS paths.

## Self-hosted deployment

SOMA includes a bounded Telegram gateway command, a systemd user-service template, and a non-secret [environment example](deploy/systemd/gateway.env.example). Follow the [Hermes gateway setup](docs/hermes.md#managed-telegram-gateway) and [deployment guide](docs/vps.md) to configure your own host, isolated paths, credentials, and service. SSH access requires an explicit `SOMA_VPS_SSH_HOST` value; keep actual connection details outside Git.

## Disclaimer

Soma AI and its outputs have not been clinically validated. The software is for personal planning, not medical advice, diagnosis, or treatment. AI-generated output may be incomplete or wrong; independently verify it before acting, and consult a qualified clinician for medical decisions. Use it at your own risk. The software is provided “as is”; to the fullest extent permitted by applicable law, the authors disclaim warranties and liability as described in the [MIT License](LICENSE).
