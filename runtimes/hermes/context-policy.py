"""Versioned context-policy editor for SOMA's explicit, isolated Hermes runtime.

Uses native config keys and native budget calculations. Never loads sessions, health
records, auth stores or online model metadata. Run via the SOMA runtime manager.
"""

import argparse
import copy
import io
import json
import math
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace


FIELDS = {
    "enabled": True,
    "threshold": 0.5,
    "threshold_tokens": None,
    "target_ratio": 0.2,
    "tail_mode": "lean",
    "protect_first_n": 3,
    "protect_last_n": 20,
    "min_tail_user_messages": 1,
    "hygiene_hard_message_limit": 5000,
}
MAX_CONFIG_BYTES = 1024 * 1024
MAX_POLICY_BYTES = 8192
MAX_WINDOW = 10000000


class PolicyError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def integer(value, low, high):
    # Native round-trip YAML numbers retain formatting in int/float subclasses.
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def validate_settings(settings, *, relationships=True):
    if not isinstance(settings, dict) or set(settings) != set(FIELDS):
        raise PolicyError("invalid_policy")
    if type(settings["enabled"]) is not bool or settings["tail_mode"] not in ("lean", "legacy"):
        raise PolicyError("invalid_policy")
    for key, low, high in (("threshold", 0.1, 0.95), ("target_ratio", 0.1, 0.8)):
        value = settings[key]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not low <= value <= high:
            raise PolicyError("invalid_policy")
    cap = settings["threshold_tokens"]
    if cap is not None and not integer(cap, 1, MAX_WINDOW):
        raise PolicyError("invalid_policy")
    for key, low, high in (("protect_first_n", 0, 1000), ("protect_last_n", 1, 1000),
                           ("min_tail_user_messages", 1, 1000), ("hygiene_hard_message_limit", 1, 100000)):
        if not integer(settings[key], low, high):
            raise PolicyError("invalid_policy")
    # The count trigger must leave a middle to summarize after the protected head/tail.
    if relationships and (settings["min_tail_user_messages"] > settings["protect_last_n"] or
            settings["hygiene_hard_message_limit"] <= settings["protect_first_n"] + settings["protect_last_n"] + 1):
        raise PolicyError("invalid_policy")
    return settings


def parse_policy(raw):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PolicyError("invalid_policy")
            result[key] = value
        return result

    if len(raw) > MAX_POLICY_BYTES:
        raise PolicyError("invalid_policy")
    try:
        policy = json.loads(raw, object_pairs_hook=unique_keys)
    except (ValueError, UnicodeError):
        raise PolicyError("invalid_policy") from None
    if (not isinstance(policy, dict) or set(policy) != {"schema_version", "compression"} or
            type(policy["schema_version"]) is not int or policy["schema_version"] != 1 or
            not isinstance(policy["compression"], dict) or not policy["compression"] or
            set(policy["compression"]) - set(FIELDS)):
        raise PolicyError("invalid_policy")
    # Validate supplied values before any overlay can hide a malformed input.
    # Cross-field relations use the actual merged runtime settings in edit_policy.
    validate_settings({**FIELDS, **policy["compression"]}, relationships=False)
    return policy["compression"]


def read_regular(filename, limit):
    """Reject symlinks, devices and hardlinks; bound reads even if the file grows."""
    try:
        with open(filename, "rb", opener=lambda p, f: os.open(p, f | os.O_NOFOLLOW | os.O_NONBLOCK)) as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > limit:
                raise PolicyError("invalid_config")
            data = stream.read(limit + 1)
            if len(data) > limit:
                raise PolicyError("invalid_config")
            return data
    except FileNotFoundError:
        return None
    except OSError:
        raise PolicyError("invalid_config") from None


def read_mapping(filename, yaml):
    raw = read_regular(filename, MAX_CONFIG_BYTES)
    try:
        config = yaml.load(raw.decode("utf-8")) if raw is not None else {}
        config = {} if config is None else config
        if not isinstance(config, dict):
            raise ValueError()
        return config, raw
    except Exception:
        raise PolicyError("invalid_config") from None


def merge(left, right):
    result = copy.deepcopy(left)
    for key, value in right.items():
        result[key] = merge(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else copy.deepcopy(value)
    return result


def native_budget(config, settings, window):
    # These helpers are pinned with the submodule; no AIAgent is constructed and no
    # context-length resolver is called (it can probe providers and read auth state).
    from agent.agent_init import _compression_threshold, _compressor_max_tokens
    from agent.context_compressor import ContextCompressor

    model = config.get("model", {})
    model = {"default": model} if isinstance(model, str) else model
    agent = SimpleNamespace(model=model.get("default") or model.get("model") or "",
                            provider=model.get("provider", ""), base_url=model.get("base_url", ""), max_tokens=None)
    threshold, _ = _compression_threshold(agent, config.get("compression", {}))
    compressor = ContextCompressor(
        model=agent.model, provider=agent.provider, threshold_percent=threshold,
        protect_first_n=settings["protect_first_n"], protect_last_n=settings["protect_last_n"],
        min_tail_user_messages=settings["min_tail_user_messages"], summary_target_ratio=settings["target_ratio"],
        tail_mode=settings["tail_mode"], threshold_tokens_cap=settings["threshold_tokens"],
        model_thresholds=config.get("compression", {}).get("model_thresholds"),
        max_tokens=_compressor_max_tokens(agent), quiet_mode=True,
    )
    # Bypass lazy metadata discovery entirely; use only the explicitly supplied window.
    compressor.context_length = window
    return {
        "output_reservation": compressor.max_tokens,
        "effective_threshold_ratio": compressor.threshold_tokens / window,
        "trigger_tokens": compressor.threshold_tokens,
        "tail_budget_tokens": compressor.tail_token_budget,
        "summary_max_tokens": compressor.max_summary_tokens,
    }


def report(config, settings, preview_window=None, budget_resolver=native_budget):
    model = config.get("model", {})
    if isinstance(model, str):
        model = {"default": model}
    if not isinstance(model, dict):
        raise PolicyError("invalid_config")
    configured_window = model.get("context_length")
    window = preview_window if preview_window is not None else configured_window
    if window is not None and not integer(window, 1, MAX_WINDOW):
        raise PolicyError("invalid_config")
    result = dict.fromkeys(("context_window", "output_reservation", "effective_threshold_ratio", "trigger_tokens",
                           "tail_budget_tokens", "summary_max_tokens", "gateway_trigger_tokens"))
    result["context_window"] = window
    context = config.get("context", {})
    compression = config.get("compression", {})
    if not isinstance(context, dict) or not isinstance(compression, dict):
        raise PolicyError("invalid_config")
    if not settings["enabled"]:
        result["status"] = "disabled"
    elif context.get("engine", "compressor") != "compressor":
        result["status"] = "external_engine"
    elif model.get("api_mode") == "codex_app_server" or compression.get("codex_responses_native", False):
        result["status"] = "native_compaction"
    elif window is None:
        result["status"] = "window_required"
    elif not (model.get("default") or model.get("model")) or not model.get("provider") or model.get("provider") == "auto":
        result["status"] = "route_required"
    else:
        try:
            result.update(budget_resolver(config, settings, window))
        except Exception:
            raise PolicyError("budget_unavailable") from None
        result["status"] = "preview_window" if preview_window is not None else "configured_window"
        result["gateway_trigger_tokens"] = int(window * 0.85)
    return result


def edit_policy(home, managed, yaml, patch=None, preview_window=None, budget_resolver=native_budget):
    """Validate and compute the full result before a single atomic configuration write."""
    for directory in (home, managed):
        if directory.is_symlink() or not directory.is_dir():
            raise PolicyError("invalid_config")
    filename, overlay_file = home / "config.yaml", managed / "config.yaml"
    config, original = read_mapping(filename, yaml)
    overlay, overlay_raw = read_mapping(overlay_file, yaml)
    for data in (config, overlay):
        if "compression" in data and not isinstance(data["compression"], dict):
            raise PolicyError("invalid_config")
    candidate = copy.deepcopy(config)
    if patch is not None:
        # Detach a YAML alias before editing so other aliased sections stay unchanged.
        candidate["compression"] = copy.deepcopy(candidate.get("compression", {}))
        candidate["compression"].update(patch)
    effective = merge(candidate, overlay)
    settings = {key: effective.get("compression", {}).get(key, default) for key, default in FIELDS.items()}
    validate_settings(settings)
    if patch is not None and any(settings[key] != value for key, value in patch.items()):
        # Managed-scope values win in Hermes. Never claim to apply a shadowed choice.
        raise PolicyError("invalid_config")
    budget = report(effective, settings, preview_window, budget_resolver)
    changed = candidate != config
    if changed:
        output = io.StringIO()
        yaml.dump(candidate, output)
        serialized = output.getvalue().encode("utf-8")
        if len(serialized) > MAX_CONFIG_BYTES:
            raise PolicyError("invalid_config")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=home, prefix=".soma-context-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            if read_regular(filename, MAX_CONFIG_BYTES) != original or read_regular(overlay_file, MAX_CONFIG_BYTES) != overlay_raw:
                raise PolicyError("config_changed")
            os.replace(temporary, filename)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"schema_version": 1, "changed": changed,
            "policy": {"schema_version": 1, "compression": settings}, "budget": budget}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file")
    parser.add_argument("--context-window", type=int)
    args = parser.parse_args()
    try:
        from hermes_yaml import roundtrip_yaml

        runtime = Path(os.environ["SOMA_RUNTIME_HOME"])
        home, managed = runtime / "hermes-home", runtime / "hermes-managed"
        if (not runtime.is_absolute() or runtime.is_symlink() or runtime.resolve() != runtime or
                os.environ.get("HERMES_HOME") != str(home) or os.environ.get("HERMES_MANAGED_DIR") != str(managed)):
            raise PolicyError("invalid_config")
        patch = None
        if args.file is not None:
            raw = read_regular(args.file, MAX_POLICY_BYTES)
            if raw is None:
                raise PolicyError("invalid_policy")
            patch = parse_policy(raw)
        result = edit_policy(home, managed, roundtrip_yaml(), patch, args.context_window)
        print(json.dumps(result, allow_nan=False))
        return 0
    except PolicyError as error:
        print(json.dumps({"error": error.code}))
    except Exception:
        # Parser errors and native exceptions may embed config values or paths.
        print(json.dumps({"error": "invalid_config"}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
