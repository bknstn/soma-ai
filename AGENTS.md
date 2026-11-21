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

## Delivery workflow

For maintainer-requested changes to SOMA, complete the following workflow unless
the request limits the scope. This standing instruction covers committing and
pushing the requested changes and deploying to the maintainer's configured VPS.

1. Implement and validate the change. Apply the public-repository safety gate,
   then commit only the files for the task.
2. Decide whether the product version needs a bump using `docs/releases.md`.
   Before 1.0, use a minor bump for new features or breaking changes and a patch
   bump for compatible fixes. From 1.0, use a major bump for breaking changes,
   minor for compatible features and patch for compatible fixes. Instruction and
   documentation changes alone can keep the current version. When a bump is
   needed, update `package.json` and `CHANGELOG.md`, validate the release metadata,
   and commit it before deploying.
3. Push the reviewed commits and verify that the intended remote branch has the
   deployment revision. Follow `docs/releases.md` for release tags.
4. Follow `docs/vps.md` to deploy the published revision to the verified VPS.
   Apply the relevant runtime or skill updates and restart services when needed
   to load the change. Verify the deployed revision and affected service with
   synthetic checks where applicable. A documentation-only change needs only a
   checkout update on the VPS.
5. Verify that the local and VPS working trees are clean. Report the published
   commit, product version and deployment verification. Report any blocked or
   unverified step explicitly.

## VPS operations

- Read `docs/vps.md` before deployment work. Set `SOMA_VPS_SSH_HOST` explicitly before using `npm run vps:ssh` or `sh scripts/vps-ssh.sh`; the wrapper has no default host.
- SSH resolves the host, user and existing key from the operator's local SSH configuration. Never copy private keys or authentication material into either repository.
- Keep hostnames, account choices, service inventory, actual deployment paths, and migration plans in private operator configuration or notes. Public documentation and templates must use generic examples.
- Keep SOMA runtime state and the Health OS workspace separate from other applications. Inspect the explicitly selected deployment target before creating or changing paths or services, and test with neutral or synthetic data. Do not inspect or import private records during deployment preparation.

## Temporary files

- After each task, remove temporary scripts, probes, scratch files, and validation copies created only for that task, including on remote hosts. Prefer stdin or inline commands when a saved helper is unnecessary.
- Track temporary paths and verify removal before reporting completion. Preserve requested deliverables, implementation code, installed integrations, and pre-existing user files.

## Open-source repository safety

This repository is intended to be public/open source.

Before modifying, committing, or publishing code, read and follow
`OPEN_SOURCE_REPO_SAFETY.md`.

Treat the rules in that document as mandatory repository-level instructions.

Before every commit:
- review the complete staged diff;
- apply the pre-commit safety gate defined in `OPEN_SOURCE_REPO_SAFETY.md`;
- remove or generalize private operational details;
- never commit secrets, credentials, personal data, employer/client information,
  proprietary context, or maintainer-specific deployment configuration.

If you are uncertain whether some information is safe for a public repository,
do not commit it. Prefer a generic placeholder or ask for clarification.
