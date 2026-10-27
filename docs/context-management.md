# Context management

SOMA exposes a versioned context policy for the pinned Hermes revision in `runtimes/hermes/manifest.json`. Use the supported CLI to inspect or change it without editing runtime implementation files:

```sh
npm run runtime:context
npm run runtime:context -- --json
npm run runtime:context -- --context-window 128000 --json
npm run runtime:context -- --file examples/context-policy.json --json
```

Set `SOMA_RUNTIME_HOME` to an explicit, isolated runtime and complete `npm run runtime:setup` first. These commands need no Health OS workspace, provider credentials, messaging connection, or model request. `--file` applies a JSON patch to that runtime's `hermes-home/config.yaml`; omitted fields keep their current values. There is no automatic policy installation during setup. Copy the [neutral example](../examples/context-policy.json) to private operator configuration before customizing it. The [JSON schema](../runtimes/hermes/context-policy.schema.json) defines the versioned input format.

The command only edits configuration. Existing running agents may retain earlier settings; start a new local process or use your separately authorized gateway maintenance procedure to adopt changes. Do not edit configuration concurrently with another configuration writer. SOMA detects intervening changes before replacement, but cannot lock unrelated Hermes writers across the final filesystem operation. It does not restart services.

## Supported settings

All fields below live under `compression` in a policy with `schema_version: 1`.

| Field | Default | Meaning and accepted values |
| --- | --- | --- |
| `enabled` | `true` | Enable automatic built-in compression and gateway hygiene; boolean. Manual compression and provider-native compaction have their own runtime behavior. |
| `threshold` | `0.5` | Configured token trigger ratio, from `0.1` to `0.95`. Model rules, output reservation, the small-window floor, and the optional token cap determine the actual trigger. |
| `threshold_tokens` | `null` | Optional absolute cap from `1` to `10000000`; `null` removes the cap. The lower of this cap and the computed trigger wins. Very low caps can cause repeated compression attempts. |
| `target_ratio` | `0.2` | Recent-tail target from `0.1` to `0.8`, used in `legacy` tail mode. This is not the generated summary's target size. |
| `tail_mode` | `lean` | `lean` uses the native small, bounded tail; `legacy` derives its tail from `target_ratio` and the token trigger. |
| `protect_first_n` | `3` | Protected head-message count, from `0` to `1000`. The system prompt is independently protected. |
| `protect_last_n` | `20` | Recent-message protection setting, from `1` to `1000`, subject to native tail-token bounds. It does not guarantee that every large tool result stays verbatim. |
| `min_tail_user_messages` | `1` | User-message anchors, from `1` to `1000`, no greater than `protect_last_n`. |
| `hygiene_hard_message_limit` | `5000` | Gateway-only count trigger, from `1` to `100000`. Must exceed `protect_first_n + protect_last_n + 1` so a middle remains to summarize. |

Values must have their declared JSON types; strings, non-finite numbers, duplicate keys, unknown fields, and unsupported schema versions are rejected. Effective settings are validated together after merging a patch. A patch that conflicts with a managed-scope value is rejected rather than reported as applied. Existing unrelated provider, search, voice, gateway, and tool configuration is preserved, including YAML comments and quotes.

## Reading the report

The versioned JSON envelope uses `command: "runtime-context"`. `data.policy` contains only the supported context settings and can be saved as a policy file. `data.changed` distinguishes a write from a read or an identical repeat. The report does not include complete runtime configuration, credentials, conversation content, or health records.

`data.budget` is an offline configuration calculation, not a measurement of a running conversation:

- `configured_window`: calculated for explicit `model.context_length` and an explicit model/provider in the selected runtime's YAML configuration.
- `preview_window`: calculated using `--context-window`. This flag does not change the model configuration or verify that a provider supports that window.
- `window_required`: no explicit window is available. Use a known window with `--context-window`; SOMA does not read auth stores, query a provider catalog, or guess a window from a model name.
- `route_required`: the model or provider is unspecified or the provider is `auto`. Select an explicit route using the existing configuration flow before relying on model-specific calculations.
- `disabled`, `external_engine`, or `native_compaction`: local compressor budgets do not describe the selected mode, so the token-budget fields stay unavailable.

For calculated budgets, `trigger_tokens` is the built-in compressor's initial token trigger. `effective_threshold_ratio` is that trigger divided by the full context window, **after** output reservation, model rules, floors, and the token cap. `output_reservation` is the native default reservation when one applies; `null` means no explicit reservation. `tail_budget_tokens` and `summary_max_tokens` are separate native bounds. In lean mode, changing `target_ratio` does not change the tail budget. The generated summary size remains controlled by the pinned Hermes implementation.

The gateway has an independent safety check: it may compress at `gateway_trigger_tokens` (85% of the full window) **or** at `hygiene_hard_message_limit`, even when the agent's ratio trigger has not fired. Count-based hygiene is not a CLI conversation-length limit. Runtime cooldowns, active compression, and protection of an arriving turn can defer hygiene. Token caps do not change the gateway's 85% threshold. These separate values make an early count trigger visible instead of presenting it as a change to the token ratio.

The calculation uses native helpers from the pinned submodule without constructing an agent or invoking its model-window resolver. Session-specific model switches, fallbacks, custom-provider model windows, environment templates, provider-native compaction selected during authentication, auxiliary-model feasibility limits, and learned runtime corrections are not resolved by this offline report. For those cases, supply the known window for a preview and verify the active route separately. A configured-window report describes the explicit YAML route; it does not promise identical budgets for every session. It never changes authentication or a provider selection.

## Disable and restore

Before changing a policy, save the `data.policy` object from `--json` into a private JSON file outside both source repositories. Reapply that file with `--file` to restore those settings. Repeated application is idempotent and does not rewrite an identical file. Disable automatic local compression with a patch such as:

```json
{"schema_version": 1, "compression": {"enabled": false}}
```

Reenable it with `enabled: true`, or restore the saved policy. Removing this SOMA command does not require an upstream rollback: settings are ordinary Hermes configuration. A failure during validation or budget calculation leaves configuration unchanged. Writes replace a private file atomically and clean up their temporary file on success or failure. No config backup or complete private config is copied into SOMA.

## Synthetic acceptance checks

Use a fresh disposable runtime and synthetic model configuration only. Automated unit tests cover validation, cross-field constraints, isolation, redaction, concurrent modification detection, idempotence, disable/restore, unsafe files, and temporary-file cleanup. CI additionally runs `tests/context_policy_native_test.py` under the installed pinned runtime, with network connections and auth/session/secret reads forbidden.

1. Configure a synthetic model/provider and a 128000-token window. With the native defaults, verify an initial local trigger of 96000 tokens, a gateway trigger of 108800 tokens, a 10000-token lean tail, and a 6400-token summary ceiling. Inspection must leave the config byte-identical.
2. Preview a 32768-token window; verify the native minimum-window adjustment gives a 27852-token trigger. Preview a 1000000-token window; verify a 500000-token trigger. Neither preview changes the configured model window.
3. Apply a 32000-token cap with `tail_mode: "legacy"` and `target_ratio: 0.3`. Verify a 32000-token trigger, a `0.25` effective ratio for the 128000-token window, and a 9600-token tail. The independent gateway count limit remains visible.
4. Repeat the patch and check `changed: false`. Disable and then restore the captured policy. Unrelated synthetic settings, comments, and quoted strings must survive.
5. Submit an invalid type, an unknown field, or a message limit inside the protected head/tail. Verify a bounded error and no config change. Repeat with a symlinked config, a managed-scope conflict, and a native-budget calculation failure.

This is the configuration slice of [issue #2](https://github.com/bknstn/soma-ai/issues/2). A durable ledger of confirmed commitments, new-day session boundaries, scheduled delivery gates, and long-task progress are still separate work. Native lossy summarization is not proof that a confirmed commitment will survive every compression. Health records remain in Health OS and the existing bounded subprocess interface is unchanged.
