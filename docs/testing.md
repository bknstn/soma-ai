# Testing

The default validation loop is `npm test`. It needs Node 22.13.0 or newer and
Python 3, uses synthetic fixtures, and does not install Hermes or require a
Health OS checkout. Integration environment variables do not expand this command.

For a change confined to one component, run its file directly:

```sh
node --test tests/presenter.test.js
python3 -I -B tests/assistant_test.py
```

Run `npm test` before completing a change. CI also runs the two integration
commands below. Missing integration paths are errors, not skipped tests.

## Integration

```sh
HEALTH_OS_REPO=/absolute/path/to/pinned-health-os npm run test:health-os
```

This uses the public CLI and creates and removes its own synthetic workspaces.
Keep the checkout at the supported revision documented in [architecture](architecture.md).

Hermes tests require a newly installed disposable runtime. The gateway test
temporarily changes its synthetic configuration and restores it afterward.
Never point these tests at an existing personal runtime. A shell example:

```sh
set -eu
test_root="$(mktemp -d)"
test_root="$(cd "$test_root" && pwd -P)"
trap 'rm -rf -- "$test_root"; test ! -e "$test_root"' EXIT
export RUNNER_TEMP="$test_root"
export SOMA_RUNTIME=hermes
export SOMA_RUNTIME_HOME="$test_root/soma-hermes-runtime"
export SOMA_RUNTIME_CI_SENTINEL="$test_root/.soma-hermes-runtime-ci-owned"
printf 'created by this CI job\n' > "$SOMA_RUNTIME_CI_SENTINEL"
npm run runtime:setup
npm run test:hermes
```

Setup downloads pinned dependencies. Tests use no real provider credentials or
live model calls. Native plugin checks run in four independent Python processes;
their audit hooks and mutable state remain isolated.

## Audit decisions, 2026-10-31

Reviewed all SOMA-owned JS/Python tests and both CI workflows. The pinned Hermes
submodule's upstream suite is outside this audit and is not part of SOMA's loop.

| Area | Decision |
| --- | --- |
| CLI and presenters | Keep routing, errors and output contracts. Remove the duplicate doctor privacy matrix from the CLI; the presenter owns it. |
| Health OS client | Keep real subprocess, argv/env isolation, timeout, bounds, write guards and uncertain outcomes. Remove the repeated scheduled-only payload check and repeated envelope error assertions. Run independent workspace cases with concurrency 4; shared repository/env mutations stay sequential. |
| Health OS integration | Keep preparation, memory review, selected profile, writes/replay and actual native truncation. Check insufficient baseline coverage at its boundary once. Seed large history through the public CLI rather than repeating adapter preflight 34 times. Drop the upstream recovery-score arithmetic assertion. |
| Runtime | Keep environment/path isolation and launch boundaries. Merge duplicate successful setup coverage; remove source-text assertions. Keep the skill-name prefix regression's failing case; native doctor covers success. Gateway config variants share one real readiness inspection while each launch still runs native config preflight. |
| Context policy | Keep offline validation/transactions and native YAML/budget checks: these exercise different boundaries. |
| Continuity | Keep consent, replay, revisions and storage isolation. Exercise receipt eviction with a small test limit instead of hundreds of identical writes. |
| Progress | Keep lifecycle, waits, stale notices and native dispatch. Remove the second unit matrix for the shared continuity installer; generic installation is covered by continuity tests and actual progress packaging by native integration. |
| Heartbeat | Keep policy, local-time/DST, durable reservation and handoff checks. Use two competing workers instead of a 16-claim stress run. Remove the full duplicate suite under managed Python; native assistant delivery covers runtime compatibility. |
| Assistant | Keep conversational consent, voice provenance, subscriptions, boundaries and delivery integration. Its DST scheduling checks differ from the gate's quiet-hours checks. |
| Persona | Keep fresh installation and supported migrations that preserve operator edits, transcription settings and atomic-write failures. |
| Web search and Oura sync | Keep request/credential boundaries, redaction and uncertain-result handling; native search dispatch verifies a separate integration boundary. |
| Version and release | Keep CLI entry points and release metadata contracts. Remove CI's separate `release:check` invocation because `version.test.js` already runs the real release checker. The release workflow still validates the actual tag. |
| CI | Run local, Health OS and Hermes suites explicitly. Remove the extra empty-workspace smoke and demo runs, and repeated help/skill launches after doctor. |

Add a test for a supported user scenario, an external contract or a concrete
regression. Put detailed validation cases at the layer that owns validation;
keep only a representative wiring check at callers. Avoid source-text assertions,
combinatorial hypothetical inputs and repeated stress-sized fixtures.
