"""Synthetic context policy contracts; no installed Hermes or YAML dependency needed."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("soma_context_policy", ROOT / "runtimes/hermes/context-policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class JsonCodec:
    """Isolate the transaction contract from the native YAML codec (covered in CI)."""
    load = staticmethod(json.loads)

    @staticmethod
    def dump(value, stream):
        json.dump(value, stream)


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soma-context-policy-test-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.cleanup)
        self.home, self.managed = self.root / "hermes-home", self.root / "hermes-managed"
        self.home.mkdir()
        self.managed.mkdir()
        self.config = self.home / "config.yaml"
        self.codec = JsonCodec()

    def cleanup(self):
        self.temp.cleanup()
        self.assertFalse(self.root.exists())

    def edit(self, patch_data=None, **kwargs):
        return policy.edit_policy(self.home, self.managed, self.codec, patch_data, **kwargs)

    def write(self, data):
        self.config.write_text(json.dumps(data))

    def assert_no_scratch(self):
        self.assertEqual(list(self.home.glob(".soma-context-*")), [])

    def test_show_is_readonly_and_does_not_guess_a_window(self):
        report = self.edit()
        self.assertFalse(report["changed"])
        self.assertEqual(report["budget"]["status"], "window_required")
        self.assertIsNone(report["budget"]["trigger_tokens"])
        self.assertFalse(self.config.exists())
        self.assertEqual(self.edit(preview_window=128000)["budget"]["status"], "route_required")
        self.assert_no_scratch()

    def test_apply_is_atomic_private_preserves_settings_and_is_idempotent(self):
        original = {"web": {"search_backend": "synthetic"}, "model": {"default": "synthetic-model"},
                    "platforms": {"telegram": {"enabled": True}}, "compression": {"progress_notices": False},
                    "private_synthetic_setting": "SYNTHETIC_PRIVATE_VALUE"}
        self.write(original)
        self.config.chmod(0o644)
        report = self.edit({"threshold": 0.8, "min_tail_user_messages": 3})
        saved = json.loads(self.config.read_text())
        for key in original:
            if key != "compression":
                self.assertEqual(saved[key], original[key])
        self.assertFalse(saved["compression"]["progress_notices"])
        self.assertTrue(report["changed"])
        self.assertNotIn("SYNTHETIC_PRIVATE_VALUE", json.dumps(report))
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        before = self.config.read_bytes(), self.config.stat().st_mtime_ns
        self.assertFalse(self.edit({"threshold": 0.8, "min_tail_user_messages": 3})["changed"])
        self.assertEqual((self.config.read_bytes(), self.config.stat().st_mtime_ns), before)
        self.assert_no_scratch()

    def test_json_schema_ranges_and_relations_reject_without_writing(self):
        bad_patches = [
            {"threshold": "0.7"}, {"threshold": True}, {"threshold": float("nan")}, {"threshold": float("inf")},
            {"threshold": 0.99}, {"target_ratio": 0.09}, {"threshold_tokens": 0}, {"threshold_tokens": True},
            {"enabled": "false"}, {"protect_last_n": 0}, {"protect_last_n": 1.5}, {"tail_mode": "unknown"},
            {"min_tail_user_messages": 21}, {"hygiene_hard_message_limit": 24},
        ]
        self.write({"compression": {}})
        before = self.config.read_bytes()
        for patch_data in bad_patches:
            with self.subTest(patch=patch_data), self.assertRaises(policy.PolicyError):
                self.edit(patch_data)
            self.assertEqual(self.config.read_bytes(), before)
            self.assert_no_scratch()
            if not set(patch_data) & {"min_tail_user_messages", "hygiene_hard_message_limit"}:
                with self.assertRaises(policy.PolicyError):
                    policy.parse_policy(json.dumps({"schema_version": 1, "compression": patch_data}).encode())
        for raw in (b'{}', b'[]', b'{"schema_version":true,"compression":{"enabled":false}}',
                    b'{"schema_version":1,"compression":{"unknown":1}}',
                    b'{"schema_version":1,"compression":{"threshold":0.7,"threshold":0.8}}',
                    b'X' * 8193):
            with self.assertRaises(policy.PolicyError):
                policy.parse_policy(raw)

    def test_schema_example_and_disable_reenable_roundtrip(self):
        raw = (ROOT / "examples/context-policy.json").read_bytes()
        settings = policy.parse_policy(raw)
        self.edit(settings)
        snapshot = self.edit()["policy"]
        self.assertEqual(self.edit({"enabled": False})["budget"]["status"], "disabled")
        self.edit(policy.parse_policy(json.dumps(snapshot).encode()))
        self.assertEqual(self.edit()["policy"], snapshot)
        settings["threshold_tokens"] = 25000
        self.edit(settings)
        self.assertIsNone(self.edit({"threshold_tokens": None})["policy"]["compression"]["threshold_tokens"])

    def test_managed_overlay_wins_and_shadowed_changes_fail(self):
        self.write({"compression": {"threshold": 0.5}})
        (self.managed / "config.yaml").write_text('{"compression":{"threshold":0.85}}')
        self.assertEqual(self.edit()["policy"]["compression"]["threshold"], 0.85)
        before = self.config.read_bytes()
        with self.assertRaises(policy.PolicyError):
            self.edit({"threshold": 0.7})
        self.assertEqual(self.config.read_bytes(), before)

    def test_budget_failure_never_applies_patch(self):
        self.write({"model": {"default": "synthetic-model", "provider": "synthetic", "context_length": 128000}})
        before = self.config.read_bytes()

        def unavailable(*args):
            raise RuntimeError("SYNTHETIC_PRIVATE_VALUE")

        with self.assertRaisesRegex(policy.PolicyError, "budget_unavailable"):
            self.edit({"threshold": 0.8}, budget_resolver=unavailable)
        self.assertEqual(self.config.read_bytes(), before)

    def test_preview_is_not_a_model_change_and_count_limit_remains_separate(self):
        self.write({"model": {"default": "synthetic-model", "provider": "synthetic", "context_length": 128000}})
        calls = []

        def budget(config, settings, window):
            calls.append(window)
            return {"trigger_tokens": 50000}

        before = self.config.read_bytes()
        report = self.edit(preview_window=256000, budget_resolver=budget)
        self.assertEqual(calls, [256000])
        self.assertEqual(report["budget"]["status"], "preview_window")
        self.assertEqual(report["budget"]["gateway_trigger_tokens"], 217600)
        self.assertEqual(report["policy"]["compression"]["hygiene_hard_message_limit"], 5000)
        self.assertEqual(self.config.read_bytes(), before)

    def test_external_and_native_engines_do_not_claim_local_thresholds(self):
        for config, status in (({"context": {"engine": "synthetic-plugin"}}, "external_engine"),
                               ({"compression": {"codex_responses_native": True}}, "native_compaction"),
                               ({"model": {"api_mode": "codex_app_server"}}, "native_compaction")):
            self.write(config)
            self.assertEqual(self.edit(preview_window=128000)["budget"]["status"], status)
            self.assertIsNone(self.edit()["budget"]["trigger_tokens"])

    def test_symlinks_hardlinks_malformed_and_oversized_config_are_rejected(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.write_text('{"SYNTHETIC_PRIVATE":"keep"}')
        self.config.symlink_to(elsewhere)
        with self.assertRaises(policy.PolicyError):
            self.edit({"threshold": 0.8})
        self.config.unlink()
        os.link(elsewhere, self.config)
        with self.assertRaises(policy.PolicyError):
            self.edit()
        self.config.unlink()
        for content in ('[1]', 'invalid', ' ' * (policy.MAX_CONFIG_BYTES + 1), '{"compression":null}'):
            self.config.write_text(content)
            with self.assertRaises(policy.PolicyError):
                self.edit()
        self.assertEqual(elsewhere.read_text(), '{"SYNTHETIC_PRIVATE":"keep"}')
        self.assert_no_scratch()

    def test_failed_replace_and_competing_edit_clean_up_scratch(self):
        self.write({})
        with patch.object(policy.os, "replace", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.edit({"enabled": False})
        self.assertEqual(json.loads(self.config.read_text()), {})
        self.assert_no_scratch()
        real_dump = self.codec.dump

        def competing_dump(data, stream):
            real_dump(data, stream)
            self.write({"web": {"search_backend": "concurrent-choice"}})

        with patch.object(self.codec, "dump", side_effect=competing_dump):
            with self.assertRaisesRegex(policy.PolicyError, "config_changed"):
                self.edit({"enabled": False})
        self.assertEqual(json.loads(self.config.read_text()), {"web": {"search_backend": "concurrent-choice"}})
        self.assert_no_scratch()


if __name__ == "__main__":
    unittest.main()
