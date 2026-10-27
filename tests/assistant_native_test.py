"""Pinned loader, startup bridge and atomic session rotation against synthetic native SQLite."""

import asyncio
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/hermes-agent"))


class NativeAssistantTest(unittest.TestCase):
    def test_pinned_contracts(self):
        def deny_network(*_args, **_kwargs):
            raise AssertionError("Assistant native tests must be offline")
        with tempfile.TemporaryDirectory(prefix="soma-assistant-native-") as temporary:
            root = Path(temporary).resolve()
            home = root / "hermes-home"
            home.mkdir()
            def audit(event, args):
                if event == "open" and isinstance(args[0], (str, bytes)):
                    filename = Path(os.fsdecode(args[0]))
                    if filename.name in {"auth.json", ".env", ".op.env"}:
                        raise AssertionError("Credentials must not be read")
                    if filename.name in {"state.db", "sessions.db"} and not filename.resolve().is_relative_to(root):
                        raise AssertionError("Only disposable synthetic runtime state is allowed")
            sys.addaudithook(audit)
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root / "user-home"), "HERMES_HOME": str(home),
                   "HERMES_MANAGED_DIR": str(root / "managed"), "HERMES_DISABLE_LAZY_INSTALLS": "1", "PYTHONNOUSERSITE": "1",
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
        from hermes_cli.plugin_command_dispatch import invoke_plugin_command
        from hermes_cli.plugin_choices import bind_asker
        from gateway.config import GatewayConfig, Platform
        from gateway.session import SessionStore, SessionSource
        from gateway.platforms.event import MessageEvent
        from gateway.session_state import SessionState
        from gateway.hooks import _load_hook_dir
        from hermes_state import SessionDB
        from hermes_state_runtime import begin_runtime_epoch, admit_session_input, RuntimeStoreError, register_worker_execution

        (home / "config.yaml").write_text('# preserved\nplugins:\n  entries:\n    soma-continuity:\n      settings:\n        enabled: true\n    soma-assistant:\n      settings:\n        enabled: true\n        sources: [continuity, operational]\n        greetings: [good morning]\n        daily_time: "00:00"\n        quiet_start: "00:00"\n        quiet_end: "00:00"\n')
        spec = importlib.util.spec_from_file_location("assistant_native_installer", ROOT / "runtimes/hermes/install-continuity.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        source_dir = ROOT / "runtimes/hermes/plugins/soma-assistant"
        installer.install(source_dir, home, roundtrip_yaml())
        assets = list((home / "plugins/soma-assistant").iterdir()) + list((home / "hooks/soma-assistant").iterdir()) + [home / "config.yaml"]
        before = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in assets}
        installer.install(source_dir, home, roundtrip_yaml())
        self.assertEqual(before, {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in assets})
        self.assertFalse(list(home.rglob(".soma-assistant-*")))
        directory = home / "plugins/soma-assistant"
        manager = PluginManager(scope_key=str(home))
        installer.install(ROOT / "runtimes/hermes/plugins/soma-continuity", home, roundtrip_yaml())
        continuity_dir = home / "plugins/soma-continuity"
        manager._load_plugin(parse_manifest_file(continuity_dir / "plugin.yaml", continuity_dir, "user", ""))
        manager._load_plugin(parse_manifest_file(directory / "plugin.yaml", directory, "user", ""))
        loaded = manager._plugins["soma-assistant"]
        self.assertFalse(loaded.error, loaded.error)
        component = loaded.module
        self.assertIsNotNone(component)
        db = SessionDB(home / "synthetic-native.sqlite")
        store = SessionStore(home / "sessions", GatewayConfig(), has_active_processes_fn=lambda key: False)
        store._db = db
        source = SessionSource(platform=Platform.TELEGRAM, chat_id="1001", user_id="1001", message_id="1")
        entry = store.get_or_create_session(source)
        key, sid = entry.session_key, entry.session_id
        boundaries = sys.modules[component.__name__ + ".boundaries"]
        try:
            self.assertIsNotNone(db.get_session(sid))
            epoch = begin_runtime_epoch(db, instance_id="synthetic-owner")
            queued = admit_session_input(db, epoch=epoch, principal_id="synthetic-user", session_id=sid,
                                         request_id="synthetic-queued", payload={"text": "Synthetic queued request"}, intent="queue")
            with self.assertRaisesRegex(RuntimeStoreError, "session_busy"):
                boundaries.rotate_transaction(store, db, key, sid)
            self.assertEqual(store.lookup_by_session_key(key).session_id, sid)
            db._execute_write(lambda conn: conn.execute("UPDATE session_admissions SET status='terminal',outcome='cancelled' WHERE admission_id=?", (queued["admission_id"],)))
            # Registered, running and unknown workers all protect the conversation.
            register_worker_execution(db, epoch=epoch, execution_id="synthetic-worker", session_id=sid,
                                      generation=db.get_session(sid)["runtime_generation"], kind="compute",
                                      adoption_secret="synthetic-adoption-secret-for-offline-test")
            for status in ("registered", "running", "unknown"):
                db._execute_write(lambda conn: conn.execute("UPDATE worker_executions SET status=?", (status,)))
                with self.assertRaises(RuntimeStoreError):
                    boundaries.rotate_transaction(store, db, key, sid)
                self.assertEqual(store.lookup_by_session_key(key).session_id, sid)
            db._execute_write(lambda conn: conn.execute("UPDATE worker_executions SET status='terminal'"))
            fresh = boundaries.rotate_transaction(store, db, key, sid)
            self.assertNotEqual(fresh.session_id, sid)
            self.assertEqual(store.lookup_by_session_key(key).session_id, fresh.session_id)
            self.assertEqual(db.get_session(sid)["end_reason"], "session_reset")
            self.assertEqual(db.get_session(fresh.session_id)["parent_session_id"], sid)
            self.assertIsNone(boundaries.rotate_transaction(store, db, key, sid))
            recovered = SessionStore(home / "sessions", GatewayConfig())
            recovered._db = db
            recovered._entries = {}
            recovered._loaded = False
            self.assertEqual(recovered.get_or_create_session(source).session_id, fresh.session_id)

            raw = NS(from_user=NS(id=1001, is_bot=False), chat=NS(id=1001, type="private"), message_id=1)
            event = MessageEvent(text="/soma-assistant enable", source=source, message_id="1", raw_message=raw)
            runner = NS(_running=True, _draining=False, config=NS(multiplex_profiles=False), session_store=store,
                        _is_user_authorized_for_source=lambda source: True, _session_key_for_source=lambda source: key,
                        _peek_session_state=lambda key: SessionState(), _delivery_adapter_for=lambda source: NS(_pending_messages={}))
            async def rotation_scenario():
                from gateway.session_authority import SessionAuthority
                authority = SessionAuthority(runner, profile_id=str(home), instance_id="synthetic-owner", db=db, epoch=epoch)
                runner.session_authority = authority
                authority._publish_route(source, fresh.session_id, key)
                old_live = authority.sessions[fresh.session_id]
                state = SessionState()
                runner._peek_session_state = lambda key: state
                runner._clear_conversation_scope = lambda key, **kwargs: state.conversation.clear()
                evictions = []
                runner._evict_cached_agent_at_boundary = lambda key: evictions.append(key)
                resets = []
                async def reset(**kwargs):
                    resets.append(kwargs)
                runner._reset_session_off_loop = reset
                with patch("tools.async_delegation.has_live_for_session", return_value=False):
                    state.turn.agent = object()
                    self.assertIsNone(await boundaries.rotate(runner, key, fresh.session_id))
                    state.turn.agent = None
                    state.conversation.queued_events.append(event)
                    self.assertIsNone(await boundaries.rotate(runner, key, fresh.session_id))
                    state.conversation.queued_events.clear()
                    store._has_active_processes_fn = lambda key: True
                    self.assertIsNone(await boundaries.rotate(runner, key, fresh.session_id))
                    store._has_active_processes_fn = lambda key: False
                    original = boundaries.rotate_transaction
                    def late_queue(*args):
                        result = original(*args)
                        # Input arriving after the atomic idle guard must survive
                        # native conversation-scope cleanup and bind to the new route.
                        state.conversation.queued_events.append(event)
                        return result
                    with patch.object(boundaries, "rotate_transaction", late_queue):
                        result = await boundaries.rotate(runner, key, fresh.session_id)
                    self.assertIsNotNone(result)
                    self.assertTrue(old_live.superseded)
                    self.assertIn(result.session_id, authority.sessions)
                    self.assertEqual(state.conversation.queued_events, [event])
                    self.assertEqual(evictions, [key])
                    self.assertEqual(len(resets), 1)
                    self.assertIsNone(await boundaries.rotate(runner, key, fresh.session_id))
                    state.conversation.queued_events.clear()
                    current_sid = store.lookup_by_session_key(key).session_id
                    entered, release = threading.Event(), threading.Event()
                    def delayed(*args):
                        entered.set()
                        self.assertTrue(release.wait(5))
                        return original(*args)
                    with patch.object(boundaries, "rotate_transaction", delayed):
                        caller = asyncio.create_task(boundaries.rotate(runner, key, current_sid))
                        self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                        caller.cancel()
                        await asyncio.gather(caller, return_exceptions=True)
                        # A cancelled hook cannot release its reservation early.
                        self.assertTrue(authority._route_turns[key][0].locked())
                        release.set()
                        await asyncio.gather(*list(authority._mutation_tasks))
                    self.assertNotEqual(store.lookup_by_session_key(key).session_id, current_sid)
            asyncio.run(rotation_scenario())
            handler = manager._plugin_commands["soma-assistant"]["handler"]
            component.assistant.ingress(event=event, gateway=runner)
            with bind_asker(lambda question, choices: "Confirm"):
                answer = invoke_plugin_command(handler, "enable", source=source, session_id=fresh.session_id, session_key=key, platform="telegram")
            self.assertIn("enabled", answer)
            self.assertEqual(component.assistant.state.subscribers(), ["telegram:1001"])
            continuity_handler = manager._plugin_commands["soma-continuity"]["handler"]
            with bind_asker(lambda question, choices: "Confirm"):
                result = invoke_plugin_command(continuity_handler, "add commitment Synthetic private commitment text", source=source,
                    session_id=store.lookup_by_session_key(key).session_id, session_key=key, platform="telegram")
            self.assertTrue(result.startswith("add:"), result)
            hook = _load_hook_dir(home / "hooks/soma-assistant")
            self.assertEqual(hook[1], ["gateway:startup"])
            async def scenario():
                runner._gateway_loop = asyncio.get_running_loop()
                # Native busy dispatch must not interrupt a task for a follow-up control.
                from gateway.run import GatewayRunner
                pause_source = SessionSource(platform=Platform.TELEGRAM, chat_id="1001", user_id="1001", message_id="4")
                pause_raw = NS(from_user=NS(id=1001, is_bot=False), chat=NS(id=1001, type="private"), message_id=4)
                pause = MessageEvent(text="pause follow-ups", source=pause_source, message_id="4", raw_message=pause_raw)
                runner._route_stop_epoch = lambda key: 0
                runner._is_session_running = lambda key: True
                async def must_not_interrupt(*args):
                    self.fail("A follow-up control must not interrupt a live task")
                runner._route_plaintext_approval_while_busy = must_not_interrupt
                runner._hm_busy_preempt = must_not_interrupt
                async def consume(event, source, session_key):
                    result = await component.assistant.admitted(session_key=session_key, platform="telegram", source=source.to_dict(),
                                                                message_id=event.message_id, text=event.text)
                    return result is not None, result.get("reply") if result else None
                runner._hm_post_admission_consume = consume
                component.assistant.ingress(event=pause, gateway=runner)
                self.assertTrue(pause._fifo_only)
                consumed, reply = await GatewayRunner._hm_authority_admission(runner, pause, pause_source, key, False)
                self.assertTrue(consumed)
                self.assertIn("pause", reply)
                component.assistant.apply_control("telegram:1001", "resume", component.settings(component.assistant.ctx), int(component.time.time()))
                notices = []
                class Adapter:
                    async def send(self, chat_id, text, **kwargs):
                        self_outer.assertEqual(chat_id, "1001")
                        self_outer.assertTrue(kwargs["metadata"]["_interim_send"])
                        notices.append(text)
                        return NS(success=True, message_id="synthetic-follow-up")
                self_outer = self
                adapter = Adapter()
                runner._delivery_adapter_for = lambda source: adapter
                runner._restored_source = lambda entry: entry.origin
                runner._plugin_messaging_session_owned = lambda key, **kwargs: kwargs["plugin_home"] == home
                runner._thread_metadata_for_source = lambda source: {}
                await component.assistant.tick(runner)
                self.assertEqual(len(notices), 1)
                self.assertNotIn("Synthetic private commitment text", notices[0])
                await component.assistant.tick(runner)
                self.assertEqual(len(notices), 1)
                replacement = component.Assistant(component.assistant.ctx)
                await replacement.tick(runner)
                self.assertEqual(len(notices), 1)
                replacement.close()
                with patch("gateway.run._gateway_runner_ref", return_value=runner), \
                        patch("hermes_cli.plugins.get_plugin_manager", return_value=manager):
                    await hook[2]("gateway:startup", {})
                    first = component.assistant.task
                    self.assertIsNotNone(first)
                    await hook[2]("gateway:startup", {})
                    self.assertIs(component.assistant.task, first)
                    # Force reload/unload must cancel, not orphan or duplicate, the timer.
                    manager.unload("soma-assistant")
                    await asyncio.sleep(0)
                    self.assertTrue(first.cancelled())
                    await hook[2]("gateway:startup", {})
                    self.assertTrue(component.assistant.task.cancelled())
                    self.assertNotIn("soma-assistant", manager._plugin_commands)
                    callbacks = [hook[1] if isinstance(hook, tuple) else hook for hooks in manager._hooks.values() for hook in hooks]
                    self.assertTrue(all(callback.__module__ != component.__name__ for callback in callbacks))
            asyncio.run(scenario())
            # Explicit disablement, metadata and delivery receipts survive an upgrade.
            config = roundtrip_yaml().load((home / "config.yaml").read_text())
            config["plugins"]["disabled"] = ["soma-assistant"]
            with (home / "config.yaml").open("w") as stream:
                roundtrip_yaml().dump(config, stream)
            metadata = (home / "soma-assistant/metadata.sqlite").read_bytes()
            (directory / "__init__.py").write_text("# synthetic earlier installation\n")
            installer.install(source_dir, home, roundtrip_yaml())
            self.assertEqual((directory / "__init__.py").read_bytes(), (source_dir / "__init__.py").read_bytes())
            self.assertEqual((home / "soma-assistant/metadata.sqlite").read_bytes(), metadata)
            self.assertIn("soma-assistant", roundtrip_yaml().load((home / "config.yaml").read_text())["plugins"]["disabled"])
        finally:
            try:
                manager.unload()
            finally:
                store.close_all_db_handles()
                if "recovered" in locals():
                    recovered.close_all_db_handles()
                db.close()
                from hermes_state_registry import close_all_under
                close_all_under(home)


if __name__ == "__main__":
    unittest.main()
