# Privacy model for the initial milestone

This repository is public and must remain free of personal health information. Development, documentation, and automated checks use only neutral templates and synthetic records.

## Data locations

- **SOMA source:** public code and generic instructions. It must not contain a user's profile, event history, observation exports, memory, or credentials.
- **Health OS checkout:** executable framework source pinned to a reviewed revision.
- **Private Health OS workspace:** the user's profile, structured records, imported documents, derived memory, and local engine state. Keep it outside both checkouts.
- **Hermes runtime home:** the pinned runtime's isolated Python environment, configuration, sessions, skills, and provider credentials. Keep this new `SOMA_RUNTIME_HOME` outside both checkouts; its `hermes-home` is separate from `~/.hermes`.
- **Credentials:** keep model-provider credentials in the isolated Hermes home or another user-selected secret store, never in source, the Health OS workspace, examples, or fixtures.

The SOMA `.gitignore` blocks common workspace and secret paths, but it is not a substitute for keeping the workspace outside the repository.

## First-scenario access

`doctor` reports version, compatibility, schema, command availability, and workspace status without returning health contents. `init` is an explicit local write that creates a neutral template at the configured path. `prepare-training` reads the initialized workspace and returns a bounded SOMA summary. JSON mode includes the selected profile excerpt (up to 2,000 characters), bounded subjective facts/signals, and up to three memory excerpts with review and provenance metadata. Blocked, missing, or empty memory returns no evidence. The human-readable formatter omits private context excerpts. A conversation that uses the JSON response can send those private excerpts to the provider configured in the isolated Hermes home; review that provider's data handling before using private records. Health OS may create or update auxiliary SQLite WAL/SHM files during a read; it does not change health-domain records for this operation.

Hermes is SOMA's conversational runtime. Its source is pinned as a Git submodule; setup and launch use only the explicit `SOMA_RUNTIME_HOME` and do not import `~/.hermes` settings or credentials. Runtime setup, doctor, and local help/skill inspection do not need a model-provider key. The adapter passes only allowlisted provider environment variables during chat; setup and doctor do not inherit them. A chat may send messages and any private preparation summary included in the conversation to the provider configured in that isolated Hermes home. Review the provider's data handling before using private records. The `soma-health` skill invokes read-only training preparation. The separately installed `soma-health-actions` skill supports bounded profile/history reads and explicit writes; it does not initialize a workspace, set up a provider, or expose connector sync.

The separate `soma-health-actions` skill can retrieve the selected profile and bounded workout history, then perform explicit workout/working-weight writes. These reads return private excerpts to the configured model provider when used in a conversation; JSON is required and the human formatter omits private content. The skill does not expose arbitrary Health OS commands or access runtime memory. A direct request to write is sufficient when all values are clear; it asks only about missing or ambiguous fields. The additional operator-controlled `SOMA_HEALTH_ACTION_MODE` defaults to `read-only`; switching it to `confirmed-writes` is a workspace-ownership decision, not a skill/user option. `--confirmed` cannot override that gate. The mode is an application workflow guard, not an OS sandbox; the service operator controls its private configuration. Latest-workout reads require an explicit date cutoff from the configured local calendar; SOMA does not derive the date from UTC. Explicit native item truncation yields a metadata-only partial result and cannot be used as a full workout. Native idempotency protects exact retries, while pending journals, conflicts, timeouts, and malformed results require reconciliation and are not treated as success. Health OS legacy workout CSV writes still span multiple files rather than one transaction.

The isolated `HOME` and Hermes profile are path boundaries, not an operating-system sandbox; Hermes tools have the same permissions as the user who launched SOMA.

## Development rules

- Never inspect the repository owner's private workspaces, app records, documents, history, or connected health accounts while building the public product.
- Use fabricated names, values, dates, and source labels in test fixtures.
- Do not copy generated full JSON outputs into documentation or bug reports.
- Keep real API tokens, OAuth refresh tokens, raw source files, and workspace backups out of Git.
- Use only a disposable runtime home for automated checks; never test against an existing Hermes installation or live model account. Offline checks do not need provider credentials.
- Treat each future connector or write flow as a separate privacy and provenance review.
