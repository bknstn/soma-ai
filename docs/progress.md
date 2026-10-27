# Long-task progress

SOMA's opt-in `soma-progress` v1 component sends one brief status notice when a direct Telegram request takes longer than a configured interval. It uses the hooks, live turn state, supervised tasks, profile-aware message resolver, and interim-message transport of the Hermes revision pinned in `runtimes/hermes/manifest.json`. It does not call a model, inspect transcripts, read health data, or invent a percentage or a completed step.

## Installation and configuration

Run `npm run runtime:setup` with an explicit isolated `SOMA_RUNTIME_HOME`. Setup installs the component and adds its plugin selection unless explicitly disabled, preserving existing settings. The feature defaults to off. It creates no schedule, database, or persistent progress history, and adds no dependencies.

While the gateway is idle, merge this example into private `hermes-home/config.yaml`, preserving unrelated settings and plugin selections:

```yaml
agent:
  gateway_notify_interval: 0
plugins:
  enabled:
    - soma-progress
  entries:
    soma-progress:
      settings:
        enabled: true
        interval_seconds: 60
```

Set `agent.gateway_notify_interval: 0` to disable Hermes' separate repeating "still working" notifier. A nonzero `HERMES_AGENT_NOTIFY_INTERVAL` environment override can reenable that notifier; remove such an override in private operator configuration. This SOMA component does not alter Hermes' other tool, timeout, streaming, or recovery notifications. Remove `soma-progress` from `plugins.disabled` if it was explicitly disabled, then restart the managed gateway through your deployment procedure.

The [settings schema](../runtimes/hermes/progress-settings.schema.json) describes the `settings` object:

| Setting | Meaning |
| --- | --- |
| `enabled` | Boolean, default `false`; strings and numbers do not enable the feature. |
| `interval_seconds` | Integer from 15 to 3600, default 60. Measured from the native user-turn start hook using a monotonic clock. |
| `message` | Optional single line of 1–240 characters. Default: "The current request is still running. I will send the result when it is ready." Localize this factual notice if needed. |

Invalid values disable notices. Keep a customized message factual: the component knows that the request is still running, not how much is complete. Configuration changes require a restart to reload native plugin settings; interval/text selection applies when a new turn starts.

## Delivery and task lifecycle

Only a bound, authorized, native Telegram text DM from its own user is eligible. The component requires matching sender/session identities, the real source message and native Telegram sender, chat and message IDs. It excludes groups, topics, bot/via-bot/relay messages, forwarded or edited messages, media, internal/scheduled/delegated tasks, startup replay and unknown event metadata. Missing identity, live state, or pinned runtime interfaces results in silence. Queued user input may receive its own notice once its actual user turn begins; queue entries are never changed or removed.

The inbound observer checks native authorization and direct-message provenance, retaining only a routing key, message/user IDs and a timestamp. A separate post-admission observer marks the receipt after the gateway's own access/prompt gates. This lets progress follow the native durable FIFO, whose reconstructed events intentionally omit raw Telegram objects. Receipts are process-local, single-use, limited to 256 and expire after six hours. Missing, expired, evicted, already-used or restart-lost receipts cause silence. No message text or raw SDK object is kept in these receipts. Neither observer consumes, rewrites, or admits input.

The timer checks the exact native agent object, source event, conversation ID and monotonic execution generation. Completion, interruption, cancellation, replacement, session changes and gateway shutdown prevent a pending notice from starting. It rechecks after asynchronous route resolution, so a slow resolver cannot deliver a result for a displaced task. The resolved profile and DM route must still match. Notices use Hermes' interim transport and do not replace or seal the final answer stream.

Native approval and human-input hooks suppress progress while the request waits for the user. Each wait has a correlated identity; nested waits must all resolve. After a wait resolves, the full interval starts again. Uncorrelated or overflowing wait metadata conservatively suppresses progress for the rest of that turn. Stale replies cannot unblock another turn. The component ignores hook prompt/transcript payloads.

Each turn gets at most one delivery attempt. A refusal, transport error or ambiguous outcome is not retried, avoiding duplicate notices. An attempted marker lasts until turn completion; duplicate start hooks cannot schedule another attempt. State is process-local and bounded to 128 tracked turns, with at most one supervised timer per turn and a six-hour timer lifetime. Full tracking capacity fails silently. Restart discards timers; it does not restore or replay notices. Native recovery events are excluded, rather than resending an old task's status.

The final guard runs before transport handoff. A message already handed to the messaging service cannot be recalled if completion or cancellation arrives while the network send is in flight. Ordinary network latency also means delivery may occur after that last guard. No final-answer or user-input handling waits for the progress message.

This component covers live long-task status only. Natural new-day session boundaries and scheduled preparation/review delivery gates remain separate work in [issue #2](https://github.com/bknstn/soma-ai/issues/2). The pinned manual `/new` command can cancel work and queued input; greeting text is deliberately not rewritten into that command.

## Disable, upgrade and rollback

Set `plugins.entries.soma-progress.settings.enabled: false`, or add `soma-progress` to `plugins.disabled`, and restart. Native unload cancels supervised timers and clears registrations/state. Repeated setup refreshes component files atomically per file, preserves settings, comments and explicit disable choices, and does not create duplicate jobs. If interrupted during installation, rerun setup before restarting.

To roll back, disable the plugin or restore an accepted SOMA revision and rerun setup. There is no progress database or health-state migration. Restore your previously selected native `agent.gateway_notify_interval` separately if you want its repeating notifier back; disabling SOMA progress does not silently change that setting.

## Synthetic acceptance

1. In a disposable runtime, bind a synthetic Telegram DM and fake transport. Advance a fake monotonic clock past the interval during one live task; verify one factual interim notice, with the final answer channel still available.
2. End or cancel the task before the deadline, replace its generation or session, or finish it while route resolution is suspended; verify silence. Reemit the same start hook and simulate a failed send; verify no second attempt.
3. Open nested native approval and clarification requests. Advance time while waiting; verify silence. Resolve only one; verify continued silence. Resolve all; verify that a full fresh interval must pass before notification.
4. Bind another user, a group, a forwarded/edited/internal event, a missing identity, or an unbound call; verify no cross-route delivery. Unload while a timer is pending; verify timer cancellation and no late message.
5. Repeat installation, upgrade, disable and rollback in the disposable home. Verify retained unrelated config and settings, no jobs or ledger creation, and removal of temporary validation files.

`npm test` covers deterministic policies and synthetic transport/lifecycle cases. CI additionally runs `tests/progress_native_test.py` through the pinned loader, inbound/admission hooks, durable input codec, actual turn-context collector, human-input hooks, turn-state interface, supervised-task cleanup and interim send implementation. Network access and reads of credential/history files are forbidden in that test.
