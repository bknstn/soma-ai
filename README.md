# SOMA

SOMA is a public, forkable assistant for body, health, sleep, and activity. It is designed to run locally, with private records kept in a user-owned workspace outside this repository. Health OS provides the deterministic health-data and training engine, and Hermes is the intended conversational runtime. The command-line flow can run without an LLM API key.

The current scope is the first manual scenario: prepare a training session for a precise point in time, explain the plan and its reasons, and surface missing or unavailable inputs without filling them in. This repository is an initial milestone, not a completed hosted product. It does not currently provide a web or mobile app, multi-user hosting, background scheduling, or SOMA-managed live health-data sync. The first scenario does not need a model API key.

## Requirements

- Node.js 22.13.0 or newer
- Git
- Health OS at the pinned compatible revision `363204694ea805256595bf30c72d25c9361595d1`

If Health OS is not already available, clone it into a new, separate directory and check out the pinned revision:

```sh
git clone https://github.com/bknstn/health-os.git "$HOME/src/health-os-soma"
git -C "$HOME/src/health-os-soma" checkout --detach 363204694ea805256595bf30c72d25c9361595d1
```

If you already have a Health OS checkout, point SOMA to it only after confirming its `HEAD` is that SHA and its executable contract files are unchanged. SOMA never resets or updates the Health OS checkout for you.

## Configure a private workspace

Set the Health OS checkout and a private workspace path. Keep the workspace outside both Git repositories:

```sh
export HEALTH_OS_REPO="$HOME/src/health-os-soma"
export HEALTH_OS_WORKSPACE="$HOME/.local/share/soma/workspace"
```

`.env.example` contains these two settings. To use a local `.env` file, copy it to `.env` and source it in your shell; SOMA does not load `.env` files automatically:

```sh
cp .env.example .env
set -a
. ./.env
set +a
```

The environment variables can be overridden with explicit CLI flags. They contain paths, not secrets.

## Run the first scenario

From the root of this repository:

```sh
npm start -- doctor
npm start -- init
npm start -- prepare-training --as-of 2026-10-24T08:00:00+02:00
```

`doctor` checks the pinned Health OS contract and workspace status. `init` explicitly initializes an absent or empty workspace with a neutral template. `prepare-training` reads the workspace and returns an explanation for the requested instant. Use an RFC3339 timestamp with an offset for an exact cutoff; date-only values are rejected. If `--as-of` is omitted, SOMA uses the current exact instant.

The JSON interface is available for scripts and integrations. Call the CLI directly to keep npm's script banner out of stdout:

```sh
node src/cli.js prepare-training --as-of 2026-10-24T08:00:00+02:00 --json
```

JSON uses a versioned SOMA envelope and a neutral summary. It does not return profile text, events, raw observations, or memory evidence. A missing or unavailable input is represented as a gap or status; it is not turned into an assumed value. See [the architecture](docs/architecture.md) for the subprocess boundary and response shape.

There are no core runtime package dependencies. Run `npm test` with Node 22.13.0 or newer. Without `HEALTH_OS_REPO`, the pinned Health OS integration test is skipped. Set it to the pinned checkout to run the full suite, including 15 fully synthetic observation sets, a `FULL` recovery result, and the blocked-memory review case. `npm run demo` also requires that variable and runs in its own synthetic temporary workspace, which it removes when complete. GitHub Actions sets the pinned path and removes its separate smoke workspace.

## Verify

```sh
npm test
HEALTH_OS_REPO="$HOME/src/health-os-soma" npm test
HEALTH_OS_REPO="$HOME/src/health-os-soma" npm run demo
```

The second command runs the real pinned Health OS integration; the first runs unit and contract tests while skipping that integration. `npm run demo` requires `HEALTH_OS_REPO` to point to the pinned checkout. Neither command uses the configured personal workspace.

## Hermes integration

SOMA includes a native Hermes skill for the read-only preparation flow. For Hermes conversation, configure a model provider in the Hermes profile as usual. The skill invokes the SOMA CLI from this checkout and requires `SOMA_REPO`, `HEALTH_OS_REPO`, and `HEALTH_OS_WORKSPACE` in the Hermes terminal environment.

Install the skill from GitHub with:

```sh
hermes skills install bknstn/soma-ai/skills/soma-health
```

If GitHub installation is not available yet, run this from the SOMA checkout root to copy the skill when you have no existing `soma-health` skill directory:

```sh
export SOMA_REPO="$PWD"
test ! -e "$HOME/.hermes/skills/soma-health" && \
  mkdir -p "$HOME/.hermes/skills/soma-health" && \
  cp "$SOMA_REPO/skills/soma-health/SKILL.md" "$HOME/.hermes/skills/soma-health/SKILL.md"
```

Export the paths in the environment used to start Hermes (see [the Hermes setup guide](docs/hermes.md)). The skill does not edit Hermes configuration or initialize a workspace. Initialize and inspect the workspace yourself using the CLI instructions above, then invoke `/soma-health` in Hermes.

The implementation follows Hermes' documented skill format and direct GitHub skill installation flow. These links are pinned to the upstream revision reviewed for this integration: [Hermes Skills System](https://github.com/NousResearch/hermes-agent/blob/bda3a363e9695e3f63fce4a7ca85ba17b5fecb61/website/docs/user-guide/features/skills.md) and [Creating Skills](https://github.com/NousResearch/hermes-agent/blob/bda3a363e9695e3f63fce4a7ca85ba17b5fecb61/website/docs/developer-guide/creating-skills.md). The skill has not been validated against a live Hermes installation in this repository.

## Privacy and scope

- Personal records belong in the private Health OS workspace, never in SOMA source or fixtures.
- Training preparation is read-only with respect to health-domain records after the user explicitly initializes the workspace. Health OS may create or update SQLite auxiliary WAL/SHM files inside the private workspace during reads.
- Do not send health context to remote Hermes messaging platforms. A Hermes session may pass tool output to its configured model provider; review that provider and terminal environment before using private records.
- This is a personal planning aid, not a medical diagnosis or a substitute for professional care.

See [the roadmap](docs/roadmap.md) for the wider product direction and the boundaries of this milestone.
