# First-run conversation setup

Use these commands in order for a manual installation or when Codex or Claude
installs SOMA with you. An installing assistant should obtain the four choices
below, use the managed commands, and show the readiness report. Enter secrets
yourself in the provider prompt or in private, owner-only configuration.

## 1. Install the pinned runtime

From the repository root, with Node.js 22.13 or newer and Python 3.11 through 3.14:

```sh
git submodule update --init --recursive
export SOMA_RUNTIME=hermes
export SOMA_RUNTIME_HOME="$HOME/.local/share/soma/hermes-runtime"
npm run runtime:setup
npm run runtime:doctor
```

Choose a fresh absolute path outside SOMA and Health OS. Use the same path for
subsequent commands. The [Hermes guide](hermes.md) describes the isolated home
and pinned source. Search, voice input and spoken replies start disabled on a
fresh SOMA installation.

## 2. Choose a conversation provider, model and authentication

Run `npm run runtime:configure` and choose a provider and model in the pinned
Hermes selector. Anthropic uses an Anthropic API key and needs
`npm run runtime:provider-deps -- anthropic` first. Choose `openai-codex` for
Codex OAuth, `openai-api` for OpenAI API key access, or another connection the
selector supports, such as OpenRouter. Bedrock and Vertex have corresponding
`provider-deps` extras. For local chat, the selector keeps credentials in the
isolated Hermes home. To run a service, use the
[Telegram gateway's private environment](hermes.md#managed-telegram-gateway).

## 3. Choose optional capabilities

Select one option per row. Omitted options keep their current setting.

| Choice | Options and requirements |
| --- | --- |
| `--search` | `off`, `tavily` with a Tavily API key, `soma-openai` with an OpenAI API key permitted to use Responses web search, or `openai-native` with an authorized `openai-codex` conversation model. |
| `--voice-input` | `off`, `local` with the pinned `stt-whisper` extra, `groq` with a Groq API key, or `openai` with an OpenAI API key or an OpenAI-compatible private transcription endpoint. This setup covers incoming Telegram voice notes. |
| `--spoken-replies` | `off`, `edge` with the pinned `edge-tts` extra and `ffmpeg` for Telegram voice bubbles, or `openai` with an OpenAI API key permitted to synthesize speech. Telegram users can then choose `/voice on` or `/voice tts` in their own chat. |

For local transcription, run `npm run runtime:provider-deps -- stt-whisper`.
The first use may download model weights. The extra is unavailable on some
platforms, including Intel macOS. For self-hosted transcription, set
`stt.openai.base_url` to the private OpenAI-compatible endpoint in the isolated
`hermes-home/config.yaml`, then choose `--voice-input openai`. For Edge speech,
run `npm run runtime:provider-deps -- edge-tts` and ensure `ffmpeg` is on the
launcher's PATH. Text chat remains available with voice capabilities disabled.

For a mixed setup, choose Anthropic or OpenRouter in the model selector and
then preview and apply the requested options.

```sh
npm run runtime:capabilities -- --preview --search tavily --voice-input local --spoken-replies off
npm run runtime:capabilities -- --search tavily --voice-input local --spoken-replies off
```

Set `TAVILY_API_KEY`, `GROQ_API_KEY` or `OPENAI_API_KEY` only for the options
that need them. For local chat, these can go into the isolated `hermes-home/.env`
with mode `0600`. Use the service environment for Telegram. Keep secret values
out of arguments and logs. The OpenAI API key may be shared across compatible
OpenAI API capabilities when it has access to each selected model and endpoint.
Codex OAuth grants native search on its own conversation route. It supplies no
OpenAI API key for SOMA search or speech.

Search sends a general public query to the selected backend. Keep personal
identifiers, health facts and measurements out of queries. A search result
should cite clickable sources. The command disables keyless search fallback.
Hermes groups search and page extraction in its `web` toolset, so turning
search off hides both tools. Selecting a search backend leaves the separate
extraction backend and browser settings intact.

Local transcription processes audio on your machine after the Telegram
gateway downloads it. Groq receives the voice audio. Spoken replies send the
reply text to the selected synthesis service, including for Microsoft Edge
speech. Hosted model, search and speech services may impose quotas and usage
charges. Review the [SOMA privacy guide](privacy.md) before sending health context.

## 4. Verify and revisit choices

```sh
npm run runtime:capabilities
node src/runtime/cli.js capabilities --json
```

The report checks offline prerequisites and tool exposure for CLI and Telegram.
`ready` means the local prerequisites were detected. `unavailable` includes
the missing requirement. `configured` indicates an existing selection whose
readiness still needs verification. `disabled` indicates an explicit opt-out.
For a service, run the check with the same allowlisted provider variables
available to that service. The report prints no credentials. It cannot verify
remote model availability, credentials, billing or quotas.

Prepare a workspace with [Getting started](getting-started.md), then start
`npm run chat` or configure the [Telegram gateway](hermes.md#managed-telegram-gateway).
Optional live acceptance checks use neutral inputs:

1. Ask the conversation model to answer “What is 2 + 2?”
2. Ask “Search the web for the official definition of the metre and cite the source.”
   Open the clickable source link and verify it supports the answer.
3. Send a Telegram voice note saying “Please reply with the word maple.”
   Verify that SOMA answers the spoken request.
4. If spoken replies are enabled, run `/voice on` and repeat the voice note.
   Check for playable audio and a reply in the language of the request.

For invalid credentials, denied access or missing models, check the reported
provider and its model permissions. For quota or rate limits, inspect that
provider's private service status and retry with the same choice after resolving
the limit. Rerun `runtime:configure` to change the model. Rerun
`runtime:capabilities` with the relevant option to change or disable it.
For rollback, reapply the previous choices. Restart active chat or the gateway
after configuration changes. Repeating setup refreshes the pinned assets and
retains existing capability selections. The runtime configuration lives apart
from the Health OS workspace.
