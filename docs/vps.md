# Self-hosted deployment

This guide describes a reusable Linux deployment of SOMA's managed Telegram gateway. Choose your own host, account, directories, and service name. Keep actual host addresses, SSH aliases, usernames, key paths, service inventory, and operational notes outside Git.

Use a dedicated operating-system account when isolation from other applications is required. Separate directories under a shared account do not prevent that account's processes from accessing each other's files.

## Explicit SSH target

Configure authentication in your local SSH client and set `SOMA_VPS_SSH_HOST` to the host or alias you intend to access. The wrapper has no default target and exits with an error when this variable is unset or empty. Replace `YOUR_SSH_ALIAS` in these examples with your own privately configured target:

```sh
SOMA_VPS_SSH_HOST=YOUR_SSH_ALIAS npm run vps:ssh
```

The wrapper accepts remote-command arguments:

```sh
SOMA_VPS_SSH_HOST=YOUR_SSH_ALIAS sh scripts/vps-ssh.sh 'id -un'
```

Authentication remains in the SSH client and agent. Keep private keys and real connection details outside both repositories. Inspect the explicitly selected target before changing its files or services.

## Example directory layout

The following tree is a generic example. Choose an available deployment root outside both source checkouts and adapt every path to your environment:

```text
$HOME/soma/
  source/
    soma-ai/               # SOMA checkout with its pinned Hermes submodule
    health-os/             # Separate checkout at the compatible revision
  runtime/                 # New SOMA_RUNTIME_HOME
  workspace/               # New HEALTH_OS_WORKSPACE, outside both checkouts
  config/                  # Private service environment
```

Set `HEALTH_OS_REPO`, `HEALTH_OS_WORKSPACE`, and `SOMA_RUNTIME_HOME` explicitly to the corresponding absolute paths. Keep runtime state, the workspace, and private configuration owner-only. Start from [the environment example](../deploy/systemd/gateway.env.example), replace `/home/ACCOUNT` and all other placeholders privately, and restrict the resulting environment file to mode `0600`. Systemd environment files require absolute values and do not expand shell variables such as `$HOME`.

Put provider/model selection and Telegram settings in the isolated runtime's `hermes-home/config.yaml`; see the [managed gateway configuration](hermes.md#managed-telegram-gateway). Keep credentials in the private service environment file. The interactive `runtime:configure` flow can save keys in Hermes `.env`, which the managed gateway refuses. Create a fresh runtime instead of copying another application's configuration, credentials, sessions, or existing Hermes home.

Adapt [the systemd user-service template](../deploy/systemd/hermes-soma.service) with the account's absolute source, runtime, environment-file, and Node paths. Choose a service name that is distinct from other services on the target host. Document any actual deployment inventory privately.

## Installation checklist

1. **Verify source and prerequisites.**
   - Review the intended SOMA revision and its CI results before installation. For a deployment from `main`, fetch and fast-forward the server checkout, then verify its HEAD matches the intended `origin/main` revision.
   - Check the selected account, dependencies, free space, and target-path availability without opening private application data. Create new paths without overwriting existing files.
   - Initialize the committed Hermes submodule; do not update it to upstream main. The supported Hermes revision is `bf0203a794a07aac3ff764972ab9087baa4e4f4e` (v0.22.5).
   - Check out Health OS separately at the supported revision `363204694ea805256595bf30c72d25c9361595d1`.

2. **Prepare isolated runtime and workspace.**
   - Export the explicit paths, run `npm run runtime:setup` and `npm run runtime:doctor`, and check the local native skill list without provider credentials.
   - Explicitly initialize a new neutral Health OS workspace and check deterministic training preparation with synthetic inputs. Missing data must remain visible.
   - Configure provider/model selection and Telegram polling in the isolated runtime. The managed gateway requires `unauthorized_dm_behavior: ignore` and rejects other channels and webhook settings.

3. **Configure private credentials and access.**
   - Create a dedicated Telegram bot through BotFather and keep its token private.
   - Enter the bot token, provider credentials, and explicit positive numeric Telegram user allowlist directly into the owner-only environment file. Keep real values out of chat, shell arguments, logs, and Git.
   - Do not enable unrestricted gateway access. Run authorization checks with synthetic sender IDs before accepting real traffic.

4. **Install and verify the service.**
   - Render the unit with actual absolute paths, run `systemd-analyze --user verify` against the rendered unit, and install and start it with `systemctl --user` after reviewing the result.
   - Confirm the service uses the chosen runtime and bot token, with no competing process consuming updates for that token. Check user-service persistence after logout and boot.
   - Send a neutral test message and verify a complete reply. This acceptance check uses the configured provider and Telegram; offline development and CI checks must not make those calls.
   - Invoke `/soma-health` against the neutral or synthetic workspace. Confirm missing inputs are explained and the flow does not write health-domain records.
   - Verify restart, reconnect, session persistence, and private log handling. Record accepted revisions and rollback steps privately, and scope rollback to this deployment's service and files.

Deployment preparation does not authorize reading or migrating existing personal records. Any data migration requires a separate explicit scope, a supported import interface, and synthetic validation first. Keep source inventories, mappings, backups, and cutover plans in private operator notes.

Remove task-created temporary scripts, probes, staging files, and validation copies on every host after each task. Preserve implementation, requested deliverables, persistent runtime state, user data, and backups covered by an agreed retention plan.
