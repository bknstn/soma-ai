"""Offline persona upgrades using only disposable synthetic runtime homes."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


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
        self.install()
        self.assertEqual(self.target.read_bytes(), installed)

    def test_managed_block_refresh_preserves_surrounding_customizations(self):
        before, after = "# Synthetic persona\n\n", "\n\nCustom operator instructions.\n"
        self.target.write_text(before + persona.START + "\nOutdated policy.\n" + persona.END + after)
        self.install()
        self.assertEqual(self.target.read_text(), before + self.policy + after)

    def test_malformed_blocks_fail_without_modifying_persona(self):
        for content in (persona.START, persona.END, persona.END + persona.START,
                        persona.START + persona.END + persona.START + persona.END):
            self.target.write_text(content)
            with self.assertRaises(ValueError):
                self.install()
            self.assertEqual(self.target.read_text(), content)

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


if __name__ == "__main__":
    unittest.main()
