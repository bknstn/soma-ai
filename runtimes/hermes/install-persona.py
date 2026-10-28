"""Install SOMA's reply policies and automatic speech-language selection."""

import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile


START = "<!-- soma:response-language:start -->"
END = "<!-- soma:response-language:end -->"
STYLE_START = "<!-- soma:response-style:start -->"
STYLE_END = "<!-- soma:response-style:end -->"
POLICY_BLOCKS = ((START, END), (STYLE_START, STYLE_END))
STT_PROVIDERS = ("local", "groq", "openai", "mistral", "xai", "elevenlabs", "deepinfra")


def policy_span(text, start_marker=START, end_marker=END):
    if start_marker not in text and end_marker not in text:
        return None
    if text.count(start_marker) != 1 or text.count(end_marker) != 1:
        raise ValueError("Response policy markers must form one complete block")
    start, end = text.index(start_marker), text.index(end_marker)
    if end < start:
        raise ValueError("Response policy markers are out of order")
    return start, end + len(end_marker)


def policy_spans(text):
    spans = [policy_span(text, *markers) for markers in POLICY_BLOCKS]
    present = sorted(span for span in spans if span is not None)
    if any(left[1] > right[0] for left, right in zip(present, present[1:])):
        raise ValueError("Response policy blocks must not overlap")
    return spans


def install(source, home):
    source, home = Path(source), Path(home)
    target = home / "SOUL.md"
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Managed Hermes home must be a real directory")
    for filename in (source, target):
        if filename.is_symlink() or (filename.exists() and not filename.is_file()):
            raise ValueError("Persona files must be regular files")
    template = source.read_text(encoding="utf-8")
    spans = policy_spans(template)
    if any(span is None for span in spans):
        raise ValueError("SOMA persona template is missing a response policy")
    policies = [template[start:end] for start, end in spans]
    old = None
    if target.exists():
        with target.open(encoding="utf-8", newline="") as stream:
            old = stream.read()
    if old is None:
        updated = template
    else:
        policy_spans(old)  # Validate all blocks before changing any text.
        updated = old
        for markers, policy in zip(POLICY_BLOCKS, policies):
            span = policy_span(updated, *markers)
            if span is None:
                updated += ("\n\n" if not updated.endswith("\n\n") else "") + policy + "\n"
            else:
                updated = updated[:span[0]] + policy + updated[span[1]:]
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
        raise SystemExit("Response policy installation failed; inspect private paths and configuration.") from None
