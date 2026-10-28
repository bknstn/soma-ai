"""Offline persona upgrades using only disposable synthetic runtime homes."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("soma_persona", ROOT / "runtimes/hermes/install-persona.py")
persona = importlib.util.module_from_spec(spec)
spec.loader.exec_module(persona)


class PersonaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soma-persona-test-")
        self.addCleanup(self.cleanup)
        self.home = Path(self.temp.name)
        self.target = self.home / "SOUL.md"
        self.source = ROOT / "runtimes/hermes/SOUL.md"
        self.template = self.source.read_text()
        start, end = persona.policy_span(self.template)
        self.policy = self.template[start:end]
        start, end = persona.policy_span(self.template, persona.STYLE_START, persona.STYLE_END)
        self.style = self.template[start:end]
        self.yaml = SimpleNamespace(load=json.loads, dump=lambda value, stream: json.dump(value, stream))

    def cleanup(self):
        self.temp.cleanup()
        self.assertFalse(self.home.exists())

    def install(self):
        persona.install(self.source, self.home)
        self.assertFalse(list(self.home.glob(".soma-persona-*")))

    def test_fresh_install_seeds_full_persona_and_repeat_is_noop(self):
        self.install()
        self.assertEqual(self.target.read_bytes(), self.source.read_bytes())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        with patch.object(persona.os, "replace") as replace:
            self.install()
        replace.assert_not_called()

    def test_legacy_persona_gains_policy_once_and_preserves_custom_text(self):
        custom = b"# Synthetic custom persona\r\nKeep replies brief.\r\n"
        self.target.write_bytes(custom)
        self.install()
        installed = self.target.read_bytes()
        self.assertTrue(installed.startswith(custom))
        self.assertIn(self.policy.encode(), installed)
        self.assertIn(self.style.encode(), installed)
        self.install()
        self.assertEqual(self.target.read_bytes(), installed)

    def test_managed_block_refresh_preserves_surrounding_customizations(self):
        before, after = "# Synthetic persona\n\n", "\n\nCustom operator instructions.\n"
        self.target.write_text(before + persona.START + "\nOutdated policy.\n" + persona.END +
                               after + persona.STYLE_START + "\nOutdated style.\n" + persona.STYLE_END)
        self.install()
        self.assertEqual(self.target.read_text(), before + self.policy + after + self.style)

    def test_language_only_upgrade_adds_style_and_preserves_language_and_custom_text(self):
        original = "# Synthetic persona\n" + self.policy + "\nCustom operator instructions.\n"
        self.target.write_text(original)
        self.install()
        installed = self.target.read_text()
        self.assertTrue(installed.startswith(original))
        self.assertEqual(installed.count(persona.STYLE_START), 1)
        self.assertIn(self.style, installed)
        with patch.object(persona.os, "replace") as replace:
            self.install()
        replace.assert_not_called()

    def test_malformed_blocks_fail_without_modifying_persona(self):
        invalid = []
        for start, end in persona.POLICY_BLOCKS:
            invalid.extend((start, end, end + start, start + end + start + end))
        invalid.extend((persona.START + persona.STYLE_START + persona.STYLE_END + persona.END,
                        persona.START + persona.STYLE_START + persona.END + persona.STYLE_END))
        for content in invalid:
            self.target.write_text(content)
            with self.assertRaises(ValueError):
                self.install()
            self.assertEqual(self.target.read_text(), content)

    def test_missing_template_policy_fails_without_modifying_existing_persona(self):
        source = self.home / "synthetic-template.md"
        source.write_text(self.policy)
        self.target.write_text("Synthetic existing persona")
        with self.assertRaises(ValueError):
            persona.install(source, self.home)
        self.assertEqual(self.target.read_text(), "Synthetic existing persona")

    def test_symlink_target_and_home_are_rejected(self):
        outside = self.home / "synthetic-original.md"
        outside.write_text("Synthetic content")
        self.target.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(outside.read_text(), "Synthetic content")
        linked_home = self.home / "linked-home"
        linked_home.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(ValueError):
            persona.install(self.source, linked_home)

    def test_failed_atomic_replace_preserves_persona_and_removes_temporary(self):
        self.target.write_text("Synthetic existing persona")
        with patch.object(persona.os, "replace", side_effect=OSError("Synthetic failure")):
            with self.assertRaises(OSError):
                self.install()
        self.assertEqual(self.target.read_text(), "Synthetic existing persona")
        self.assertFalse(list(self.home.glob(".soma-persona-*")))

    def test_stt_auto_detection_is_seeded_and_repeat_is_noop(self):
        persona.configure_transcription(self.home, self.yaml)
        config = self.home / "config.yaml"
        self.assertEqual(json.loads(config.read_text()), {"stt": {"language": ""}})
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        with patch.object(persona.os, "replace") as replace:
            persona.configure_transcription(self.home, self.yaml)
        replace.assert_not_called()

    def test_stt_english_and_provider_hints_are_cleared_preserving_other_settings(self):
        original = {"model": {"provider": "synthetic", "default": "synthetic-model"},
                    "plugins": {"enabled": ["synthetic-plugin"]},
                    "stt": {"language": "en", "provider": "openai", "enabled": True,
                            "openai": {"language": "en", "model": "synthetic-stt", "timeout": 42},
                            "elevenlabs": {"language_code": "eng"}, "local": {"language": "ru"}}}
        config = self.home / "config.yaml"
        config.write_text(json.dumps(original))
        persona.configure_transcription(self.home, self.yaml)
        expected = json.loads(json.dumps(original))
        expected["stt"]["language"] = ""
        expected["stt"]["openai"]["language"] = ""
        expected["stt"]["elevenlabs"]["language_code"] = ""
        expected["stt"]["local"]["language"] = ""
        self.assertEqual(json.loads(config.read_text()), expected)
        self.assertFalse(list(self.home.glob(".soma-language-*")))

    def test_invalid_stt_and_symlink_config_fail_without_changes(self):
        config = self.home / "config.yaml"
        for value in ({"stt": []}, {"stt": {"openai": "invalid"}}):
            original = json.dumps(value)
            config.write_text(original)
            with self.assertRaises(ValueError):
                persona.configure_transcription(self.home, self.yaml)
            self.assertEqual(config.read_text(), original)
        config.unlink()
        outside = self.home / "synthetic-config.json"
        outside.write_text("{}")
        config.symlink_to(outside)
        with self.assertRaises(Exception):
            persona.configure_transcription(self.home, self.yaml)
        self.assertEqual(outside.read_text(), "{}")

    def test_failed_stt_replace_preserves_config_and_cleans_temporary(self):
        config = self.home / "config.yaml"
        config.write_text('{"stt":{"language":"en"}}')
        original = config.read_bytes()
        with patch.object(persona.os, "replace", side_effect=OSError("Synthetic failure")):
            with self.assertRaises(OSError):
                persona.configure_transcription(self.home, self.yaml)
        self.assertEqual(config.read_bytes(), original)
        self.assertFalse(list(self.home.glob(".soma-language-*")))


if __name__ == "__main__":
    unittest.main()
