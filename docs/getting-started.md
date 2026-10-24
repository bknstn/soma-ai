# Getting started

SOMA's first workflow prepares a training session from a local Health OS workspace. The CLI uses Node.js; it does not need an LLM API key. Hermes is the intended conversation layer and is configured separately in the [Hermes guide](hermes.md).

## Requirements

- Node.js 22.13.0 or newer
- Git
- Health OS at the compatible revision `363204694ea805256595bf30c72d25c9361595d1`

If Health OS is not available, clone it into a separate directory and check out the pinned revision:

```sh
git clone https://github.com/bknstn/health-os.git "$HOME/src/health-os-soma"
git -C "$HOME/src/health-os-soma" checkout --detach 363204694ea805256595bf30c72d25c9361595d1
```

An existing checkout can be used if its `HEAD` matches that SHA and its executable contract files are unchanged. SOMA does not reset or update the Health OS checkout.

## Configure paths

Set the Health OS repository and a private workspace outside both repositories:

```sh
export HEALTH_OS_REPO="$HOME/src/health-os-soma"
export HEALTH_OS_WORKSPACE="$HOME/.local/share/soma/workspace"
```

These are paths, not secrets. `.env.example` provides the same settings. To use a local `.env`, source it explicitly; SOMA does not load it automatically:

```sh
cp .env.example .env
set -a
. ./.env
set +a
```

The CLI also accepts `--health-os-repo PATH` and `--workspace PATH`; flags take precedence over environment values.

## Initialize and prepare

From the SOMA repository root:

```sh
npm start -- doctor
npm start -- init
npm start -- prepare-training --as-of 2026-10-24T08:00:00Z
```

`doctor` checks the pinned Health OS contract and workspace status. `init` explicitly initializes an absent or empty workspace with a neutral template. `prepare-training` reads that workspace for the given instant. If `--as-of` is omitted, it uses the current exact instant. Cutoffs must be RFC3339 timestamps with a timezone; date-only values are rejected. Training preparation does not change health-domain records, though Health OS may create or update SQLite WAL/SHM files in the workspace.

For machine-readable output, call the CLI directly so npm's script banner does not appear on stdout:

```sh
node src/cli.js prepare-training --as-of 2026-10-24T08:00:00Z --json
```

The versioned JSON envelope contains a bounded summary with the plan, recovery status and rationale, source references, and gaps. It excludes profile text, event payloads, raw observations, and memory evidence.

## Verify

There are no runtime package dependencies. Run the unit and contract suite with Node 22.13.0 or newer:

```sh
npm test
```

Without `HEALTH_OS_REPO`, the pinned integration test is skipped. Set it to the compatible checkout to run the full suite, including 15 synthetic observation sets, a `FULL` recovery result, and the blocked-memory review case. `npm run demo` also needs this variable and uses its own temporary synthetic workspace:

```sh
HEALTH_OS_REPO="$HOME/src/health-os-soma" npm test
HEALTH_OS_REPO="$HOME/src/health-os-soma" npm run demo
```

Neither command uses the configured personal workspace. The integration test and demo remove their temporary workspaces. GitHub Actions runs the same suite with the pinned checkout.

See [architecture](architecture.md) for the CLI boundary and response fields, [Hermes setup](hermes.md) for conversation setup, and [privacy](privacy.md) for the workspace and model-provider data flow.
