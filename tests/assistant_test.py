"""Synthetic subscriptions, native-like lifecycle and fake transport; never user data."""

import asyncio
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "runtimes/hermes/plugins/soma-assistant"
spec = importlib.util.spec_from_file_location("soma_assistant_test", SOURCE / "__init__.py", submodule_search_locations=[str(SOURCE)])
component = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = component
spec.loader.exec_module(component)


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp())


class Context:
    plugin_id = "soma-assistant"
    def __init__(self, home):
        self._manager = NS(home_path=home, _plugins={})
        self.config = {"enabled": True, "sources": ["continuity", "operational"], "greetings": ["доброе утро", "good morning"],
                       "timezone": "Europe/Warsaw", "minimum_interval_seconds": 60}
        self.answer = "confirm"
        self.tasks = []
    def get_config(self, key, default):
        return self.config.get(key, default)
    def ask_choice(self, *_args):
        return self.answer
    def spawn_task(self, coro, **_kwargs):
        task = asyncio.create_task(coro)
        self.tasks.append(task)
        return task


def event(message="1", text="Synthetic request", user="1001"):
    source = NS(platform=NS(value="telegram"), chat_type="dm", chat_id=user, user_id=user, is_bot=False,
                thread_id=None, delivered_via_upstream_relay=False)
    source.to_dict = lambda: {"platform": "telegram", "chat_type": "dm", "chat_id": user, "user_id": user, "message_id": message}
    raw = NS(from_user=NS(id=int(user), is_bot=False), chat=NS(id=int(user), type="private"), message_id=int(message))
    return NS(source=source, raw_message=raw, message_id=message, text=text, internal=False, allow_gateway_control=True,
              inherit_channel_pin=False, edit_revision="", metadata={}, media_urls=[], message_type=NS(value="text"))


class AssistantTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soma-assistant-test-")
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "hermes-home"
        self.home.mkdir()
        self.ctx = Context(self.home)
        self.service = component.Assistant(self.ctx)
        self.now = stamp("2026-10-27T12:00:00+00:00")
        self.owner = "telegram:1001"
        self.runner = NS(_running=True, _draining=False, config=NS(multiplex_profiles=False),
                         _is_user_authorized_for_source=lambda source: True,
                         _session_key_for_source=lambda source: "route-" + str(source.user_id),
                         session_store=NS(lookup_by_session_key=lambda key: NS(session_id="synthetic-session")))
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.service.close()
        self.temp.cleanup()
        self.assertFalse(self.root.exists())

    def subscribe(self, **changes):
        self.service.state.update(self.owner, lambda value: value.update(subscribed=True, review_at=self.now,
            route={"platform": "telegram", "chat_type": "dm", "chat_id": "1001", "user_id": "1001"}, key="route-1001", **changes))

    def command(self, action, number="1"):
        evt = event(number, "/soma-assistant " + action)
        self.service.ingress(event=evt, gateway=self.runner)
        return self.service.command(action, source=evt.source, session_key="route-1001", platform="telegram", session_id="synthetic-session")

    def test_configuration_defaults_strict_and_schema_consistent(self):
        schema = json.loads((ROOT / "runtimes/hermes/assistant-settings.schema.json").read_bytes())
        self.assertEqual({key: value["default"] for key, value in schema["properties"].items()}, component.DEFAULTS)
        for patch_data in ({"enabled": "true"}, {"sources": "continuity"}, {"sources": ["unknown"]},
                           {"sources": ["continuity", "continuity"]}, {"timezone": "Missing/Timezone"},
                           {"daily_time": "25:00"}, {"review_interval_days": True}, {"greetings": ["a\nb"]},
                           {"continuations": ["x" * 81]}, {"daily_limit": False}):
            config = self.ctx.config
            self.ctx.config = {**config, **patch_data}
            self.assertIsNone(component.settings(self.ctx), patch_data)
            self.ctx.config = config
        self.ctx.config = {}
        self.assertIsNone(component.settings(self.ctx))

    def test_subscription_requires_fresh_direct_command_and_confirmation(self):
        self.ctx.answer = None
        self.assertIn("No subscription", self.command("enable"))
        self.assertNotIn(self.owner, self.service.state.subscribers())
        self.ctx.answer = "confirm"
        self.assertIn("enabled", self.command("enable", "2"))
        self.assertEqual(self.service.state.subscribers(), [self.owner])
        self.assertIn("fresh", self.service.command("enable", source=event("2").source, session_key="route-1001", platform="telegram"))
        self.assertIn("disabled", self.command("disable", "3"))
        self.assertEqual(self.service.state.subscribers(), [])

    def test_untrusted_forwarded_internal_missing_replayed_inputs_refused(self):
        for modify in (lambda e: setattr(e.raw_message, "forward_origin", "synthetic"),
                       lambda e: setattr(e, "internal", True), lambda e: setattr(e, "raw_message", None),
                       lambda e: setattr(e.source, "is_bot", True), lambda e: setattr(e.source, "chat_type", "group"),
                       lambda e: setattr(e, "metadata", {"synthetic": True}), lambda e: setattr(e, "edit_revision", "1"),
                       lambda e: setattr(e, "_hermes_startup_restore_replay", True)):
            evt = event()
            modify(evt)
            self.service.ingress(event=evt, gateway=self.runner)
            self.assertFalse(self.service.receipts)
        self.runner._is_user_authorized_for_source = lambda source: False
        self.assertIsNone(component.direct(event(), self.runner))

    def test_natural_controls_only_exact_explicit_intents(self):
        for text, expected in (("поставь уведомления на паузу", "pause"), ("возобнови уведомления", "resume"),
                               ("отложи уведомления на 2 часа", "snooze 120"), ("snooze follow-ups for 30 minutes", "snooze 30"),
                               ("сфокусируй уведомления на задачах", "focus commitments"),
                               ("уведомления о задачах не полезны", "mute continuity"),
                               ("уведомления слишком частые", "feedback")):
            self.assertEqual(component.natural(text), expected)
        for text in ('Он сказал "поставь уведомления на паузу"', "не ставь уведомления на паузу", "pause", "да", "", "continue"):
            self.assertIsNone(component.natural(text))
        config = component.settings(self.ctx)
        self.service.apply_control(self.owner, "pause", config, self.now)
        self.assertTrue(self.service.gate(self.owner, config).status()["paused"])
        self.service.apply_control(self.owner, "resume", config, self.now)
        self.service.apply_control(self.owner, "snooze 120", config, self.now)
        self.assertEqual(self.service.gate(self.owner, config).status()["snooze"], self.now + 7200)
        self.service.apply_control(self.owner, "feedback", config, self.now)
        self.assertEqual(self.service.state.get(self.owner)["feedback"], 1)

    def test_greetings_and_controls_use_native_queue_marker_without_rewriting_input(self):
        self.runner._route_stop_epoch = lambda key: 7
        for number, text in enumerate(("good morning", "поставь уведомления на паузу"), 1):
            evt = event(str(number), text)
            self.service.ingress(event=evt, gateway=self.runner)
            self.assertTrue(evt._fifo_only)
            self.assertEqual(evt._stop_epoch, 7)
            self.assertEqual(evt.text, text)
        evt = event("3", "Continue the synthetic task")
        self.service.ingress(event=evt, gateway=self.runner)
        self.assertFalse(hasattr(evt, "_fifo_only"))

    def test_greeting_continuation_manual_reset_replay_missing_metadata_and_clock(self):
        boundaries = sys.modules[component.__name__ + ".boundaries"]
        self.assertTrue(boundaries.greeting("  Доброе утро! ", ["доброе утро"], ["продолжим"]))
        self.assertFalse(boundaries.greeting("доброе утро продолжим", ["доброе утро"], ["продолжим"]))
        self.assertFalse(boundaries.greeting("продолжим задачу", ["продолжим задачу"], ["продолжим"]))
        value = {}
        args = ("2026-10-26", {}, "synthetic-key")
        self.assertEqual(component.consume(value, 1, "s1", *args), {})
        self.assertIsNone(component.consume(value, 1, "s1", *args))
        component.consume(value, 2, "s1", "2026-10-25", {}, "synthetic-key")
        self.assertEqual(value["day"], "2026-10-26")
        component.consume(value, 3, "manual-reset", "2026-10-27", {}, "synthetic-key")
        self.assertEqual(value["session"], "manual-reset")

    def test_new_day_resets_only_once_and_continues_original_message(self):
        async def scenario():
            self.runner._gateway_loop = asyncio.get_running_loop()
            # Avoid launching a real minute timer in this hook contract.
            with patch.object(self.service, "start"), patch.object(component.time, "time", return_value=self.now):
                self.service.state.update(self.owner, lambda value: value.update(message=1, day="2026-10-26", session="synthetic-session"))
                evt = event("2", "доброе утро")
                self.service.ingress(event=evt, gateway=self.runner)
                calls = []
                async def rotate(runner, key, sid):
                    calls.append((key, sid))
                    return NS(session_id="new-session")
                with patch.object(component, "rotate", rotate):
                    reply = await self.service.admitted(session_key="route-1001", platform="telegram", source=evt.source.to_dict(), message_id="2", text=evt.text)
                    self.assertIsNone(reply)
                    self.assertEqual(evt.text, "доброе утро")
                    self.service.ingress(event=evt, gateway=self.runner)
                    await self.service.admitted(session_key="route-1001", platform="telegram", source=evt.source.to_dict(), message_id="2", text=evt.text)
                self.assertEqual(calls, [("route-1001", "synthetic-session")])
                self.assertEqual(self.service.state.get(self.owner)["session"], "new-session")
        asyncio.run(scenario())

    def test_daily_preparation_change_only_no_health_text_and_bounded_pending(self):
        self.subscribe()
        config = component.settings(self.ctx)
        with patch.object(self.service, "continuity", return_value=[("synthetic-id", 1)]):
            self.service.prepare_owner(self.owner, config, self.now)
            first = self.service.state.get(self.owner)
            self.assertEqual(first["pending"]["continuity"]["candidate"]["revision"], 1)
            self.service.prepare_owner(self.owner, config, self.now + 100)
            self.assertEqual(self.service.state.get(self.owner), first)
            self.service.prepare_owner(self.owner, config, self.now + 86400)
            self.assertEqual(self.service.state.get(self.owner)["revisions"]["continuity"], 1)
        with patch.object(self.service, "continuity", return_value=[("synthetic-id", 2)]):
            self.service.prepare_owner(self.owner, config, self.now + 2 * 86400)
            pending = self.service.state.get(self.owner)["pending"]
            self.assertEqual(pending["continuity"]["candidate"]["revision"], 2)
            self.assertNotIn("synthetic-id", json.dumps(pending))
        with patch.object(self.service, "continuity", return_value=[]):
            self.service.prepare_owner(self.owner, config, self.now + 3 * 86400)
            self.assertFalse(self.service.state.get(self.owner)["pending"])

    def test_daily_dst_folds_once_and_missing_time_runs_once_after_jump(self):
        self.ctx.config["daily_time"] = "02:30"
        config = component.settings(self.ctx)
        self.subscribe()
        with patch.object(self.service, "continuity", return_value=[("synthetic-id", 1)]):
            for instant in ("2026-10-25T00:30:00+00:00", "2026-10-25T01:30:00+00:00"):
                self.service.prepare_owner(self.owner, config, stamp(instant))
            self.assertEqual(self.service.state.get(self.owner)["revisions"]["continuity"], 1)
            self.service.state.update(self.owner, lambda value: value.pop("prepared_day", None))
            self.service.prepare_owner(self.owner, config, stamp("2027-03-28T01:00:00+00:00"))
            self.assertEqual(self.service.state.get(self.owner)["prepared_day"], "2027-03-28")

    def test_improvement_reviews_are_bounded_proposals_only(self):
        self.subscribe(feedback=1)
        config = component.settings(self.ctx)
        self.service.prepare_owner(self.owner, config, self.now + 7 * 86400)
        first = self.service.state.get(self.owner)
        candidate = first["pending"]["operational"]["candidate"]
        self.assertIn("explicitly approve", candidate["message"])
        self.assertLessEqual(len(candidate["message"]), 500)
        self.assertIn("No code, dependencies, services or permissions were changed", candidate["message"])
        self.service.prepare_owner(self.owner, config, self.now + 14 * 86400)
        self.assertEqual(self.service.state.get(self.owner)["revisions"]["operational"], 1)

    def test_operational_collection_requires_subscription_and_enabled_source(self):
        self.service.error(self.owner)
        self.assertEqual(self.service.state.get(self.owner), {})
        self.subscribe()
        self.service.error(self.owner)
        self.assertEqual(self.service.state.get(self.owner)["errors"], 1)
        self.ctx.config["sources"] = ["continuity"]
        self.service.error(self.owner)
        self.assertEqual(self.service.state.get(self.owner)["errors"], 1)
        self.assertIn("disabled", self.service.apply_control(self.owner, "feedback", component.settings(self.ctx), self.now))
        self.assertNotIn("feedback", self.service.state.get(self.owner))

    def test_metadata_isolation_capacity_permissions_and_versions(self):
        self.subscribe()
        self.assertEqual(self.service.state.get("telegram:1002"), {})
        for number in range(1002, 1065):
            self.service.state.update("telegram:" + str(number), lambda value: value.update(synthetic=True))
        with self.assertRaises(ValueError):
            self.service.state.update("telegram:1065", lambda value: value.update(synthetic=True))
        before = self.service.state.get(self.owner)
        with self.assertRaises(ValueError):
            self.service.state.update(self.owner, lambda value: value.update(synthetic="x" * 16385))
        self.assertEqual(self.service.state.get(self.owner), before)
        file = self.home / "soma-assistant/metadata.sqlite"
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        file.chmod(0o644)
        with self.assertRaises(ValueError):
            self.service.state.get(self.owner)
        file.chmod(0o600)
        import sqlite3
        db = sqlite3.connect(file)
        try:
            db.execute("PRAGMA user_version=2")
        finally:
            db.close()
        with self.assertRaises(ValueError):
            self.service.state.get(self.owner)

    def test_receipts_bounded_expire_and_unload_removes_work(self):
        for number in range(1, 260):
            self.service.ingress(event=event(str(number)), gateway=self.runner)
        self.assertEqual(len(self.service.receipts), 256)
        with patch.object(component.time, "monotonic", return_value=component.time.monotonic() + 601):
            self.assertIsNone(self.service.take("route-1001", "259", self.owner))
        self.service.close()
        self.assertFalse(self.service.receipts)

    def test_delivery_gate_native_route_restart_silence_and_stale_snapshot(self):
        async def scenario():
            self.subscribe()
            sent = []
            messages = ModuleType("gateway.plugin_messages")
            messages.resolve = lambda *args, **kwargs: (NS(platform="telegram", chat_id="1001"), None)
            async def post(target, text, **kwargs):
                sent.append(text)
                return {"ok": True}
            messages.post = post
            session = ModuleType("gateway.session")
            session.SessionSource = NS(from_dict=lambda value: NS(**value))
            gateway = ModuleType("gateway")
            gateway.plugin_messages = messages
            modules = {"gateway": gateway, "gateway.session": session, "gateway.plugin_messages": messages}
            with patch.dict(sys.modules, modules), patch.object(self.service, "continuity", return_value=[("synthetic-id", 1)]):
                await self.service.tick(self.runner, self.now)
                self.assertEqual(len(sent), 1)
                await self.service.tick(self.runner, self.now + 60)
                self.assertEqual(len(sent), 1)
                other = component.Assistant(self.ctx)
                with patch.object(other, "continuity", return_value=[("synthetic-id", 1)]):
                    await other.tick(self.runner, self.now + 120)
                self.assertEqual(len(sent), 1)
                with patch.object(self.service, "continuity", return_value=[("synthetic-id", 2)]):
                    self.service.prepare_owner(self.owner, component.settings(self.ctx), self.now + 86400, force="check")
                self.assertIn("continuity", self.service.state.get(self.owner)["pending"])
                # A changed/finished commitment must invalidate a privately queued result.
                with patch.object(self.service, "continuity", return_value=[]):
                    await self.service.tick(self.runner, self.now + 86400)
                self.assertEqual(len(sent), 1)
        asyncio.run(scenario())

    def test_preparation_stays_private_while_paused_and_disable_during_resolve_stops_send(self):
        async def scenario():
            self.subscribe()
            config = component.settings(self.ctx)
            gate = self.service.gate(self.owner, config)
            gate.control({"action": "pause"}, now=self.now)
            sent = []
            messages = ModuleType("gateway.plugin_messages")
            messages.resolve = lambda *args, **kwargs: (NS(platform="telegram", chat_id="1001"), None)
            async def post(target, text, **kwargs):
                sent.append(text)
                return {"ok": False}
            messages.post = post
            session = ModuleType("gateway.session")
            session.SessionSource = NS(from_dict=lambda value: NS(**value))
            gateway = ModuleType("gateway")
            gateway.plugin_messages = messages
            modules = {"gateway": gateway, "gateway.session": session, "gateway.plugin_messages": messages}
            with patch.dict(sys.modules, modules), patch.object(self.service, "continuity", return_value=[("synthetic-id", 1)]):
                await self.service.tick(self.runner, self.now)
                self.assertFalse(sent)
                self.assertIn("continuity", self.service.state.get(self.owner)["pending"])
                gate.control({"action": "resume"}, now=self.now)
                await self.service.tick(self.runner, self.now + 60)
                await self.service.tick(self.runner, self.now + 120)
                self.assertEqual(len(sent), 1)  # Ambiguous delivery never retries.
                self.assertEqual(self.service.state.get(self.owner)["errors"], 1)
                with patch.object(self.service, "continuity", return_value=[("synthetic-id", 2)]):
                    self.service.prepare_owner(self.owner, config, self.now + 180, force="check")
                    def disable(*args, **kwargs):
                        self.ctx.config["enabled"] = False
                        return NS(platform="telegram", chat_id="1001"), None
                    messages.resolve = disable
                    await self.service.tick(self.runner, self.now + 180)
                self.assertEqual(len(sent), 1)
                self.assertEqual(gate.status()["attempts"], 1)
        asyncio.run(scenario())

    def test_operational_delivery_and_evidence_change_during_resolution(self):
        async def scenario():
            self.subscribe(feedback=1)
            config = component.settings(self.ctx)
            self.service.prepare_owner(self.owner, config, self.now, force="review")
            sent = []
            messages = ModuleType("gateway.plugin_messages")
            messages.resolve = lambda *args, **kwargs: (NS(platform="telegram", chat_id="1001"), None)
            async def post(target, text, **kwargs):
                sent.append(text)
                return {"ok": True}
            messages.post = post
            session = ModuleType("gateway.session")
            session.SessionSource = NS(from_dict=lambda value: NS(**value))
            gateway = ModuleType("gateway")
            gateway.plugin_messages = messages
            modules = {"gateway": gateway, "gateway.session": session, "gateway.plugin_messages": messages}
            with patch.dict(sys.modules, modules), patch.object(self.service, "continuity", return_value=[]):
                await self.service.tick(self.runner, self.now)
                self.assertEqual(len(sent), 1)
                self.assertIn("explicitly approve", sent[0])
                self.service.state.update(self.owner, lambda value: value.update(feedback=2))
                self.service.prepare_owner(self.owner, config, self.now + 60, force="review")
                def change(*args, **kwargs):
                    self.service.state.update(self.owner, lambda value: value.update(feedback=3))
                    return NS(platform="telegram", chat_id="1001"), None
                messages.resolve = change
                await self.service.tick(self.runner, self.now + 60)
                self.assertEqual(len(sent), 1)
                self.assertNotIn("operational", self.service.state.get(self.owner)["pending"])
        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
