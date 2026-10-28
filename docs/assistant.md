# Scheduled assistant and natural session boundaries

The opt-in `soma-assistant` component integrates [context management](context-management.md), [confirmed continuity](continuity.md), [long-task progress](progress.md) and the [heartbeat delivery gate](heartbeat-gate.md). Its conversational interface uses the existing model to interpret ordinary requests, including voice transcripts; it makes no separate intent-classification call. It supports the managed Telegram DM gateway and the Hermes revision in `runtimes/hermes/manifest.json`. Other channels and multiplexed profiles fail closed. There are no new dependencies, account connections or upstream upgrades.

## Install and configure

Run `npm run runtime:setup` with an explicit, isolated `SOMA_RUNTIME_HOME`. Setup installs the plugin, its exact delivery-gate copy, and a native `gateway:startup` hook. Installation preserves settings, YAML comments, explicit disablement and existing state. It creates no subscriptions, enables no behavior and installs no cron jobs. The startup bridge starts one plugin-supervised timer only when the component is enabled; repeated startup and reload cannot duplicate it. Native plugin unload cancels the timer. After a restart, the timer resumes persisted subscriptions without waiting for a new message.

While the gateway is idle, merge this neutral example into its private `hermes-home/config.yaml`, preserving other plugin entries:

```yaml
plugins:
  enabled:
    - soma-assistant
  entries:
    soma-assistant:
      settings:
        enabled: true
        timezone: UTC
        greetings: [good morning]
        continuations: [continue, let's continue]
        daily_time: '08:30'
        review_interval_days: 7
        quiet_start: '22:00'
        quiet_end: '08:00'
        minimum_interval_seconds: 3600
        daily_limit: 2
        maximum_age_seconds: 7200
        sources: [continuity, operational]
```

The [settings schema](../runtimes/hermes/assistant-settings.schema.json) defines types and bounds. Feature enablement defaults to `false`, greeting and source lists default to empty, and timezone defaults to `UTC`. Select your own IANA timezone and phrases privately. Quotes around local times avoid YAML numeric interpretation. Invalid settings stop automatic behavior. Remove the component from `plugins.disabled` only when deliberately reenabling it. Restart through the authorized deployment procedure to load new code; do not advance the pinned submodule.

`continuity` permits reading only this subscribing DM's explicitly confirmed ledger, and requires the continuity component to remain enabled. Preparation uses active commitment IDs and revisions; it never copies entry text into assistant state or notifications. `operational` permits only counters produced by this component: unavailable checks/deliveries, turns over ten minutes, and explicit frequency feedback. It does not read logs, prompts, conversation history, provider responses, documents, shell history, credentials or Health OS. No arbitrary paths, scripts, source discovery or model-selected sources are supported.

## Explicit subscription and conversational controls

In an authorized direct conversation, ask in your own words to enable reminders, pause them, change their frequency, focus on open tasks, or review saved agreements. Text and voice use the same conversation. There is no required wording, command, identifier or button. The existing model interprets the request and calls `soma_assistant` or `soma_continuity`; these tool names and their structured arguments are internal.

Enabling follow-ups first returns a proposal describing the configured sources. SOMA explains it in the user's language and asks a short ordinary question. Only a subsequent fresh user reply affirming that proposal allows confirmation. The original turn cannot confirm itself. Negation, unrelated replies and silence never trigger an automatic parser; they continue through the model. Subscription confirmation and continuity changes require separate turns; ordinary notification controls apply directly to the user's explicit request. An operator enabling the plugin alone does not subscribe users or authorize additional sources.

The model handles meaning, including paraphrases and context-dependent replies. This semantic judgment is part of the tool-use trust boundary; it is not a deterministic guarantee about every possible utterance. Prompts explicitly exclude quoted text, retrieved documents, earlier instructions, uncertain voice transcripts and model-generated agreement as authority. The backend independently enforces real Telegram provenance, current authorization, native task-local route/session/message identity, freshness, source bounds, revisions and confirmation on a later message. Cron, subagent, forwarded, edited, bot, group and unproven turns cannot use these tools. Native STT failure/empty/disabled markers revoke voice authorization; the plugin does not transcribe audio or call another provider itself.

Frequency preferences can lower the per-DM daily limit or increase the minimum interval within operator limits, and survive restart. Tool results report the actual bounded values. English and Russian follow-up text follows the language selected by the conversational tool; neither notification text nor the conversational prompt asks the user to run commands or exposes configuration details. Existing slash commands remain an optional operator/debug interface:

| Command arguments | Result |
| --- | --- |
| `status` | Show this DM's subscription and bounded delivery-control metadata. |
| `enable` | Ask for explicit subscription confirmation. |
| `disable` | Cancel this DM's subscription and pending notices; preserve delivery history. |
| `check` | Prepare a fresh bounded commitment snapshot; delivery remains gated. |
| `review` | Prepare a bounded improvement review; delivery remains gated. |
| `pause`, `resume` | Pause delivery, or clear pause and snooze. |
| `snooze MINUTES` | Silence for 1–43200 minutes. |
| `focus commitments`, `focus improvements`, `focus all` | Set this DM's notification topic selection. |
| `mute continuity`, `mute operational` | Persist negative source feedback by silencing the selected configured source. |
| `unmute continuity`, `unmute operational` | Restore eligibility for that source. |

Examples of requests the model can interpret include:

- `поставь уведомления на паузу` / `pause follow-ups`
- `возобнови уведомления` / `resume follow-ups`
- `отложи уведомления на 2 часа` / `snooze follow-ups for 30 minutes`
- `сфокусируй уведомления на задачах` / `focus follow-ups on commitments`
- `сфокусируй уведомления на улучшениях` / `сними фокус уведомлений`
- `уведомления о задачах не полезны` / `уведомления об улучшениях не полезны`
- `верни уведомления о задачах` / `верни уведомления об улучшениях`
- `уведомления слишком частые` / `follow-ups are too frequent`

These are examples, not a grammar or an allowlist. No natural-language phrase consumes an input before inference. A small legacy phrase recognizer only preserves queued delivery for familiar controls while a task is busy; arbitrary paraphrases continue through the runtime's normal busy-input policy. Native authorization and persistent message-ID watermarks reject old or reordered requests. An affirmative reply can confirm only one unexpired proposal in this same user's current session. Pending proposals expire after ten minutes, disappear on restart/unload, and are never automatically retried. If uncertain, SOMA asks a relevant ordinary question rather than prescribing command syntax.

## Scheduling, meaningful change and delivery

A supervised timer checks at most once per minute while the gateway runs. Each owner has one daily preparation after `daily_time` on the configured local date, plus an improvement review after `review_interval_days` elapsed days. Local-day receipts suppress duplicate work in the repeated autumn hour. If the configured time is skipped by the spring transition or the gateway is offline, preparation runs after that time when the gateway next checks. No backlog of past days is replayed.

Preparation is private and separate from notification: pause and quiet hours can suppress delivery while preparation still runs. A commitment notification is meaningful only when there are active confirmed commitments and their ID/revision snapshot changed. It offers to review the next step, without inventing completion, restating health facts or including free-text commitments. An unchanged snapshot stays silent on subsequent days. Completing, cancelling, correcting or forgetting an entry invalidates an older queued result before handoff. Empty snapshots clear pending commitment notifications.

Improvement reviews produce a concise conversational suggestion only when there is concrete bounded evidence: at least three unavailable checks/deliveries, at least three turns exceeding ten minutes, or explicit frequency feedback. Unchanged evidence does not repeat a proposal. Preparation itself cannot apply a proposal, edit code/configuration, install dependencies, restart services, connect accounts or expand permissions. A subsequent explicit user request can adjust bounded personal notification preferences through the conversational tool; operational changes still require the appropriate separately authorized workflow.

Every outgoing notice resolves the native profile-owned route, rechecks current authorization/subscription/configuration and passes through the durable [delivery gate](heartbeat-gate.md). This enforces quiet hours, timezone/DST, pause, snooze, focus, source feedback, minimum intervals, local-day limits, stale evidence and per-source revision watermarks. The transport uses Hermes' native interim-message path and cannot finish or replace a running answer. Unknown or failed delivery is recorded without automatic retry. A crash after reservation may lose a notice; it cannot create a replayed send. An already handed-off network message cannot be recalled by a later pause. Disabling a source does not erase its watermark.

## Natural new-day boundaries

Automatic boundaries are independent of follow-up subscription and require an explicitly configured greeting list. A complete greeting on a later local day can begin a new native session. Continuation phrases take precedence; greetings with extra task text do not trigger. Ordinary messages and same-day greetings continue the existing session. Explicit `/new` and `/reset` keep their native semantics; the next session-ID mismatch establishes a new baseline.

Only an original, authorized Telegram text DM can supply boundary evidence. The first observed message with unavailable, missing or changed session metadata establishes a baseline and never resets. Message-ID receipts and the last observed day survive restart; replay, reorder and backwards-clock cases cannot repeat a boundary. Raw Telegram provenance is checked before native FIFO serialization removes it, then correlated with the admitted message without rewriting its text. Configured greetings and explicit natural controls use the pinned native queue marker so the ordinary plaintext busy policy cannot interrupt a task before the idle check; native authorization, prompt handling and explicit stop/reset fences still apply.

Rotation uses the pinned runtime's FIFO reservation/claim locks and one SQLite transaction for idle verification, child-session creation and the routing compare-and-swap. Queued/started/unknown admissions, registered/running/unknown workers, compression/turn leases, in-memory agents, approvals, pending input, background processes and delegations prevent a reset. Detached side work and concurrent mutations conservatively block it too. Later input binds to the fresh route; no pending input is cancelled. Native cache/conversation cleanup preserves input that arrived during the transaction. Missing or mismatched storage/profile interfaces refuse rotation. The original greeting then proceeds through normal inference in the new session.

The old native transcript remains history. The independent confirmed ledger is untouched and injects a fresh bounded snapshot on the new session's first turn. Compression and new-day rotation therefore do not erase confirmed commitments. The component does not import an old transcript into the new session.

## State, disable and rollback

Assistant metadata lives in owner-only `hermes-home/soma-assistant/metadata.sqlite`, bounded to 64 owner records, 16 KiB per owner and 512 SQLite pages. This subscription index stores minimal routing identities, message/day/session receipts, counters, fingerprints and at most two bounded neutral prepared notices per owner. Each query that reads or changes an owner's contents is bound to that owner. The scheduler enumerates only explicitly subscribed owners; it never enumerates their continuity files or health workspaces. Delivery history remains in the gate's separate per-owner files under `$SOMA_RUNTIME_HOME/soma-heartbeat/`. Keep both directories private and outside both repositories. Unsafe paths, permissions, sidecars, unsupported versions and oversized state fail closed; no automatic repair imports user data.

Conversational evidence is process-local and bounded to 256 fresh turn receipts/results and one pending proposal per owner, at most 64. It expires after ten minutes. Pending continuity text is limited to the ledger's 300 characters and held only in memory until confirmation; no message, transcript, audio path or proposal text is copied to assistant metadata. Unload clears these caches. A restarted/replayed turn must receive a fresh human request to authorize a tool. Confirmed ledger changes keep their existing durable revision/replay protections.

Set `settings.enabled: false` to stop timers, controls and boundaries; add the plugin to `plugins.disabled` and restart to unload its hooks and cancel its supervised task. Per-DM `disable` stops that subscription without disabling boundaries configured by the operator. `pause` suppresses delivery while retaining private preparation. Setup never reenables an explicitly disabled plugin or clears state.

For code rollback, disable the component, restore the accepted SOMA revision and rerun setup. If that older revision predates this component, leave it disabled or remove only its installed `plugins/soma-assistant/` and `hooks/soma-assistant/` code directories before restarting. Preserve assistant and gate state; deleting it discards replay protection and subscriptions. No upstream dependency rollback or Health OS migration is involved. Repeated installation is byte/mtime-idempotent and refreshes only the component's known assets. If an installation fails partway through, rerun it before restart.

See [assistant acceptance](assistant-acceptance.md) for issue coverage and synthetic/manual scenarios.
