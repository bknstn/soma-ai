"""Idempotently install the opt-in continuity component into an explicit Hermes home."""

import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile


def install(source, home, yaml):
    source, home = Path(source), Path(home)
    if not home.is_absolute() or home.is_symlink() or home.resolve() != home or not home.is_dir():
        raise ValueError("Invalid managed home")
    # Reuse the bounded file and YAML readers from the versioned context component.
    spec = importlib.util.spec_from_file_location("soma_policy_io", Path(__file__).with_name("context-policy.py"))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    config_file = home / "config.yaml"
    config, original = policy.read_mapping(config_file, yaml)
    plugins = config.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        raise ValueError("Invalid plugin settings")
    enabled, disabled = plugins.setdefault("enabled", []), plugins.get("disabled", [])
    if not isinstance(enabled, list) or not isinstance(disabled, list):
        raise ValueError("Invalid plugin selections")
    if "soma-continuity" not in disabled and "soma-continuity" not in enabled:
        enabled.append("soma-continuity")
    # Feature remains off until an operator explicitly opts in. Preserve all settings.
    target = home / "plugins" / "soma-continuity"
    for directory in (target.parent, target):
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("Invalid plugin directory")
    assets = {}
    for name in ("__init__.py", "plugin.yaml"):
        raw = policy.read_regular(source / name, 65536)
        if raw is None:
            raise ValueError("Missing component asset")
        # Validate every target before replacing any asset.
        policy.read_regular(target / name, 65536)
        assets[target / name] = raw
    output = io.StringIO()
    yaml.dump(config, output)
    serialized = output.getvalue().encode("utf-8")
    if len(serialized) > policy.MAX_CONFIG_BYTES:
        raise ValueError("Configuration too large")
    if serialized != original:
        assets[config_file] = serialized
    for filename, raw in assets.items():
        if policy.read_regular(filename, policy.MAX_CONFIG_BYTES) == raw:
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=filename.parent, prefix=".soma-continuity-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            if filename == config_file and policy.read_regular(config_file, policy.MAX_CONFIG_BYTES) != original:
                raise ValueError("Configuration changed during installation")
            os.replace(temporary, filename)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    from hermes_yaml import roundtrip_yaml
    try:
        install(sys.argv[1], sys.argv[2], roundtrip_yaml())
    except Exception:
        raise SystemExit("Continuity installation failed; inspect private paths and configuration.") from None
