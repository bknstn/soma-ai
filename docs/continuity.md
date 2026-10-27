# Confirmed continuity

SOMA's `soma-continuity` v1 component keeps a small record of explicitly confirmed agreements, preferences, open commitments, and Health OS references. It is compatible with the Hermes revision pinned in `runtimes/hermes/manifest.json`. It supports authorized Telegram direct conversations; group chats, other surfaces, scheduled jobs, subagents, and missing routing identities receive no continuity context.

## Install and enable

Run `npm run runtime:setup` with the explicit isolated `SOMA_RUNTIME_HOME`. Setup installs or refreshes the plugin without creating a ledger, enabling the feature, changing existing preferences, or adding scheduled jobs. Repeat setup preserves an explicitly disabled plugin. No npm runtime dependency is added.

While the gateway is idle, merge the following into private `hermes-home/config.yaml`, preserving existing plugin selections and entries:

```yaml
plugins:
  enabled:
    - soma-continuity
  entries:
    soma-continuity:
      settings:
        enabled: true
```

The [settings schema](../runtimes/hermes/continuity-settings.schema.json) describes this plugin's `settings` object. The only setting is a boolean `enabled`, default `false`; truthy strings do not enable it. Remove `soma-continuity` from `plugins.disabled` if it was explicitly disabled. Restart the managed gateway using your authorized deployment procedure to load new plugin code. Do not change the pinned submodule or copy another Hermes home's state.

## Explicit commands and consent

Use `/soma-continuity` in an authorized Telegram DM. Telegram may display the command with an underscore, `/soma_continuity`; the pinned dispatcher normalizes it. SOMA does not expose a model-callable writer or infer entries from transcripts.

| Command arguments | Result |
| --- | --- |
| `list` (or no arguments) | Show this user's current entries, IDs, statuses, and revision numbers. |
| `add agreement Use concise explanations` | Propose a reusable, non-health agreement. |
| `add preference Prefer short checklists` | Propose a preference. |
| `add commitment Review the synthetic plan` | Propose an open commitment. |
| `add health_reference health-os:profile/training` | Store a pointer, without reading Health OS. |
| `correct ENTRY_ID Revised text` | Replace text while retaining the ID and origin provenance. |
| `complete ENTRY_ID` | Mark a commitment completed. |
| `cancel ENTRY_ID` | Mark an entry cancelled. |
| `forget ENTRY_ID` | Remove the entry's text and provenance from this ledger. |

Every mutation displays its exact proposal in Hermes' native confirmation picker. Only the command user's explicit **Confirm** response permits a write. Cancel, timeout, unavailable UI, other text, and silence leave entries unchanged. Detailed health facts, measurements, records, and documents belong in Health OS; use `health_reference` for a bounded `health-os:` pointer. Free-text agreements and preferences are user-selected, so the operator and user must keep health facts out of them too. This component does not classify or ingest personal health records.

Existing commands remain available when no conversation session has been created yet, provided the native DM route and message ID exist. Missing message provenance refuses writes. Corrections check the exact revision shown in the confirmation; a concurrent change requires reviewing a fresh proposal.

## Bounded storage and context

Each DM user has a separate database under `$SOMA_RUNTIME_HOME/hermes-home/soma-continuity/`. Filenames use a SHA-256 digest of the Telegram user/chat identity; identities are not interchangeable across platforms. The component never enumerates other users' ledgers or reads conversation history, auth stores, credentials, or health files. Keep the runtime directory private and outside both source repositories. Files are owner-only; symlinks, hardlinks, public permissions, unsupported versions, and oversized database files are rejected. Same-account operating-system processes remain trusted, as with the rest of the isolated runtime.

Each user's ledger permits 40 entries, each with at most 300 characters of single-line text. Full storage refuses additions instead of silently evicting a commitment. Completed and cancelled entries still count until explicitly forgotten. Entries contain stable IDs, revision numbers, timestamps, original and latest confirmation provenance. Provenance includes the originating message ID, a digest of its session route/ID, and the explicit command-and-picker method. It does not retain the full conversation, command transcript, or earlier versions of corrected text.

SQLite transactions serialize writes and preserve state across process restarts. The latest 256 mutation receipts make recent redelivery idempotent, including after forgetting an entry. A persistent high watermark of confirmed Telegram message IDs rejects older or edited replay commands after those receipts expire. Out-of-order older commands must be sent again as new messages. The watermark and text-free receipts survive forgetting, preventing replay from resurrecting forgotten content. Database growth is bounded to 512 SQLite pages; failed transactions roll back. `forget` removes text with SQLite secure-delete enabled; external backups and filesystem snapshots have their own retention rules.

On each eligible user turn, the pinned `pre_llm_call` hook reads only that user's ledger and supplies at most 4000 characters of current active entries as user-context data. It never loads the entire history. Open commitments take priority, then other recent entries. Entries are included whole; an explicit included/total count exposes omissions. Completion, cancellation, correction, and forgetting affect the next turn's snapshot. An empty snapshot explicitly supersedes earlier continuity snapshots. Native compression cannot destroy the independent ledger; the next turn reconstructs its bounded context. This does not make lossy summarization lossless or guarantee that all 40 entries fit in every prompt.

The component uses task-local routing and matches the current session and sender, refusing unbound, stale, scheduled, delegated, group, or other-user contexts. It does not schedule work, deliver follow-ups, start a new session, or notify anyone by itself. The opt-in [scheduled assistant](assistant.md) can read active commitment IDs/revisions for explicitly subscribed DMs and add safe new-day boundaries. [Progress notices](progress.md) have a separate live-turn policy. Continuity mutations remain explicit commands with native confirmation.

## Disable, upgrade, and rollback

Set `plugins.entries.soma-continuity.settings.enabled: false` to stop command mutations and context injection. To unload the component, add it to `plugins.disabled` and restart the gateway. Keep existing ledger files for a later reenable; setup never deletes or imports them. Repeated installation refreshes code atomically per file and preserves unrelated configuration, YAML comments, quotes, and mutable state. If installation fails partway through, rerun it before restarting. The installer detects intervening config edits, but does not lock unrelated writers; configure while idle.

To roll back code, restore the previously accepted SOMA revision and rerun setup or disable this plugin before restarting. An older component must refuse an unsupported database version. No upstream runtime migration, dependency update, scheduled-job cleanup, or Health OS rollback is involved. Deleting a user's database requires separate operator intent and discards its replay protection as well as entries.

## Synthetic acceptance

1. Use a disposable runtime, synthetic Telegram identity, and fake confirmation picker. Propose an entry, cancel or time out, and verify no entry exists. Confirm it and record its stable ID.
2. Recreate the component against the same disposable storage and replay the message; verify only one entry. Correct it, complete it, cancel it, and forget it, checking explicit confirmation and revision handling each time.
3. Bind a new synthetic conversation for the same DM. Verify the next user turn receives current active entries without loading history. Bind a different user, a group, a cron task, a delegated task, an absent identity, and a stale session; verify none receives the first user's entries.
4. Fill the ledger and prompt budgets with synthetic text. Verify explicit full-storage failure, deterministic context selection, a truthful included/total count, and no truncated entries. Verify an old replay cannot restore forgotten text after receipt eviction.
5. Repeat setup, disable and reenable, and unload the plugin. Verify preserved configuration/state and removed registrations. Remove the disposable runtime and confirm all temporary files are gone.

`npm test` covers synthetic transactions, consent, limits, replay, isolation, unsafe paths, and installer idempotence. CI also runs `tests/continuity_native_test.py` against the pinned runtime's real loader, slash-command confirmation API, task-local session context, hook dispatch, and unload lifecycle, with network and private-state reads forbidden.
