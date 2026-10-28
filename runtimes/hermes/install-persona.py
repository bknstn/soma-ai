"""Install SOMA's reply-language policy and automatic speech-language selection."""

import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile


START = "<!-- soma:response-language:start -->"
END = "<!-- soma:response-language:end -->"
STT_PROVIDERS = ("local", "groq", "openai", "mistral", "xai", "elevenlabs", "deepinfra")


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


def configure_transcription(home, yaml):
    """Override Hermes' English STT default without changing provider/model settings."""
    home = Path(home)
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Managed Hermes home must be a real directory")
    spec = importlib.util.spec_from_file_location("soma_language_io", Path(__file__).with_name("context-policy.py"))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    filename = home / "config.yaml"
    config, original = policy.read_mapping(filename, yaml)
    stt = config.setdefault("stt", {})
    if not isinstance(stt, dict):
        raise ValueError("Speech transcription settings must be a mapping")
    # Empty means auto-detect in the pinned Hermes resolver; the literal "auto"
    # would instead be sent to cloud APIs as an unsupported language code.
    changed = stt.get("language") != ""
    stt["language"] = ""
    for provider in STT_PROVIDERS:
        section = stt.get(provider)
        if section is None:
            continue
        if not isinstance(section, dict):
            raise ValueError("Speech provider settings must be mappings")
        for field in ("language", "language_code"):
            if field in section and section[field] != "":
                section[field] = ""
                changed = True
    if not changed:
        return
    output = io.StringIO()
    yaml.dump(config, output)
    serialized = output.getvalue().encode("utf-8")
    if len(serialized) > policy.MAX_CONFIG_BYTES:
        raise ValueError("Configuration too large")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=home, prefix=".soma-language-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        if policy.read_regular(filename, policy.MAX_CONFIG_BYTES) != original:
            raise ValueError("Configuration changed during installation")
        os.replace(temporary, filename)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    from hermes_yaml import roundtrip_yaml
    try:
        configure_transcription(sys.argv[2], roundtrip_yaml())
        install(sys.argv[1], sys.argv[2])
    except Exception:
        raise SystemExit("Language policy installation failed; inspect private paths and configuration.") from None
