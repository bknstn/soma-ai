# SOMA repository guidance

## Product and privacy

- SOMA is a public, forkable AI agent for understanding and caring for the body as a whole. Its goal is to connect wearable data with daily activities and habits. The current product slice is a manually run training-preparation flow; it is not a completed hosted product.
- Develop with neutral templates and fully synthetic examples only. Do not search for, read, import, or use the repository owner's personal records, private workspaces, documents, history, memories, or health accounts.
- Keep the Health OS workspace outside both repositories. Never commit `.env` files, `.health-os/` state, credentials, raw documents, or complete health-context output.
- Do not connect live health accounts as part of ordinary development. Tests and examples must use synthetic data or fixtures.
- Hermes runtime state belongs in a new, explicit `SOMA_RUNTIME_HOME` outside both repositories. Never read, import, or reuse `~/.hermes`, its credentials, sessions, memories, or skills.
- Keep the Hermes source revision in the committed submodule and runtime manifest. Do not advance the submodule to a newer upstream revision without a compatibility review.
- CI and tests may install the pinned runtime and launch offline help/skill checks, but must not call a live model provider or use real provider credentials.

## Integration boundary

- Use the Health OS CLI as a subprocess with explicit repository and workspace paths. Do not copy the engine or import its internal modules.
- Keep the supported Health OS revision pinned in SOMA configuration and documentation. A different revision needs a compatibility review.
- The first SOMA flow is read-only after explicit workspace initialization. Do not add writes to the training-preparation flow.
- Keep the core Node CLI free of npm runtime dependencies. The pinned Hermes conversational runtime is an explicit product dependency, isolated from the Health OS workspace.

## VPS operations

- Read `docs/vps.md` before deployment or migration work. Use `npm run vps:ssh` or `sh scripts/vps-ssh.sh` for SSH; both use the local `hermes-vps` alias by default, shared with AI Buddy. `ASSISTANT_VPS_SSH_HOST` overrides the alias.
- SSH resolves the host, user and existing key from the operator's local SSH configuration. Never copy private keys or authentication material into either repository.
- The initial deployment uses the existing SSH account with a separate `$HOME/soma` tree and `hermes-soma.service`. These are planned conventions; inspect live state before creating or changing them.
- Keep SOMA runtime state and the Health OS workspace separate from Buddy. Test the new Telegram bot with neutral or synthetic data before a separately scoped migration; do not inspect or import Buddy's private records during deployment preparation.

## Temporary files

- After each task, remove temporary scripts, probes, scratch files, and validation copies created only for that task, including on remote hosts. Prefer stdin or inline commands when a saved helper is unnecessary.
- Track temporary paths and verify removal before reporting completion. Preserve requested deliverables, implementation code, installed integrations, and pre-existing user files.
