"""Configure independent first-run choices in the pinned, isolated Hermes home."""

import argparse
from contextlib import redirect_stdout
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile

from agent.skill_utils import parse_config_string_list
from utils import is_truthy_value
from hermes_yaml import roundtrip_yaml


SEARCH = ("off", "soma-openai", "openai-native", "tavily")
STT = ("off", "local", "groq", "openai")
TTS = ("off", "edge", "openai")
DISABLED_TTS = "soma-disabled"
DISABLED_TTS_COMMAND = {"type": "command", "command": "false"}
PLATFORMS = ("cli", "telegram")
MODEL_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY", "openai-api": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY", "groq": "GROQ_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY", "mistral": "MISTRAL_API_KEY",
    "together": "TOGETHER_API_KEY", "xai": "XAI_API_KEY",
}
MODEL_PACKAGES = {"anthropic": "anthropic", "bedrock": "boto3", "vertex": "google.auth"}

_config_io = runpy.run_path(str(Path(__file__).with_name("context-policy.py")))
read_regular = _config_io["read_regular"]
read_mapping = _config_io["read_mapping"]
merge = _config_io["merge"]
MAX_BYTES = _config_io["MAX_CONFIG_BYTES"]
PolicyError = _config_io["PolicyError"]


def mapping(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise PolicyError("invalid_config")
    return value


def section(config, key):
    # YAML aliases may share mappings with unrelated settings.
    config[key] = copy.deepcopy(mapping(config.get(key)))
    return config[key]


def name(value, default="unselected"):
    return value.strip().lower() if isinstance(value, str) and value.strip() else default


def model_provider(config):
    model = config.get("model")
    return name(model.get("provider")) if isinstance(model, dict) else "unselected"


def platform_toolsets(config, platform):
    from hermes_cli.tools_config import _get_platform_tools

    return _get_platform_tools(config, platform, include_default_mcp_servers=False)


def configure_toolset(config, toolset, enabled):
    agent = section(config, "agent")
    disabled = parse_config_string_list(agent.get("disabled_toolsets"))
    if not enabled:
        if not any(item.strip() == toolset for item in disabled):
            agent["disabled_toolsets"] = [*disabled, toolset]
        return
    if any(item.strip() == toolset for item in disabled):
        agent["disabled_toolsets"] = [item for item in disabled if item.strip() != toolset]

    from hermes_cli.toolset_validation import parse_platform_toolsets_value
    platforms = mapping(config.get("platform_toolsets"))
    for platform in PLATFORMS:
        if toolset in platform_toolsets(config, platform):
            continue
        existing = parse_platform_toolsets_value(platforms.get(platform))
        if existing is None:
            # Use the resolved defaults so an explicit list doesn't enable default-off tools.
            existing = sorted(platform_toolsets(config, platform))
        section(config, "platform_toolsets")[platform] = [*existing, toolset]


def apply(config, selections):
    search, stt, tts = selections
    if search is not None:
        configure_toolset(config, "web", search != "off")
        web = section(config, "web")
        web["keyless_rescue"] = False
        if search != "off":
            web["search_backend"] = search
        if search == "soma-openai":
            plugins = section(config, "plugins")
            plugin = "soma-openai-search"
            enabled = parse_config_string_list(plugins.get("enabled"))
            disabled = parse_config_string_list(plugins.get("disabled"))
            plugins["enabled"] = list(dict.fromkeys([*enabled, plugin]))
            plugins["disabled"] = [item for item in disabled if item != plugin]
    if stt is not None:
        transcription = section(config, "stt")
        transcription["enabled"] = stt != "off"
        if "stt_enabled" in config:
            config["stt_enabled"] = transcription["enabled"]
        if stt != "off":
            transcription["provider"] = stt
            if "use_gateway" in transcription:
                transcription["use_gateway"] = False
    if tts is not None:
        configure_toolset(config, "tts", tts != "off")
        # Per-chat /voice modes outrank the global default. Pin a local no-output
        # command while disabled so those modes cannot reach any remote provider.
        synthesis = section(config, "tts")
        synthesis["provider"] = DISABLED_TTS if tts == "off" else tts
        if "use_gateway" in synthesis:
            synthesis["use_gateway"] = False
        if "provider" in mapping(synthesis.get("streaming")):
            section(synthesis, "streaming")["provider"] = synthesis["provider"]
        if tts == "off":
            section(synthesis, "providers")[DISABLED_TTS] = DISABLED_TTS_COMMAND.copy()
        elif DISABLED_TTS in mapping(synthesis.get("providers")):
            section(synthesis, "providers").pop(DISABLED_TTS)


def result(provider, status, detail=""):
    return {"provider": provider, "status": status, "detail": detail}


def installed(module):
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def configured_key(key):
    from agent.web_search_provider import get_provider_env
    return usable_secret(get_provider_env(key))


def usable_secret(value):
    from hermes_cli.auth import has_usable_secret
    return has_usable_secret(value) and not value.strip().startswith("op://")


def openai_audio_configured(settings, *, transcription=False):
    if is_truthy_value(settings.get("use_gateway")):
        return False
    openai = mapping(settings.get("openai"))
    if transcription and openai.get("base_url"):
        from tools.transcription_cloud import _is_local_or_private_url
        if _is_local_or_private_url(openai["base_url"]):
            return True
    return (usable_secret(openai.get("api_key")) or configured_key("VOICE_TOOLS_OPENAI_KEY")
            or configured_key("OPENAI_API_KEY"))


def codex_credentials():
    from plugins.web.openai_native.provider import has_codex_credentials

    return has_codex_credentials()


def conversation_status(config):
    provider = model_provider(config)
    model = config.get("model")
    if provider in ("auto", "unselected") or not name(model.get("default"), ""):
        return result("unselected", "unavailable", "Choose a provider and model with runtime:configure.")
    if provider in MODEL_PACKAGES and not installed(MODEL_PACKAGES[provider]):
        return result(provider, "unavailable", f"Run npm run runtime:provider-deps -- {provider}.")
    if provider == "openai-codex":
        return (result(provider, "ready") if codex_credentials() else
                result(provider, "unavailable", "Authorize Codex with runtime:configure."))
    if provider in MODEL_KEYS:
        key = MODEL_KEYS[provider]
        return (result(provider, "ready") if configured_key(key) else
                result(provider, "unavailable", f"Set {key} in the private provider configuration."))
    return result("other", "configured", "Use runtime:configure and an optional live chat to verify this provider.")


def search_status(config, home, exposed):
    if "web" in {item.strip() for item in parse_config_string_list(mapping(config.get("agent")).get("disabled_toolsets"))}:
        return result("off", "disabled")
    web = mapping(config.get("web"))
    provider = name(web.get("search_backend") or web.get("backend"), "auto")
    if provider not in SEARCH[1:]:
        return result("other" if provider != "auto" else provider, "configured",
                      "Choose an explicit search backend to check its requirements.")
    if provider == "openai-native":
        if model_provider(config) != "openai-codex" or not codex_credentials():
            return result(provider, "unavailable", "Select and authorize the openai-codex conversation provider.")
    else:
        if provider == "soma-openai":
            plugin_root = home / "plugins" / "soma-openai-search"
            plugins = mapping(config.get("plugins"))
            if ("soma-openai-search" not in parse_config_string_list(plugins.get("enabled"))
                    or "soma-openai-search" in parse_config_string_list(plugins.get("disabled"))
                    or not all((plugin_root / item).is_file() for item in ("plugin.yaml", "__init__.py"))):
                return result(provider, "unavailable", "Rerun runtime:setup and select soma-openai search.")
        key = "OPENAI_API_KEY" if provider == "soma-openai" else "TAVILY_API_KEY"
        if not configured_key(key):
            return result(provider, "unavailable", f"Set {key} in the private provider configuration.")
    if web.get("keyless_rescue") is not False:
        return result(provider, "configured", "Reapply the search choice to disable unselected fallback.")
    return tool_status(provider, "web", exposed)


def tool_status(provider, toolset, exposed):
    missing = ", ".join(platform for platform in PLATFORMS if toolset not in exposed[platform])
    return (result(provider, "unavailable", f"The {toolset} toolset is hidden on {missing}. Review platform toolsets.")
            if missing else result(provider, "ready"))


def stt_status(config):
    stt = mapping(config.get("stt"))
    if not is_truthy_value(stt.get("enabled"), default=True) or not is_truthy_value(config.get("stt_enabled"), default=True):
        return result("off", "disabled")
    provider = name(stt.get("provider"), "auto")
    if provider not in STT[1:]:
        return result("other" if provider != "auto" else provider, "configured",
                      "Choose a supported transcription engine to check its requirements.")
    if provider == "local" and not installed("faster_whisper"):
        return result(provider, "unavailable", "Install runtime:provider-deps -- stt-whisper or choose another engine.")
    if provider == "groq" and (not installed("openai") or not configured_key("GROQ_API_KEY")):
        return result(provider, "unavailable", "Set GROQ_API_KEY privately and verify the Hermes core SDK.")
    if provider == "openai" and (not installed("openai") or not openai_audio_configured(stt, transcription=True)):
        return result(provider, "unavailable", "Set OPENAI_API_KEY or configure a compatible private transcription endpoint.")
    from tools.transcription_common import RETIRED_GROQ_MODELS
    if provider == "groq" and name(mapping(stt.get("groq")).get("model")) in RETIRED_GROQ_MODELS:
        return result(provider, "configured", "The Groq model was retired. Select an available model under stt.groq.model.")
    if not installed("telegram"):
        return result(provider, "unavailable", "Run runtime:setup to install Telegram support.")
    return result(provider, "ready", "Telegram voice input. Verify transcription with a neutral voice note.")


def tts_status(config, exposed):
    tts = mapping(config.get("tts"))
    provider = name(tts.get("provider"), "edge")
    if provider == DISABLED_TTS:
        streaming = name(mapping(tts.get("streaming")).get("provider"), DISABLED_TTS)
        if streaming == DISABLED_TTS and mapping(tts.get("providers")).get(DISABLED_TTS) == DISABLED_TTS_COMMAND:
            return result("off", "disabled")
        return result("off", "unavailable", "Reapply spoken replies off before starting the gateway.")
    if provider not in TTS[1:]:
        return result("other", "configured", "Use a supported selection to check its requirements.")
    if provider == "edge":
        if not installed("edge_tts"):
            return result(provider, "unavailable", "Install runtime:provider-deps -- edge-tts or choose another engine.")
        if not shutil.which("ffmpeg"):
            return result(provider, "configured", "Install ffmpeg on PATH for Telegram voice bubbles.")
    elif not installed("openai") or not openai_audio_configured(tts):
        return result(provider, "unavailable", "Set OPENAI_API_KEY privately and verify the Hermes core SDK.")
    return tool_status(provider, "tts", exposed)


def configure(home, managed, selections, *, seed=False, preview=False):
    for directory in (home, managed):
        if directory.is_symlink() or not directory.is_dir():
            raise PolicyError("invalid_config")
    # Serialize SOMA writers without leaving a lock file. A final comparison also
    # detects edits by Hermes tools that do not take this lock.
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        return configure_locked(home, managed, selections, seed=seed, preview=preview)
    finally:
        os.close(fd)


def configure_locked(home, managed, selections, *, seed, preview):
    filename, overlay_path = home / "config.yaml", managed / "config.yaml"
    yaml = roundtrip_yaml()
    config, original = read_mapping(filename, yaml)
    overlay, overlay_bytes = read_mapping(overlay_path, yaml)
    if seed and original is not None:
        return
    if not seed:
        for directory in (home, managed):
            for secret in (".env", ".op.env", "auth.json"):
                read_regular(directory / secret, MAX_BYTES)
    effective = merge(config, overlay)
    if selections[0] == "openai-native" and model_provider(effective) != "openai-codex":
        raise PolicyError("native_search_requires_codex")
    candidate = copy.deepcopy(config)
    apply(candidate, selections)
    updated = merge(candidate, overlay)
    expected = copy.deepcopy(effective)
    apply(expected, selections)
    if updated != expected:
        raise PolicyError("managed_override")
    changed = candidate != config
    if not seed:
        exposed = {platform: platform_toolsets(updated, platform) for platform in PLATFORMS}
        capabilities = {
            "conversation": conversation_status(updated),
            "search": search_status(updated, home, exposed),
            "voice_input": stt_status(updated),
            "spoken_replies": tts_status(updated, exposed),
        }
    if changed and not preview:
        output = io.StringIO()
        yaml.dump(candidate, output)
        serialized = output.getvalue().encode("utf-8")
        if len(serialized) > MAX_BYTES:
            raise PolicyError("invalid_config")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=home, prefix=".soma-capabilities-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            if read_regular(filename, MAX_BYTES) != original or read_regular(overlay_path, MAX_BYTES) != overlay_bytes:
                raise PolicyError("config_changed")
            os.replace(temporary, filename)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    if not seed:
        return {"schema_version": 1, "changed": changed and not preview, "preview": preview, "capabilities": capabilities}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--search", choices=SEARCH)
    parser.add_argument("--voice-input", choices=STT)
    parser.add_argument("--spoken-replies", choices=TTS)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--seed", action="store_true")
    args = parser.parse_args()
    selections = ("off", "off", "off") if args.seed else (args.search, args.voice_input, args.spoken_replies)
    try:
        with redirect_stdout(sys.stderr):
            data = configure(Path(os.environ["HERMES_HOME"]), Path(os.environ["HERMES_MANAGED_DIR"]),
                             selections, seed=args.seed, preview=args.preview)
        if data is not None:
            print(json.dumps(data))
        return 0
    except PolicyError as error:
        print(json.dumps({"error": error.code}))
    except Exception:
        print(json.dumps({"error": "invalid_config"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
