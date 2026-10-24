# Product roadmap

SOMA is an AI agent for understanding and caring for the body as a whole. Its goal is to connect wearable data with daily activities and habits to help people understand their body's state and how it changes over time. Each person chooses what information to keep in their private workspace and which sources to connect. The roadmap is intentionally staged; the current repository targets the first manual workflow.

## Initial milestone: manual training preparation

The first vertical connects SOMA to the pinned Health OS CLI, initializes an explicitly selected neutral workspace, and prepares a training session for an exact cutoff. It presents a concise plan with its reasons, sources, and gaps. This is a local manual workflow, not a hosted service.

The initial milestone does not include:

- A hosted multi-user service, account system, or web/mobile interface
- A background scheduler or automatic notifications
- SOMA-managed live connector setup or sync
- Sleep, activity, or general health check-in conversations beyond fields already returned by Health OS for training preparation
- Automated import of personal documents or migration of existing records

## Next product slices

These are possible follow-on slices, not promises of shipped functionality:

1. **Check-ins and event capture:** add explicit user-confirmed notes through Health OS, with corrections, provenance, and a review gate for derived memory.
2. **Sleep and activity views:** present provider-neutral observations already stored in the private workspace and preserve source coverage and unavailable states.
3. **Workout logging:** record completed sessions through the supported Health OS CLI and explain revision or replay conflicts.
4. **Optional connectors:** add a user-directed setup path for data sources only after privacy, secret storage, and sync failure behavior are defined.
5. **Delivery surfaces:** consider schedules, notifications, or hosted interfaces only after the local workflow and data-access policy are stable.

## Product principles

- User-owned data stays outside the public repositories.
- Begin with synthetic data and neutral templates; do not personalize the public skeleton with real records.
- Use Health OS as the data and calculation engine through its versioned CLI.
- Preserve provenance, uncertainty, timestamps, coverage, and unavailable states.
- Ask for explicit user action before workspace initialization, writes, connector authorization, or data migration.
- Keep model use optional and make tool outputs auditable.
