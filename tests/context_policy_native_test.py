"""Exercise native YAML and the pinned compressor against only disposable state."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/hermes-agent"))


class NativePolicyTest(unittest.TestCase):
    def test_native_yaml_budgets_and_no_network_or_session_reads(self):
        with tempfile.TemporaryDirectory(prefix="soma-context-native-state-") as temporary:
            root = Path(temporary).resolve()
            home, managed = root / "hermes-home", root / "hermes-managed"
            home.mkdir()
            managed.mkdir()
            (root / "user-home").mkdir()
            # Keep PM's explicit dependency path when running under the CI runtime,
            # but replace every mutable state/config root before importing Hermes.
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root / "user-home"),
                   "USERPROFILE": str(root / "user-home"), "SOMA_RUNTIME_HOME": str(root),
                   "HERMES_HOME": str(home), "HERMES_MANAGED_DIR": str(managed),
                   "HERMES_DISABLE_LAZY_INSTALLS": "1", "PYTHONNOUSERSITE": "1",
                   "XDG_CONFIG_HOME": str(root / "user-home/.config"),
                   "XDG_CACHE_HOME": str(root / "user-home/.cache"),
                   "XDG_DATA_HOME": str(root / "user-home/.local/share"),
                   "XDG_STATE_HOME": str(root / "user-home/.local/state")}
            if os.environ.get("HERMES_RUNTIME_DIR"):
                env["HERMES_RUNTIME_DIR"] = os.environ["HERMES_RUNTIME_DIR"]

            def deny_network(*args, **kwargs):
                raise AssertionError("Context policy must remain offline")

            def no_private_state(event, args):
                if event == "open" and isinstance(args[0], (str, bytes)):
                    filename = os.fsdecode(args[0])
                    if Path(filename).name in {"auth.json", "state.db", "sessions.db", ".env", ".op.env"}:
                        raise AssertionError("Context policy must not access auth, sessions or secrets")

            # This process is disposable; the audit hook covers import-time reads too.
            sys.addaudithook(no_private_state)
            dependency_home = os.environ.get("SOMA_TEST_DEPENDENCY_HOME")
            if dependency_home:
                # PM's committed dependency generation is keyed by home as well as
                # source revision. Activate only the explicit synthetic CI install,
                # then replace every mutable root before importing runtime modules.
                self.assertEqual(Path(dependency_home), Path(env["HERMES_RUNTIME_DIR"]).parent / "hermes-home")
                with patch.dict(os.environ, {**env, "HERMES_HOME": dependency_home}, clear=True), \
                        patch.object(socket.socket, "connect", deny_network), \
                        patch.object(socket.socket, "connect_ex", deny_network), patch.object(socket, "getaddrinfo", deny_network):
                    import hermes_bootstrap
            with patch.dict(os.environ, env, clear=True), patch.object(socket.socket, "connect", deny_network), \
                    patch.object(socket.socket, "connect_ex", deny_network), patch.object(socket, "getaddrinfo", deny_network):
                import hermes_bootstrap  # noqa: F401
                from hermes_yaml import roundtrip_yaml
                from hermes_cli.config_defaults import DEFAULT_CONFIG

                spec = importlib.util.spec_from_file_location("soma_native_policy", ROOT / "runtimes/hermes/context-policy.py")
                policy = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(policy)
                for key, default in policy.FIELDS.items():
                    self.assertEqual(default, DEFAULT_CONFIG["compression"].get(key, 3 if key == "protect_first_n" else None))

                filename = home / "config.yaml"
                original = '# Keep this comment\nmodel:\n  default: synthetic-model\n  provider: synthetic\n  context_length: 128000\nweb:\n  search_backend: "synthetic"\n'
                filename.write_text(original)
                yaml = roundtrip_yaml()
                show = lambda **kwargs: policy.edit_policy(home, managed, yaml, **kwargs)
                report = show()
                self.assertEqual(report["budget"]["trigger_tokens"], 96000)
                self.assertEqual(report["budget"]["tail_budget_tokens"], 10000)
                self.assertEqual(report["budget"]["summary_max_tokens"], 6400)
                self.assertEqual(report["budget"]["gateway_trigger_tokens"], 108800)
                self.assertEqual(filename.read_text(), original)
                self.assertEqual(show(preview_window=32768)["budget"]["trigger_tokens"], 27852)
                self.assertEqual(show(preview_window=1000000)["budget"]["trigger_tokens"], 500000)

                report = show(patch={"threshold_tokens": 32000, "tail_mode": "legacy", "target_ratio": 0.3})
                self.assertEqual(report["budget"]["trigger_tokens"], 32000)
                self.assertEqual(report["budget"]["effective_threshold_ratio"], 0.25)
                self.assertEqual(report["budget"]["tail_budget_tokens"], 9600)
                self.assertIn("# Keep this comment", filename.read_text())
                self.assertIn('search_backend: "synthetic"', filename.read_text())
                saved = filename.read_bytes()
                self.assertFalse(show(patch={"threshold_tokens": 32000})["changed"])
                self.assertEqual(filename.read_bytes(), saved)
                show(patch={"threshold_tokens": None})

                # Provider-specific threshold raising and output reservation use native helpers.
                filename.write_text('model:\n  default: gpt-5.5\n  provider: openai-codex\n  context_length: 272000\n')
                self.assertEqual(show()["budget"]["trigger_tokens"], 231200)
                filename.write_text('model:\n  default: synthetic-model\n  provider: gemini\n  context_length: 128000\n')
                gemini = show()["budget"]
                self.assertEqual(gemini["output_reservation"], 65535)
                self.assertLess(gemini["trigger_tokens"], 128000 - 65535)

                filename.write_text('model:\n  default: synthetic-model\n  provider: synthetic\n  context_length: 128000\ncompression:\n  model_thresholds:\n    synthetic-model: 0.9\n')
                self.assertEqual(show()["budget"]["trigger_tokens"], 115200)
                # Main entry point returns a bounded JSON report with no provider secrets.
                with patch.object(sys, "argv", ["context-policy.py"]), patch("sys.stdout") as stdout:
                    self.assertEqual(policy.main(), 0)
                payload = json.loads(stdout.write.call_args_list[0].args[0])
                self.assertEqual(payload["budget"]["trigger_tokens"], 115200)
                filename.write_text('compression: &shared\n  threshold: 0.5  # keep compression comment\nother: *shared\n')
                show(patch={"threshold": 0.8})
                saved = roundtrip_yaml().load(filename.read_text())
                self.assertEqual(saved["compression"]["threshold"], 0.8)
                self.assertEqual(saved["other"]["threshold"], 0.5)
                self.assertIn("# keep compression comment", filename.read_text())
                self.assertEqual(list(home.glob(".soma-context-*")), [])
        self.assertFalse(root.exists(), "all native test state must be removed")


if __name__ == "__main__":
    unittest.main()
