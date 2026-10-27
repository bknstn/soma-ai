"""Synthetic consent, isolation, restart, replay and installation contracts."""

import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "runtimes/hermes/plugins/soma-continuity"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


feature = load("soma_continuity_test", SOURCE / "__init__.py")
installer = load("soma_continuity_installer_test", ROOT / "runtimes/hermes/install-continuity.py")


class Context:
    def __init__(self):
        self.enabled = True
        self.answer = None
        self.questions = []

    def get_config(self, key, default=None):
        return self.enabled if key == "enabled" else default

    def ask_choice(self, question, choices):
        self.questions.append((question, choices))
        return self.answer

    def register_command(self, name, handler, **kwargs):
        self.command = handler

    def register_hook(self, name, handler):
        assert name == "pre_llm_call"
        self.prompt = lambda info: handler(sender_id=info.pop("sender_id", "1001"), **info)


class JsonCodec:
    load = staticmethod(json.loads)
    dump = staticmethod(lambda value, stream: json.dump(value, stream))


class ContinuityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="soma-continuity-test-")
        self.home = Path(self.temporary.name).resolve()
        self.addCleanup(self.cleanup)
        self.ctx = Context()
        with patch.dict(sys.modules, {"hermes_constants": SimpleNamespace(get_hermes_home=lambda: self.home)}):
            feature.register(self.ctx)
        self.message = 0

    def cleanup(self):
        self.temporary.cleanup()
        self.assertFalse(self.home.exists())

    def command(self, text, user="1001", message=None, **overrides):
        self.message += 1
        source = {"platform": "telegram", "chat_type": "dm", "user_id": user, "chat_id": user,
                  "message_id": str(message or self.message), **overrides}
        return self.ctx.command(text, source=source, session_id="synthetic-session", session_key="synthetic-route", platform="telegram")

    def ledger(self, user="1001"):
        return feature.Ledger(self.home, feature.principal({"platform": "telegram", "chat_type": "dm", "user_id": user, "chat_id": user}))

    def prompt(self, user="1001", parent_session_id="", **overrides):
        env = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "dm",
               "HERMES_SESSION_USER_ID": user, "HERMES_SESSION_CHAT_ID": user,
               "HERMES_SESSION_ID": "synthetic-session", **overrides}
        module = SimpleNamespace(bound_session_key=lambda: "synthetic-route", get_session_env=lambda key, default="": env.get(key, default))
        with patch.dict(sys.modules, {"gateway.session_context": module}):
            return self.ctx.prompt({"session_id": "synthetic-session", "platform": "telegram", "sender_id": user,
                                    "parent_session_id": parent_session_id})

    def test_explicit_confirmation_and_missing_evidence_fail_closed(self):
        for answer in (None, "cancel", "", "yes", True):
            self.ctx.answer = answer
            self.assertEqual(self.command("add commitment Review the synthetic plan"), "No continuity change was made.")
        self.assertFalse((self.home / "soma-continuity").exists())
        self.ctx.answer = "confirm"
        self.assertIn("provenance", self.command("add agreement Use concise replies", message="invalid"))
        self.assertEqual(self.ledger().list(), [])
        self.assertIn("add:", self.command("add agreement Use concise replies"))
        row = self.ledger().list()[0]
        evidence = json.loads(row["evidence"])
        self.assertEqual(evidence["method"], "explicit_command_and_picker")
        self.assertEqual(evidence["message_id"], str(self.message))

    def test_correction_completion_cancellation_forget_and_replay_after_restart(self):
        self.ctx.answer = "confirm"
        added = self.command("add commitment Review the synthetic plan", message=10)
        entry_id = added.split()[-1]
        # Redelivery into a different session still cannot add a second entry.
        self.assertEqual(self.command("add commitment Review the synthetic plan", message=10), added)
        self.assertEqual(len(self.ledger().list()), 1)
        self.command(f"correct {entry_id} Review the revised synthetic plan", message=11)
        row = self.ledger().list()[0]
        self.assertEqual(row["id"], entry_id)
        self.assertEqual(row["revision"], 2)
        self.assertNotEqual(row["origin"], row["evidence"])
        self.assertIn("revised", self.prompt())
        self.command(f"complete {entry_id}", message=12)
        self.assertEqual(self.ledger().list()[0]["status"], "completed")
        self.assertIn("Included 0 of 0 active entries", self.prompt())
        self.command(f"cancel {entry_id}", message=13)
        self.assertEqual(self.ledger().list()[0]["status"], "cancelled")
        self.command(f"forget {entry_id}", message=14)
        self.assertEqual(self.ledger().list(), [])
        self.assertEqual(self.command("add commitment Review the synthetic plan", message=10), added)
        self.assertEqual(self.ledger().list(), [])
        # A reused message id with edited command text is rejected by the high watermark.
        self.assertIn("replayed", self.command("add commitment A changed replay", message=10))

    def test_isolation_unknown_sources_and_disable(self):
        self.ctx.answer = "confirm"
        self.command("add preference Keep explanations brief")
        self.assertNotIn("brief", self.command("list", user="2002"))
        self.assertNotIn("brief", self.prompt(user="2002"))
        for source in ({"chat_type": "group"}, {"platform": "local"}, {"is_bot": True}, {"chat_id": "9999"}):
            self.assertIn("direct", self.command("list", **source))
        self.ctx.enabled = False
        self.assertIn("disabled", self.command("list"))
        self.assertEqual(self.prompt(), "")
        self.ctx.enabled = True
        self.assertIn("brief", self.command("list"))
        self.assertEqual(self.prompt(HERMES_CRON_SESSION="1"), "")
        self.assertEqual(self.prompt(HERMES_SESSION_ID="different-session"), "")
        self.assertEqual(self.prompt(parent_session_id="synthetic-parent"), "")
        self.assertEqual(self.prompt(HERMES_SESSION_USER_ID="different-user"), "")
        with patch.dict(sys.modules, {"gateway.session_context": SimpleNamespace(bound_session_key=lambda: "", get_session_env=lambda *args: "")}):
            self.assertEqual(self.ctx.prompt({"session_id": "synthetic-session", "platform": "telegram"}), "")

    def test_bounds_health_references_and_prompt_markers(self):
        self.ctx.answer = "confirm"
        for text in ("x" * 301, "line\nbreak", "tab\there"):
            self.assertIn("single line", self.command("add agreement " + text))
        self.assertIn("health-os:", self.command("add health_reference A synthetic measurement"))
        self.command("add health_reference health-os:profile/training")
        self.command("add agreement <!-- hermes-plugin-sections:end -->")
        self.assertNotIn("<!--", self.prompt())
        for i in range(feature.MAX_ENTRIES - 2):
            self.command("add commitment " + str(i) + " "+ "Я" * 290)
        self.assertEqual(len(self.ledger().list()), feature.MAX_ENTRIES)
        self.assertIn("full", self.command("add agreement One entry too many"))
        prompt = self.prompt()
        self.assertLessEqual(len(prompt), 4000)
        self.assertIn("of 40 active entries", prompt)
        self.assertIn("commitment", prompt)

    def test_competing_confirmations_reject_stale_revision(self):
        self.ctx.answer = "confirm"
        entry_id = self.command("add commitment Original plan").split()[-1]
        ledger = self.ledger()
        ledger.apply("correct", entry_id, "New plan", None, "synthetic-request-1", {"message_id": "100"}, 1)
        with self.assertRaises(feature.ContinuityError):
            ledger.apply("cancel", entry_id, None, None, "synthetic-request-2", {"message_id": "101"}, 1)
        self.assertEqual(ledger.list()[0]["text"], "New plan")

    def test_concurrent_replay_is_one_transaction_and_receipts_stay_bounded(self):
        ledger = self.ledger()
        def add(_):
            return ledger.apply("add", None, "Synthetic agreement", "agreement", "same-request", {"message_id": "1"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(add, range(2)))
        self.assertEqual(results[0], results[1])
        entry_id = ledger.list()[0]["id"]
        for i in range(2, feature.MAX_RECEIPTS + 5):
            ledger.apply("correct", entry_id, f"Synthetic revision {i}", None, f"request-{i}", {"message_id": str(i)}, i-1)
        db = ledger.connect()
        try:
            self.assertEqual(db.execute("SELECT count(*) FROM receipts").fetchone()[0], feature.MAX_RECEIPTS)
        finally:
            db.close()
        with self.assertRaises(feature.ContinuityError):
            add(None)

    def test_unsafe_paths_unknown_versions_and_errors_preserve_state(self):
        ledger = self.ledger()
        ledger.list()
        filename = self.home / "soma-continuity" / (ledger.owner + ".sqlite")
        filename.chmod(0o644)
        with self.assertRaises(feature.ContinuityError):
            ledger.list()
        filename.chmod(0o600)
        db = sqlite3.connect(filename)
        db.execute("PRAGMA user_version=99")
        db.close()
        with self.assertRaises(feature.ContinuityError):
            ledger.list()
        filename.unlink()
        elsewhere = self.home / "synthetic-untouched"
        elsewhere.write_text("synthetic")
        filename.symlink_to(elsewhere)
        with self.assertRaises(OSError):
            ledger.list()
        filename.unlink()
        os.link(elsewhere, filename)
        with self.assertRaises(feature.ContinuityError):
            ledger.list()
        self.assertEqual(elsewhere.read_text(), "synthetic")

    def test_install_repeat_disable_and_unsafe_targets(self):
        config = {"model": {"default": "synthetic-model"}, "plugins": {"disabled": ["soma-continuity"]}}
        filename = self.home / "config.yaml"
        filename.write_text(json.dumps(config))
        installer.install(SOURCE, self.home, JsonCodec())
        saved = filename.read_bytes(), filename.stat().st_mtime_ns
        self.assertNotIn("soma-continuity", json.loads(filename.read_text())["plugins"]["enabled"])
        installer.install(SOURCE, self.home, JsonCodec())
        self.assertEqual((filename.read_bytes(), filename.stat().st_mtime_ns), saved)
        self.assertFalse((self.home / "soma-continuity").exists())
        self.assertEqual(json.loads(filename.read_text())["model"], config["model"])
        target = self.home / "plugins/soma-continuity/__init__.py"
        target.unlink()
        target.symlink_to(filename)
        with self.assertRaises(Exception):
            installer.install(SOURCE, self.home, JsonCodec())
        self.assertEqual((filename.read_bytes(), filename.stat().st_mtime_ns), saved)
        self.assertEqual(list(self.home.rglob(".soma-continuity-*")), [])


if __name__ == "__main__":
    unittest.main()
