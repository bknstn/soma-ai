# Operator-managed Oura refresh and history repair

Training preparation reads saved data. It neither fetches Oura nor fills missing
historical observations. The legacy recovery CSVs and source-scoped observation
store are separate; migrating the workspace files does not convert one to the other.
Do not lower baseline thresholds or label unscoped CSV rows as Oura to hide that gap.

`npm run health:sync` is a separate, operator-only single-day fetch with native
journaling and a read-back check. It is not exposed through the conversational
health-action interface. It uses the pinned Health OS CLI as a subprocess, never
imports engine internals, and does not call a model provider. The ordinary training
flow remains read-only. Real provider calls require the owner's explicit scope;
development and CI use synthetic transports only.

## Configure a private instance

Keep `HEALTH_OS_REPO` and `HEALTH_OS_WORKSPACE` explicit and outside each other;
the workspace must also be outside SOMA. Set `TZ` to the operator's IANA timezone.
Create an owner-only credential environment file outside both repositories and the
workspace containing exactly `HEALTH_OS_REPO`, `HEALTH_OS_WORKSPACE`,
`OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`, and `OURA_TOKEN_FILE`.
Use an already authorized, owner-only token file outside the workspace and both
repositories. Keep actual values private. The sync child loads this file with
Node's `--env-file`; the parent never receives its credential values or token contents.
Other provider/model credentials are not forwarded to the child.

Copy [the operator environment template](../deploy/systemd/oura-sync.env.example)
outside the checkout. Review the selected workspace, credentials and ownership,
then explicitly enable `SOMA_HEALTH_ACTION_MODE=confirmed-writes` in that service's
private environment. This independent process has its own operator gate; disabling
gateway writes does not stop it. To suspend all health writes, stop this timer and
service as well as disabling the gateway's write gate. Do not enable a second
uncoordinated writer during a workspace ownership handoff.

With those private path/mode settings exported, run a specific authorized day:

```sh
npm run health:sync -- --date YYYY-MM-DD --request-id OWNER_REQUEST_ID
```

The default date comes from `TZ`, and future/invalid dates are rejected. The native
key is `oura:DATE:REQUEST_ID`; without a request ID it uses `soma-daily-sync`.
Reuse that exact identity after a reviewed interrupted attempt. A timeout, pending
or malformed journal result, or read-back mismatch stops without an automatic retry
or a replacement key. A verified completed request may be refreshed later under a
new, explicitly authorized occurrence identity. The command's small JSON result
contains no measurements and makes no training/readiness recommendation. An empty
provider response is an error, distinct from missing baseline coverage.

## Daily freshness

Adapt the [service](../deploy/systemd/soma-oura-sync.service) and
[timer](../deploy/systemd/soma-oura-sync.timer) privately. Choose a timezone and time
before the first report, verify the rendered units with `systemd-analyze --user verify`,
then enable the timer. Provider credentials stay out of both the source tree and the
general gateway environment. `Persistent=true` refreshes the current local day after
downtime; it does not invent old scheduled occurrences or silently backfill history.
The timer does not send chat messages. Check its failure status through the operator's
service monitoring. A successful service exit requires a matching stored observation;
offline tests and unit installation alone do not establish a successful live fetch.

## Repair an authorized history

Inventory the legacy dates, source provenance, existing observation dates and the
active policy before writing. Validate the process using a fresh synthetic workspace.
For an explicitly approved historical scope, fetch those exact days through the
same single-day command in chronological order, using stable request IDs. A recent
window may also include known missing dates. Do not guess a provider identity or
fabricate sample timestamps from a legacy sync time. Keep temporary backups and any
personal migration receipts outside both repositories; remove task-only copies after
verification. A partial migration must retain its verified progress and uncertain
occurrence identity for review, rather than being called complete.

For each requested day, verify native completion/replay and the exact stored
source/date/metrics. Finally run read-only preparation for the current exact instant
and check actual prior-day coverage, current measurement eligibility and recovery
reasons. Compare unrelated workout/profile records before and after. Record remaining
provider-empty dates or other blockers accurately; a file count is not an end-to-end
acceptance check.
