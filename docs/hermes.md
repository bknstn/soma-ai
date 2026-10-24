# Hermes skill setup

The `skills/soma-health/SKILL.md` folder is a native Hermes skill. SOMA is designed to use Hermes for conversation; its deterministic CLI can also run the training-preparation flow without a model API. The skill exposes only read-only training preparation.

## Install

After `bknstn/soma-ai` is available on GitHub, inspect and install the skill directly from the repository:

```sh
hermes skills inspect bknstn/soma-ai/skills/soma-health
hermes skills install bknstn/soma-ai/skills/soma-health
hermes skills list
```

Hermes documents direct GitHub path installs and the `SKILL.md` format in its [Skills System](https://github.com/NousResearch/hermes-agent/blob/bda3a363e9695e3f63fce4a7ca85ba17b5fecb61/website/docs/user-guide/features/skills.md) and [Creating Skills](https://github.com/NousResearch/hermes-agent/blob/bda3a363e9695e3f63fce4a7ca85ba17b5fecb61/website/docs/developer-guide/creating-skills.md) guides. For a fork, replace `bknstn` with the owner of your fork.

Installing a skill adds it to the Hermes profile's skill library. It does not install SOMA or Health OS, initialize a workspace, or configure a model provider.

For local development before the GitHub path is available, run this from the SOMA checkout root and copy the skill only when the destination does not already exist:

```sh
export SOMA_REPO="$PWD"
test ! -e "$HOME/.hermes/skills/soma-health" && \
  mkdir -p "$HOME/.hermes/skills/soma-health" && \
  cp "$SOMA_REPO/skills/soma-health/SKILL.md" "$HOME/.hermes/skills/soma-health/SKILL.md"
```

## Configure paths for Hermes

The skill needs read access to the SOMA checkout, the pinned Health OS checkout, and the private workspace. Export these paths in the environment that starts Hermes:

```sh
export SOMA_REPO="$HOME/src/soma-ai"
export HEALTH_OS_REPO="$HOME/src/health-os-soma"
export HEALTH_OS_WORKSPACE="$HOME/.local/share/soma/workspace"
hermes
```

The skill declares these variables and the `terminal` toolset in its frontmatter so Hermes can pass set values to the terminal tool. Export the paths before starting Hermes to avoid setup prompts. The skill does not issue Hermes configuration commands. The workspace must remain outside both repositories.

Use a Hermes terminal backend that can read the paths on the machine where the checkouts and workspace live. An isolated or remote backend may not be able to access host paths. If it cannot access all three paths, stop; do not copy private health data into a different backend as a workaround.

Hermes itself requires whatever provider configuration the user selects for chat. SOMA's deterministic CLI flow does not require a model key.

## Use

Initialize and inspect the workspace explicitly with the SOMA CLI first. Then start a Hermes session whose terminal can read the configured paths and invoke `/soma-health` with a request such as “Prepare training for now” or “Prepare training for 2026-10-24T08:00:00+02:00.” The skill calls `prepare-training` only; it does not initialize, sync, import, edit, or migrate records.

The skill has not been verified against a live Hermes installation. Its loader format and install command were checked against the pinned upstream documentation linked above.
