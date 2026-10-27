"""Pinned hook dispatch, real turn state and task cleanup; fake transport and clock only."""

import asyncio
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/hermes-agent"))


class NativeProgressTest(unittest.TestCase):
    def test_native_contract(self):
        def deny_network(*args, **kwargs):
            raise AssertionError("Progress tests must remain offline")

        def deny_private(event, args):
            if event == "open" and isinstance(args[0], (str, bytes)):
                if Path(os.fsdecode(args[0])).name in {"auth.json", "state.db", "sessions.db", ".env", ".op.env"}:
                    raise AssertionError("Progress must not read credentials or history")

        sys.addaudithook(deny_private)
        with tempfile.TemporaryDirectory(prefix="soma-progress-native-") as temporary:
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
                    self.exercise(home)
        self.assertFalse(root.exists())

    def exercise(self, home):
        from hermes_yaml import roundtrip_yaml
        from hermes_cli.plugins import PluginManager
        from hermes_cli.plugins_manifest import parse_manifest_file
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.session_state import SessionState
        from gateway.session_context import set_session_vars, clear_session_vars
        from gateway.platforms.event import MessageEvent
        from gateway.run import GatewayRunner
        from gateway import plugin_messages
        from gateway.session_envelope import _snapshot_native, restore_native
        from agent.turn_context import _collect_pre_llm_call_context

        (home / "config.yaml").write_text('# preserve\nmodel:\n  default: "synthetic-model"\nplugins:\n  entries:\n    soma-progress:\n      settings:\n        enabled: true\n        interval_seconds: 15\n')
        spec = importlib.util.spec_from_file_location("progress_native_install", ROOT / "runtimes/hermes/install-continuity.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.install(ROOT / "runtimes/hermes/plugins/soma-progress", home, roundtrip_yaml())
        before = (home / "config.yaml").read_bytes(), (home / "config.yaml").stat().st_mtime_ns
        installer.install(ROOT / "runtimes/hermes/plugins/soma-progress", home, roundtrip_yaml())
        self.assertEqual(((home / "config.yaml").read_bytes(), (home / "config.yaml").stat().st_mtime_ns), before)
        self.assertIn(b"# preserve", before[0])
        directory = home / "plugins/soma-progress"
        manifest = parse_manifest_file(directory / "plugin.yaml", directory, "user", "")
        manager = PluginManager(scope_key=str(home))
        manager._load_plugin(manifest)
        try:
            self.assertFalse(manager._plugins["soma-progress"].error)
            start = manager._hooks["pre_llm_call"][0]
            # The native registry stores (plugin id, callback) pairs.
            callback = start[1] if isinstance(start, tuple) else start
            component = sys.modules[callback.__module__]
            source = SessionSource(platform=Platform.TELEGRAM, chat_id="1001", user_id="1001", message_id="1")
            raw = NS(from_user=NS(id=1001, is_bot=False), chat=NS(id=1001, type="private"), message_id=1)
            event = MessageEvent(text="Synthetic task", source=source, raw_message=raw, message_id="1")
            agent = NS(session_id="synthetic-session", model="synthetic-model", platform="telegram", _user_id="1001",
                       _persist_disabled=False, _parent_session_id="", is_interrupted=lambda: False)
            state = SessionState()
            state.turn.agent, state.turn.event = agent, event
            state.persistent.run_generation = 7
            runner = object.__new__(GatewayRunner)
            runner._sessions = {"synthetic-route": state}
            runner._running = True
            runner.config = NS(multiplex_profiles=False)
            runner._is_user_authorized_for_source = lambda source: True
            runner._session_key_for_source = lambda source: "synthetic-route"
            runner.session_store = NS(_generate_session_key=lambda source: "synthetic-route")
            tokens = set_session_vars(platform="telegram", chat_type="dm", chat_id="1001", user_id="1001",
                                      session_id=agent.session_id, session_key="synthetic-route", cron_session="")
            try:
                async def scenario():
                    runner._gateway_loop = asyncio.get_running_loop()
                    clock = [100.0]
                    sent = []
                    async def tick(_seconds):
                        clock[0] += 15
                        await asyncio.sleep(0)
                    class Adapter:
                        async def send(self, chat_id, text, **kwargs):
                            self_outer.assertEqual(chat_id, "1001")
                            self_outer.assertTrue(kwargs["metadata"]["_interim_send"])
                            sent.append(text)
                            return NS(success=True, message_id="synthetic-notice")
                    self_outer = self
                    adapter = Adapter()
                    def resolve(*args, **kwargs):
                        self.assertEqual(kwargs["plugin_home"], home)
                        self.assertEqual(kwargs["plugin_id"], "soma-progress")
                        self.assertEqual(kwargs["session_key"], "synthetic-route")
                        return plugin_messages.PostTarget(platform="telegram", chat_id="1001", adapter=adapter), None
                    with patch("gateway.run._gateway_runner_ref", lambda: runner), \
                            patch.object(component, "time", NS(monotonic=lambda: clock[0])), \
                            patch.object(component, "asyncio", NS(sleep=tick, to_thread=asyncio.to_thread)), \
                            patch.object(plugin_messages, "resolve", resolve), \
                            patch("hermes_cli.lifecycle.invoke_hook", manager.invoke_hook), \
                            patch("hermes_cli.lifecycle.ainvoke_hook", manager.ainvoke_hook), \
                            patch("hermes_cli.lifecycle.has_hook", lambda name: bool(manager._hooks.get(name))):
                        progress = callback.__self__
                        self.assertIs(await runner._hm_pre_gateway_dispatch_hook(event, source), event)
                        self.assertEqual(await runner._hm_post_admission_consume(event, source, "synthetic-route"), (False, None))
                        encoded_source = {**source.to_dict(), "is_bot": False}
                        payload = _snapshot_native(runner, event, None, encoded_source=encoded_source)
                        restored = restore_native(payload, runner)
                        self.assertIsNone(restored.raw_message)
                        state.turn.event = restored
                        manager.invoke_hook("pre_llm_call", session_id=agent.session_id, turn_id="wrong-sender",
                                            platform="telegram", sender_id="1002")
                        manager.invoke_hook("pre_llm_call", session_id="stale-session", turn_id="wrong-session",
                                            platform="telegram", sender_id="1001")
                        self.assertEqual(progress.active, {})
                        context = _collect_pre_llm_call_context(agent, effective_task_id="synthetic-task", turn_id="synthetic-turn",
                                      original_user_message="Synthetic task", messages=[], conversation_history=[])
                        self.assertEqual(context, "")
                        await asyncio.sleep(0)  # launch the native supervised task
                        notice = progress.active["synthetic-route"]
                        # Native human-input context fires both real lifecycle hooks.
                        from tools.human_input_hooks import human_input_request
                        from tools.approval_context import set_current_observability_context, reset_current_observability_context
                        observation = set_current_observability_context(turn_id="synthetic-turn", session_id=agent.session_id)
                        try:
                            with human_input_request("clarify", session_key="synthetic-route") as request:
                                self.assertTrue(notice.waiting)
                                self.assertFalse(notice.ready(1000))
                                request.outcome = "answered"
                            self.assertFalse(notice.waiting)
                        finally:
                            reset_current_observability_context(observation)
                        # Wait for the real supervised task, without wall-clock delays.
                        tasks = [task for task in asyncio.all_tasks() if task.get_name() == "soma-progress"]
                        self.assertEqual(len(tasks), 1)
                        await asyncio.gather(*tasks)
                        self.assertEqual(sent, [component.DEFAULT_MESSAGE])
                        manager.invoke_hook("pre_llm_call", session_id=agent.session_id, turn_id="synthetic-turn",
                                            platform="telegram", sender_id="1001")
                        await asyncio.sleep(0)
                        self.assertEqual(len(sent), 1)
                        manager.invoke_hook("post_llm_call", session_id=agent.session_id, turn_id="synthetic-turn")
                        self.assertEqual(progress.active, {})
                        # Replaying a consumed ingress receipt cannot notify a new turn.
                        manager.invoke_hook("pre_llm_call", session_id=agent.session_id, turn_id="replayed-turn",
                                            platform="telegram", sender_id="1001")
                        self.assertEqual(progress.active, {})
                        event.message_id = "2"
                        raw.message_id = 2
                        self.assertIs(await runner._hm_pre_gateway_dispatch_hook(event, source), event)
                        await runner._hm_post_admission_consume(event, source, "synthetic-route")
                        state.turn.event = event
                        manager.invoke_hook("pre_llm_call", session_id=agent.session_id, turn_id="second-turn",
                                            platform="telegram", sender_id="1001")
                        await asyncio.sleep(0)
                        tasks = [task for task in asyncio.all_tasks() if task.get_name() == "soma-progress"]
                        self.assertEqual(len(tasks), 1)
                        manager.unload()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        self.assertTrue(progress.closed)
                        self.assertEqual(progress.active, {})
                        self.assertEqual(len(sent), 1)
                asyncio.run(scenario())
            finally:
                clear_session_vars(tokens)
        finally:
            manager.unload()
        self.assertEqual(manager._hooks, {})
        self.assertEqual(list(home.rglob(".soma-progress-*")), [])


if __name__ == "__main__":
    unittest.main()
