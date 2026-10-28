# Changelog

All notable changes to SOMA are recorded here, newest first. Versions follow
Semantic Versioning. See [the release guide](docs/releases.md).

## [Unreleased]

## [0.1.0] - 2026-10-28

First release baseline for the existing SOMA implementation. This starts the
release history; it does not declare a stable 1.0 API.

### Added

- Manual training preparation through the pinned Health OS CLI, with bounded
  context and explicit workspace initialization.
- Isolated, pinned Hermes runtime with conversational skills, local chat,
  Telegram gateway, and self-hosting templates.
- Allowlisted profile and workout-history reads, with explicitly confirmed,
  operator-gated workout and working-weight writes.
- Validated context policy controls and opt-in continuity, progress notices,
  scheduled assistance, and heartbeat delivery controls.
- OpenAI web search through a managed Hermes plugin, using the existing API key
  and returning cited sources without sending local health context.
- Product version reporting, release checks, and a tag-driven GitHub release
  workflow.

### Limitations

- Early development: interfaces may change under the documented 0.x policy.
- Requires operator-managed dependencies, isolated state, and provider setup
  for conversational use. It is not a hosted or clinically validated product.
