"""Install SOMA's maintained plugin into the explicit managed Hermes home."""

import os
from pathlib import Path
import shutil
import sys

import hermes_yaml as yaml


def install(source, home):
    source, home = Path(source), Path(home)
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Managed Hermes home must be a real directory")
    plugins = home / "plugins"
    target = plugins / "soma-openai-search"
    config_file = home / "config.yaml"
    for directory in (plugins, target):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError("Managed plugin paths must be real directories")
    if config_file.is_symlink() or (config_file.exists() and not config_file.is_file()):
        raise ValueError("Managed config must be a regular file")
    config = yaml.safe_load(config_file.read_text()) if config_file.exists() else {}
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("Managed config must be a mapping")
    web = config.setdefault("web", {})
    plugin_config = config.setdefault("plugins", {})
    if not isinstance(web, dict) or not isinstance(plugin_config, dict):
        raise ValueError("Web and plugin config must be mappings")
    enabled = plugin_config.setdefault("enabled", [])
    disabled = plugin_config.get("disabled", [])
    if not isinstance(enabled, list) or not isinstance(disabled, list):
        raise ValueError("Plugin selections must be lists")
    if "soma-openai-search" not in disabled and "soma-openai-search" not in enabled:
        enabled.append("soma-openai-search")
    # Preserve an operator's explicit backend choice on repeat setup.
    if not web.get("search_backend") and not web.get("backend"):
        web["search_backend"] = "soma-openai"
    if web.get("search_backend") == "soma-openai":
        # Do not silently send a failed OpenAI query to anonymous third-party backends.
        web["keyless_rescue"] = False
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ("__init__.py", "plugin.yaml"):
        destination = target / name
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise ValueError("Managed plugin files must be regular files")
        shutil.copyfile(source / name, destination)
        destination.chmod(0o600)
    # Write atomically, retaining unrelated provider, gateway and tool settings.
    import tempfile
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=home, prefix=".soma-web-", delete=False) as stream:
            temporary = Path(stream.name)
            yaml.safe_dump(config, stream, sort_keys=False, allow_unicode=True)
        os.replace(temporary, config_file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
