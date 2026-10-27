# Heartbeat delivery gate

The SOMA heartbeat gate v1 separates private preparation from permission to notify. It checks an explicitly supplied candidate against quiet hours, freshness, pause/snooze/focus controls, source feedback, frequency limits and persistent replay protection. It runs offline with Python's standard library and the Python interpreter installed for SOMA's pinned Hermes revision. It adds no dependency and does not change the runtime submodule.

This component is a callable delivery boundary and operator CLI. It does **not** yet register daily jobs, collect sources, run improvement reviews, parse natural-language controls, or connect a Telegram transport. Those integrations remain in [issue #2](https://github.com/bknstn/soma-ai/issues/2). Installing or updating SOMA does not enable automatic follow-ups. The existing [long-task progress component](progress.md) has its own live-turn policy.

## Policy and isolation

Copy the [neutral policy example](../examples/heartbeat-policy.json) to an explicit private configuration file outside both source repositories; restrict it to mode `0600`. Enable it deliberately and list only logical producers whose access has separately been authorized. An entry in `sources` does not authorize reading a service, private records or Health OS. There is no wildcard or implicit source discovery. Use synthetic producers during development.

The [policy schema](../runtimes/hermes/heartbeat-policy.schema.json) documents the fields. Omitted fields use the example's defaults, except that the default source list is empty. Unknown fields, invalid IANA timezones, duplicate sources and incorrectly typed values fail closed. `enabled` defaults to `false`.

| Field | Behavior |
| --- | --- |
| `timezone` | IANA timezone for quiet hours and calendar-day limits; default `UTC`. |
| `quiet_start`, `quiet_end` | Local `HH:MM`; start inclusive, end exclusive. Overnight windows work. Equal values disable quiet hours. |
| `minimum_interval_seconds` | Elapsed UTC seconds between **attempts**, 60–86400; default 3600. |
| `daily_limit` | Attempts per local calendar day, 1–32; default 2. |
| `maximum_age_seconds` | Maximum age of the underlying observation, 60–86400; default 7200. |
| `sources` | Up to 16 authorized logical producer IDs. |
| `focus` | Optional topic allowlist; empty means all topics. |

Quiet hours compare each actual UTC instant in the selected timezone. Both instances of a repeated autumn hour receive the same local quiet rule; spring hours that do not occur require no synthetic wake. Rate limiting uses elapsed UTC time, and the calendar cap follows the local date even on 23- or 25-hour days. Changing timezone reinterprets retained attempt timestamps in the new timezone. A backwards wall clock suppresses delivery until it catches up to the last claim or control update.

Choose a new private state directory under the isolated `SOMA_RUNTIME_HOME`, outside the Health OS workspace and both repositories. The gate may create only this leaf; its parent must exist. Directory mode must be `0700`. Each `telegram:USER_ID` owner has a separate SHA-256-named, owner-only SQLite file. No other owner's file is enumerated. Symlinks, hardlinks, unsafe permissions, oversized files, unexpected versions, corrupt databases and unsafe sidecars are refused. The owner is an isolation key; the caller must authenticate the user and route before invoking this module. Same-account OS processes remain trusted.

## Preparation, handoff and recovery

A producer supplies the [candidate envelope](../runtimes/hermes/heartbeat-candidate.schema.json):

```json
{
  "schema_version": 1,
  "owner": "telegram:1001",
  "source": "synthetic-preparation",
  "revision": 1,
  "topic": "planning",
  "observed_at": 1793102400,
  "expires_at": 1793102700,
  "meaningful": true,
  "message": "A synthetic preparation needs your review."
}
```

The example identity and timestamps are synthetic. Generate fresh UTC Unix-second timestamps for an actual check. `observed_at` must describe the underlying evidence, not a fresh timestamp pasted onto an old result. The candidate expires at `expires_at`, even if the policy's maximum age is longer. Future observations are rejected. Messages are bounded to 500 nonblank, single-line characters. Keep detailed health facts in Health OS; send bounded references or neutral proposals instead.

`prepare(candidate)` validates without reading or creating state and returns a copied envelope. The gate does not decide whether a finding is meaningful: the trusted producer must establish a concrete change and set `meaningful` accordingly. False means silence. Do not give an untrusted model response direct authority to select owners, assert evidence, or grant access.

`Gate(state_home, owner, policy).evaluate(candidate, claim=False)` checks eligibility and returns a reason without granting permission or recording an attempt. `claim=True` rechecks controls and reserves the attempt in a SQLite transaction **before** returning a short-lived `send` permit. Construct the gate from the current policy immediately before claiming. The permit contains owner, message, token and UTC creation/expiry times; hand it directly to the authenticated transport, verifying the route and deadline. It expires after at most five seconds, when the evidence becomes stale, at the candidate's expiry, or at the next local minute boundary, whichever comes first. Never queue or replay permits. `check`, `status` and an eligible claim may initialize this owner's empty database.

`Gate.deliver(candidate, send, clock=...)` is an optional synchronous adapter. It claims durably, checks the immediate handoff deadline, calls `send(owner, message, token)` once, and records the result. The transport returns exactly `True` for confirmed success, `False` for confirmed failure, or another value for unknown delivery. Exceptions are recorded as unknown, without persisting error details. There is no built-in network transport. A caller using asynchronous transport must implement the same immediate, bounded handoff contract around `evaluate` and `record`.

Claims count against limits even if delivery fails. `record(token, outcome)` accepts `delivered`, `failed` or `unknown`; identical results are idempotent and contradictory results are refused. An unresolved reservation after a crash remains ambiguous and is never automatically retried. This chooses at-most-once handoff over guaranteed delivery: a crash between reservation and send can lose a notice. A message already handed to a network transport cannot be recalled if pause or a policy edit arrives concurrently.

Each source must use a strictly increasing, persistent integer `revision` for each new underlying change, shared by all of that source's workers for this owner. Rewording or retrying the same change must keep its revision. Once a revision is claimed, the source's high watermark rejects it and all older revisions across restarts, disable/reenable and receipt pruning. Out-of-order older findings are skipped. A new revision must not be invented merely to retry a failed delivery. Reserving a later revision is the producer's assertion that it supersedes earlier findings.

State stores only controls, up to 16 source watermarks and up to 256 attempt receipts; candidate text, preparation output, transcripts, health records and transport errors are never persisted. Receipts older than three days are pruned on a successful claim; watermarks never expire. If source capacity or receipt capacity is reached, delivery refuses rather than dropping replay protection. Retired sources continue to occupy their slots. Storage is limited to 256 SQLite pages and a 1 MiB pre-open file bound. Do not delete state to recover capacity without explicitly accepting loss of replay protection.

## Explicit controls and CLI

The gate accepts authenticated, explicit controls as JSON. A future conversational adapter must map clear user intent to these controls and preserve native authorization; this version does not infer consent from free text or silence.

| Request | Effect |
| --- | --- |
| `{"action":"pause"}` | Pause delivery until an explicit resume. |
| `{"action":"resume"}` | Clear pause and snooze; preserve focus and muted sources. |
| `{"action":"snooze","until":1793106000}` | Silence until an explicit future UTC second, up to 30 days away. |
| `{"action":"focus","topics":["planning"]}` | Restrict to these topics; an empty list allows all. |
| `{"action":"unfocus"}` | Restore the policy's focus list. |
| `{"action":"mute","source":"synthetic-preparation"}` | Persist feedback that this source should stay silent. |
| `{"action":"unmute","source":"synthetic-preparation"}` | Restore eligibility for this configured source. |

All controls persist across process restarts. A delivery policy may be disabled while controls are edited. Configuration and control files contain no credentials and must remain outside Git.

Use the managed interpreter from the explicit runtime's `hermes-python.txt`. This example uses privately chosen paths, with a synthetic identity:

```sh
soma_gate_python="$(cat "$SOMA_RUNTIME_HOME/hermes-python.txt")"
"$soma_gate_python" -I -B runtimes/hermes/heartbeat-gate.py \
  --state-home "$SOMA_RUNTIME_HOME/soma-heartbeat" \
  --config /absolute/private/heartbeat-policy.json \
  --owner telegram:1001 status
```

Actions `prepare`, `check`, `claim`, `control` and `record` read one JSON request from stdin, up to 8192 bytes. `record` takes `{"token":"RETURNED_TOKEN","outcome":"unknown"}`. Responses use `schema_version: 1`, `ok`, and `data` or a sanitized error code. Only an explicitly successful `claim` prints message text. Do not log permits or redirect them into public artifacts. The CLI has no send action. The library `prepare` API returns private data only to its caller; the CLI's `prepare` action returns an acknowledgment.

## Disable, upgrade and acceptance

Set `enabled: false` to stop new claims, or use `pause` for this owner. Neither action deletes watermarks or delivery history. This gate lives in SOMA's versioned source and does not install plugin hooks or schedules. Deploy the reviewed source revision to upgrade; revert to the accepted prior version or stop calling the gate to roll back. Version 1 refuses unsupported state versions without deleting them. No gateway restart, dependency update or Health OS migration is needed for this standalone component.

`npm test` runs synthetic contracts for strict schemas, clock rollback, repeated and missing DST hours, local-day boundaries, restart replay, concurrent claims, failed/ambiguous transport, stale candidates, source/owner isolation, controls and unsafe storage. CI repeats the suite with the pinned managed interpreter. Every fixture is disposable and removed after the test.

For manual acceptance in a disposable runtime, prepare a fresh synthetic envelope, verify silence with `meaningful: false`, pause/snooze and quiet hours, then claim once outside quiet hours. Record an unknown result, restart the caller and replay the same revision: it must remain silent. Try a different owner, a stale envelope and two simultaneous claims. Confirm neither candidate text nor error detail exists in SQLite. Remove only the disposable test state afterward. A live scheduled follow-up acceptance scenario requires the future scheduler and authorized transport integration.
