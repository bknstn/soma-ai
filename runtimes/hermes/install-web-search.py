"""Install SOMA's maintained plugin into the explicit managed Hermes home."""

from pathlib import Path
import shutil
import sys

def install(source, home):
    source, home = Path(source), Path(home)
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Managed Hermes home must be a real directory")
    plugins = home / "plugins"
    target = plugins / "soma-openai-search"
    for directory in (plugins, target):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError("Managed plugin paths must be real directories")
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ("__init__.py", "plugin.yaml"):
        destination = target / name
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise ValueError("Managed plugin files must be regular files")
        shutil.copyfile(source / name, destination)
        destination.chmod(0o600)


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
