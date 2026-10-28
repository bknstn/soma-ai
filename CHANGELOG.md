# Changelog

All notable changes to SOMA are recorded here, newest first. Versions follow
Semantic Versioning. See [the release guide](docs/releases.md).

## [Unreleased]

## [0.2.1] - 2026-10-28

### Fixed

- Made concise, outcome-first replies the default for conversation, voice, reports
  and failures; detailed explanations are given on request. Health reports retain
  essential constraints, units, sources and uncertainty.
- Added a managed response-style block that setup installs and refreshes in existing
  personas without replacing operator text. Shortened default progress and scheduled
  follow-up messages; existing custom progress messages remain unchanged.

### Upgrade

- Rerun managed runtime setup with the explicit `SOMA_RUNTIME_HOME`, then restart chat
  or the gateway to load the style policy and updated plugins.

## [0.2.0] - 2026-10-28

### Fixed

- Clarified reply-language selection for text and voice: follow the current user's
  language rather than English gateway labels, and refresh this policy in existing
  managed personas during runtime setup while preserving custom instructions.
- Enabled automatic speech-language detection during setup, replacing Hermes'
  inherited English hint and built-in provider language overrides without changing
  provider/model selection or credentials.

### Upgrade

- Rerun managed runtime setup with the existing explicit `SOMA_RUNTIME_HOME`, then
  restart chat or the gateway to load the updated response-language policy.
  Setup clears forced input-language hints for built-in speech providers.

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
