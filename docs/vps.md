# VPS deployment preparation

SOMA will initially share the existing assistant's SSH account and host, with its own source, runtime, Health OS workspace, Telegram bot, and service. Sharing an account is an operational choice: separate directories do not prevent processes under that account from accessing each other's files.

This is a deployment checklist. The source now includes a bounded Telegram gateway command, a separate `hermes-soma.service` user-unit template, and private environment-file conventions. No server deployment, bot setup, or data migration is implied by this document.

## SSH access from either repository

The default local SSH alias is `hermes-vps`. It uses the host, account, and key already configured in the operator's SSH client. Reuse that authentication; no second key or server account is required for the initial deployment.

From SOMA:

```sh
npm run vps:ssh
```

From SOMA or AI Buddy:

```sh
sh scripts/vps-ssh.sh
# Equivalent, from any directory:
ssh hermes-vps
```

To use another locally configured alias:

```sh
ASSISTANT_VPS_SSH_HOST=assistant-vps sh scripts/vps-ssh.sh
```

The wrapper also accepts a remote command, for example `sh scripts/vps-ssh.sh 'id -un'`. It only invokes SSH; it does not install, restart, configure, or migrate anything. Inspect the target before performing operational changes. Actual host addresses, key paths, tokens, and connection evidence stay outside source control. On another workstation, configure the alias in that workstation's SSH client first.

## Separate layout under the existing account

Use the account's home as the base. The following paths are proposed conventions, not proof of installed directories:

```text
$HOME/soma/
  source/
    soma-ai/               # Published SOMA main, including its pinned submodule
    health-os/             # Separate checkout at the compatible revision
  runtime/                 # New SOMA_RUNTIME_HOME; not a Buddy profile
  workspace/               # New HEALTH_OS_WORKSPACE, outside both checkouts
  config/                  # Private service environment, no secrets in source
```

Set `HEALTH_OS_REPO` to `$HOME/soma/source/health-os`, `HEALTH_OS_WORKSPACE` to `$HOME/soma/workspace`, and `SOMA_RUNTIME_HOME` to `$HOME/soma/runtime`. Keep the actual runtime home, workspace, and private configuration owner-only. The service credentials belong in `$HOME/soma/config/gateway.env`, copied from [the non-secret environment example](../deploy/systemd/gateway.env.example) and restricted to mode `0600`. Put provider/model selection in `$HOME/soma/runtime/hermes-home/config.yaml`; for the initial OpenAI API setup, select canonical `openai-api`, an explicit model, Telegram only, and `unauthorized_dm_behavior: ignore`. Keep the API key in the private environment file. Do not run the local interactive `runtime:configure` flow for this service because it can save keys in Hermes `.env`, which the gateway refuses. Do not reuse an existing Hermes home or clone Buddy's configuration directory.

The unit is `hermes-soma.service`, separate from other assistant services. Adapt [the user service template](../deploy/systemd/hermes-soma.service) with the account's absolute source, runtime, environment-file, and Node paths. Install and manage it with `systemctl --user` only after source publication and runtime setup. Use absolute paths in its environment file; systemd environment files do not perform shell variable expansion. The service defaults to Telegram polling and restarts on failure; it does not configure or start itself.

## Ordered rollout checklist

1. **Repository preparation — implementation work**
   - [x] Document SSH access and add the same wrapper in both repositories.
   - [x] Define separate directories and a distinct service name.
   - [x] Add a bounded gateway action to SOMA's runtime manager, CLI, and Hermes adapter. Preserve isolated `HOME`, `HERMES_HOME`, working directory, source pins, and explicit Health OS paths; allow only Telegram and provider credentials from the runtime allowlists.
   - [x] Add a user systemd service template and a non-secret private-environment example for the managed SOMA gateway, with restart handling and absolute paths. Keep service installation separate from Hermes' generic installer.
   - [x] Add offline/mocked tests for isolated gateway invocation, env filtering, synthetic allowlist authorization, and signal forwarding; add a CI-only preflight integration test using the pinned Telegram config loader with the final process spawn mocked. No live model or Telegram calls are part of these checks.
   - [ ] Run the pinned runtime integration check in CI and review its result, including Telegram SDK, native SOMA skill, authorization behavior, and actual config preflight, before publication.
   - [ ] Review and publish deployment source to GitHub `main` before server installation. Deploy by fetching and fast-forwarding the server's `main`, then verify its HEAD matches the freshly fetched `origin/main`.

2. **Server installation — agent/operator**
   - [ ] Recheck the SSH account, dependencies, free space, existing services, and target-path availability without opening private assistant data.
   - [ ] Create the SOMA tree without overwriting existing paths. Clone SOMA and initialize its committed Hermes submodule; do not update the submodule to upstream main.
   - [ ] Clone Health OS separately at `363204694ea805256595bf30c72d25c9361595d1`. Keep Hermes at `bf0203a794a07aac3ff764972ab9087baa4e4f4e` (v0.22.5).
   - [ ] Export the explicit paths, run `npm run runtime:setup` and `npm run runtime:doctor`, and check the local native skill list. Run these checks without provider credentials.
   - [ ] Explicitly initialize a new neutral Health OS workspace and check deterministic training preparation. Missing data must remain visible. This step does not import Buddy records or connect health accounts.
   - [ ] Create the isolated `hermes-home/config.yaml` model/platform settings and enter the chosen provider key directly into the owner-only service environment file. SSH authentication is shared; provider authentication is separate. Do not use interactive `runtime:configure` for this service, and do not read or copy Buddy's credentials or existing Hermes home.

3. **Telegram bot — user, then agent/operator**
   - [ ] User creates a separate SOMA bot with BotFather and keeps its token private.
   - [ ] Enter the new token directly into SOMA's private server configuration, without putting it in chat, shell arguments, logs, or Git.
   - [ ] Configure an explicit Telegram user allowlist. Do not enable unrestricted access or add webhook/other-channel settings; the managed gateway requires Telegram polling with unauthorized DMs ignored.
   - [ ] Render the unit with the actual absolute paths, run `systemd-analyze verify`, then install and start only `hermes-soma.service`. Verify it uses SOMA's runtime and new token, with no competing process consuming updates for that token. Check user-service persistence after logout and boot.

4. **Acceptance test — user and agent/operator**
   - [ ] User opens the new bot and sends a test message; verify a complete model reply.
   - [ ] Invoke `/soma-health` against the neutral or synthetic workspace. Confirm missing inputs are explained and the flow does not write health-domain records.
   - [ ] Check the allowlist with a mocked unauthorized sender; verify service restart, reconnect, session persistence, and private log handling. Check that the existing assistant service remains healthy.
   - [ ] Record the accepted source revisions and rollback steps privately. Stop only SOMA's service if acceptance fails; preserve the existing assistant.

5. **Buddy → SOMA data migration — separate follow-up after acceptance**
   - [ ] Agree on the exact source, destination, and selected data categories before reading private records. Distinguish health-domain data, instructions, conversations, memories, schedules, integrations, and credentials; they do not share one migration format.
   - [ ] Review compatibility and the supported Health OS import interface. Implement migration separately from the read-only training-preparation flow and test it with synthetic fixtures first.
   - [ ] Create a recoverable private backup under an explicit retention plan. Preview the mapping and validate a dry run before importing approved records.
   - [ ] Check provenance, timestamps, record counts, duplicate/replay handling, and representative results. Configure integrations and credentials separately; do not blindly copy Hermes state or `~/.hermes`.
   - [ ] Switch use to SOMA only after the migration is accepted. Retire or disable the old instance only on an explicit cutover decision, with rollback available.

Remove task-created temporary scripts, probes, staging files, and validation copies on every host after each task. Preserve implementation, requested deliverables, persistent runtime state, user data, and backups covered by the agreed retention plan.
