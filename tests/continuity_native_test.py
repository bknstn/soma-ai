"""Native pinned registration, explicit consent, bounded prompt and unload; synthetic state only."""

import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/hermes-agent"))


class NativeContinuityTest(unittest.TestCase):
    def test_pinned_plugin_apis(self):
        def deny_network(*args, **kwargs):
            raise AssertionError("Native continuity tests must remain offline")

        def deny_private(event, args):
            if event == "open" and isinstance(args[0], (str, bytes)):
                if Path(os.fsdecode(args[0])).name in {"auth.json", "state.db", "sessions.db", ".env", ".op.env"}:
                    raise AssertionError("Continuity must not read auth, history, or secrets")

        sys.addaudithook(deny_private)
        with tempfile.TemporaryDirectory(prefix="soma-continuity-native-") as temporary:
            root = Path(temporary).resolve()
            home = root / "hermes-home"
            home.mkdir()
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root / "user-home"),
                   "HERMES_HOME": str(home), "HERMES_MANAGED_DIR": str(root / "hermes-managed"),
                   "HERMES_DISABLE_LAZY_INSTALLS": "1", "PYTHONNOUSERSITE": "1",
                   "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
                   "XDG_DATA_HOME": str(root / "data"), "XDG_STATE_HOME": str(root / "state")}
            if os.environ.get("HERMES_RUNTIME_DIR"):
                env["HERMES_RUNTIME_DIR"] = os.environ["HERMES_RUNTIME_DIR"]
            dependency_home = os.environ.get("SOMA_TEST_DEPENDENCY_HOME")
            if dependency_home:
                self.assertEqual(Path(dependency_home), Path(env["HERMES_RUNTIME_DIR"]).parent / "hermes-home")
            with patch.object(socket.socket, "connect", deny_network), patch.object(socket.socket, "connect_ex", deny_network), \
                    patch.object(socket, "getaddrinfo", deny_network):
                with patch.dict(os.environ, {**env, "HERMES_HOME": dependency_home or str(home)}, clear=True):
                    import hermes_bootstrap  # noqa: F401
                with patch.dict(os.environ, env, clear=True):
                    from hermes_yaml import roundtrip_yaml
                    from hermes_cli.plugins import PluginManager
                    from hermes_cli.plugins_manifest import parse_manifest_file
                    from hermes_cli.plugin_command_dispatch import invoke_plugin_command
                    from hermes_cli.plugin_choices import bind_asker
                    from gateway.config import Platform
                    from gateway.session import SessionSource
                    from gateway.session_context import set_session_vars, clear_session_vars
                    from types import SimpleNamespace
                    from agent.turn_context import _collect_pre_llm_call_context

                    config = '# preserve me\nmodel:\n  default: "synthetic-model"\nplugins:\n  entries:\n    soma-continuity:\n      settings:\n        enabled: true\n'
                    (home / "config.yaml").write_text(config)
                    spec = importlib.util.spec_from_file_location("soma_native_continuity_install", ROOT / "runtimes/hermes/install-continuity.py")
                    installer = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(installer)
                    installer.install(ROOT / "runtimes/hermes/plugins/soma-continuity", home, roundtrip_yaml())
                    before = (home / "config.yaml").read_bytes()
                    self.assertIn(b"# preserve me", before)
                    self.assertIn(b'"synthetic-model"', before)
                    installer.install(ROOT / "runtimes/hermes/plugins/soma-continuity", home, roundtrip_yaml())
                    self.assertEqual((home / "config.yaml").read_bytes(), before)
                    directory = home / "plugins/soma-continuity"
                    manifest = parse_manifest_file(directory / "plugin.yaml", directory, "user", "")
                    self.assertIsNotNone(manifest)
                    manager = PluginManager(scope_key=str(home))
                    try:
                        manager._load_plugin(manifest)
                        self.assertFalse(manager._plugins["soma-continuity"].error)
                        handler = manager._plugin_commands["soma-continuity"]["handler"]
                        source = SessionSource(platform=Platform.TELEGRAM, chat_id="1001", user_id="1001", message_id="1")
                        with bind_asker(lambda question, choices: "Confirm"):
                            result = invoke_plugin_command(handler, "add commitment Review the synthetic plan", source=source,
                                                           session_id="synthetic-session", session_key="synthetic-route", platform="telegram")
                        self.assertTrue(result.startswith("add:"), result)
                        tokens = set_session_vars(platform="telegram", chat_type="dm", chat_id="1001", user_id="1001",
                                                  session_id="synthetic-session", session_key="synthetic-route", cron_session="")
                        try:
                            results = manager.invoke_hook("pre_llm_call", session_id="synthetic-session", platform="telegram", sender_id="1001")
                            self.assertEqual(len(results), 1)
                            self.assertIn("Review the synthetic plan", results[0])
                            self.assertLessEqual(len(results[0]), 4000)
                            agent = SimpleNamespace(session_id="synthetic-session", model="synthetic-model", platform="telegram",
                                                    _user_id="1001", _persist_disabled=False, _parent_session_id="")
                            # A new/compressed history still receives bounded independent
                            # continuity through the runtime's actual turn-context collector.
                            with patch("hermes_cli.lifecycle.invoke_hook", manager.invoke_hook):
                                context = _collect_pre_llm_call_context(agent, effective_task_id="synthetic-task",
                                          turn_id="synthetic-turn", original_user_message="Synthetic hello", messages=[], conversation_history=[])
                            self.assertIn("Review the synthetic plan", context)
                        finally:
                            clear_session_vars(tokens)
                        self.assertEqual(manager.invoke_hook("pre_llm_call", session_id="other", platform="telegram", sender_id="1001"), [""])
                    finally:
                        manager.unload()
                    self.assertNotIn("soma-continuity", manager._plugin_commands)
                    self.assertEqual(manager._hooks, {})
                    self.assertEqual(list(home.rglob(".soma-continuity-*")), [])
        self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
