# SOMA repository guidance

## Product and privacy

- SOMA is a public, forkable body, health, sleep, and activity assistant. The current product slice is a manually run training-preparation flow; it is not a completed hosted product.
- Develop with neutral templates and fully synthetic examples only. Do not search for, read, import, or use the repository owner's personal records, private workspaces, documents, history, memories, or health accounts.
- Keep the Health OS workspace outside both repositories. Never commit `.env` files, `.health-os/` state, credentials, raw documents, or complete health-context output.
- Do not connect live health accounts as part of ordinary development. Tests and examples must use synthetic data or fixtures.

## Integration boundary

- Use the Health OS CLI as a subprocess with explicit repository and workspace paths. Do not copy the engine or import its internal modules.
- Keep the supported Health OS revision pinned in SOMA configuration and documentation. A different revision needs a compatibility review.
- The first SOMA flow is read-only after explicit workspace initialization. Do not add writes to the training-preparation flow.
- Avoid external runtime dependencies in the core unless the product requirement calls for them.

## Temporary files

- After each task, remove temporary scripts, probes, scratch files, and validation copies created only for that task, including on remote hosts. Prefer stdin or inline commands when a saved helper is unnecessary.
- Track temporary paths and verify removal before reporting completion. Preserve requested deliverables, implementation code, installed integrations, and pre-existing user files.
