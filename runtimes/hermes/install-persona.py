"""Seed SOMA's persona and refresh only its managed response-language policy."""

import os
from pathlib import Path
import sys
import tempfile


START = "<!-- soma:response-language:start -->"
END = "<!-- soma:response-language:end -->"


def policy_span(text):
    if START not in text and END not in text:
        return None
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("Response-language policy markers must form one complete block")
    start, end = text.index(START), text.index(END)
    if end < start:
        raise ValueError("Response-language policy markers are out of order")
    return start, end + len(END)


def install(source, home):
    source, home = Path(source), Path(home)
    target = home / "SOUL.md"
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Managed Hermes home must be a real directory")
    for filename in (source, target):
        if filename.is_symlink() or (filename.exists() and not filename.is_file()):
            raise ValueError("Persona files must be regular files")
    template = source.read_text(encoding="utf-8")
    span = policy_span(template)
    if span is None:
        raise ValueError("SOMA persona template is missing its response-language policy")
    policy = template[span[0]:span[1]]
    old = None
    if target.exists():
        with target.open(encoding="utf-8", newline="") as stream:
            old = stream.read()
    if old is None:
        updated = template
    else:
        span = policy_span(old)
        if span is None:
            updated = old + ("\n\n" if not old.endswith("\n\n") else "") + policy + "\n"
        else:
            updated = old[:span[0]] + policy + old[span[1]:]
    if updated == old:
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=home,
                                         prefix=".soma-persona-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(updated)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
