# Privacy model for the initial milestone

This repository is public and must remain free of personal health information. Development, documentation, and automated checks use only neutral templates and synthetic records.

## Data locations

- **SOMA source:** public code and generic instructions. It must not contain a user's profile, event history, observation exports, memory, or credentials.
- **Health OS checkout:** executable framework source pinned to a reviewed revision.
- **Private Health OS workspace:** the user's profile, structured records, imported documents, derived memory, and local engine state. Keep it outside both checkouts.
- **Credentials:** outside source and workspace files unless a specific provider flow documents otherwise; never add them to examples or fixtures.

The SOMA `.gitignore` blocks common workspace and secret paths, but it is not a substitute for keeping the workspace outside the repository.

## First-scenario access

`doctor` reports version, compatibility, schema, command availability, and workspace status without returning health contents. `init` is an explicit local write that creates a neutral template at the configured path. `prepare-training` reads the initialized workspace and returns a bounded SOMA summary. The summary omits raw profiles, events, observations, metrics, and memory evidence. Health OS may create or update auxiliary SQLite WAL/SHM files during a read; it does not change health-domain records for this operation.

Hermes is SOMA's intended conversational runtime. If a private summary is used in a Hermes session, it can become part of the session context sent to the model provider configured for that Hermes profile. Do not use remote messaging surfaces for private health context unless their data handling is acceptable to the user. The included skill only invokes the read-only SOMA preparation command; it does not set up accounts or change Hermes configuration.

## Development rules

- Never inspect the repository owner's private workspaces, app records, documents, history, or connected health accounts while building the public product.
- Use fabricated names, values, dates, and source labels in test fixtures.
- Do not copy generated full JSON outputs into documentation or bug reports.
- Keep real API tokens, OAuth refresh tokens, raw source files, and workspace backups out of Git.
- Treat each future connector or write flow as a separate privacy and provenance review.
