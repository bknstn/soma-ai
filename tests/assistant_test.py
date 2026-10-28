"""Synthetic subscriptions, native-like lifecycle and fake transport; never user data."""

import asyncio
from contextlib import contextmanager
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
              inherit_channel_pin=False, edit_revision="", metadata={}, media_urls=[],
              message_type=NS(value="command" if text.startswith("/") else "text"))


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

    def fresh(self, number, text, *, voice=False, user="1001"):
        evt = event(str(number), text, user)
        if voice:
            evt.message_type.value = "voice"
            evt.raw_message.voice = NS(file_id="synthetic-voice")
            evt.media_urls = ["/synthetic/voice.ogg"]
        self.service.ingress(event=evt, gateway=self.runner)
        result = asyncio.run(self.service.admitted(session_key="route-" + user, platform="telegram",
            source=evt.source.to_dict(), message_id=evt.message_id, text=evt.text))
        self.assertIsNone(result)  # All wording continues to the conversation model.
        return evt

    @contextmanager
    def bound(self, number, user="1001", **changes):
        transcript = changes.pop("transcript", "Synthetic spoken request")
        values = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "dm",
                  "HERMES_SESSION_USER_ID": user, "HERMES_SESSION_CHAT_ID": user,
                  "HERMES_SESSION_MESSAGE_ID": str(number), "HERMES_SESSION_ID": "synthetic-session"}
        values.update(changes)
        session = ModuleType("gateway.session_context")
        session.bound_session_key = lambda: values.get("key", "route-" + user)
        session.get_session_env = lambda key, default="": values.get(key, default)
        delegation = ModuleType("agent.delegation_context")
        delegation.is_delegated_child_context = lambda: values.get("delegated", False)
        plugins = ModuleType("hermes_cli.plugins")
        plugins.PluginContext = lambda *_args: NS(get_config=lambda key, default: True)
        with patch.dict(sys.modules, {"gateway.session_context": session, "agent.delegation_context": delegation,
                                     "hermes_cli.plugins": plugins}):
            self.service.conversation.context(user_message=transcript)
            yield

    def say(self, action, surface="assistant", **kwargs):
        return json.loads(self.service.conversation.call(surface, {"action": action, **kwargs}))

    def test_conversation_enable_uses_new_turn_confirmation_without_phrase_matching(self):
        self.fresh(1, "I'd like you to keep an eye on the things we agreed to do.")
        with self.bound(1):
            self.assertIn("without requiring", self.service.conversation.context()["context"])
            proposal = self.say("enable")
            self.assertEqual(proposal["status"], "confirmation_required")
            self.assertEqual(self.say("enable"), proposal)
            self.assertEqual(self.say("confirm")["status"], "awaiting_user")
        self.assertFalse(self.service.state.subscribers())
        # An unrelated reply never triggers a parser or changes the subscription.
        self.fresh(2, "What did we decide about tomorrow?")
        self.assertFalse(self.service.state.subscribers())
        self.fresh(3, "That sounds useful, let's do it.", voice=True)
        with self.bound(3):
            self.assertEqual(self.say("confirm")["status"], "applied")
            self.assertEqual(self.say("status")["subscribed"], True)
        self.assertEqual(self.service.state.subscribers(), [self.owner])
        raw = json.dumps(self.service.state.get(self.owner))
        self.assertNotIn("let's do it", raw)
        self.assertNotIn("keep an eye", raw)

    def test_conversational_controls_and_frequency_are_scoped_idempotent_and_bounded(self):
        requests = [("Give me some peace for the next couple of hours", "snooze", {"minutes": 120}),
                    ("I'll come back to reminders later", "pause", {}),
                    ("I'm ready for your updates again", "resume", {}),
                    ("Only tell me about things I promised to do", "focus", {"topic": "commitments"}),
                    ("One update a day is plenty", "frequency", {"per_day": 1, "minutes": 120}),
                    ("I don't want suggestions about improving the assistant", "mute", {"source": "operational"})]
        for number, (text, action, arguments) in enumerate(requests, 1):
            self.fresh(number, text, voice=number % 2 == 0)
            with self.bound(number):
                result = self.say(action, **arguments)
                self.assertEqual(result["status"], "applied")
                self.assertEqual(self.say(action, **arguments), result)
        config = component.settings(self.ctx)
        gate = self.service.gate(self.owner, config)
        self.assertEqual(gate.settings["daily_limit"], 1)
        self.assertEqual(gate.settings["minimum_interval_seconds"], 7200)
        self.assertEqual(gate.status()["focus"], ["commitments"])
        self.assertIn("operational", gate.status()["muted_sources"])
        self.assertEqual(component.Assistant(self.ctx).gate(self.owner, config).settings["daily_limit"], 1)
        self.fresh(7, "Different preferences", user="1002")
        with self.bound(7, user="1002"):
            self.assertEqual(self.say("status")["daily_limit"], 2)
        self.fresh(8, "Unclear settings")
        with self.bound(8):
            for arguments in ({"action": "frequency", "minutes": True}, {"action": "frequency"},
                              {"action": "snooze", "minutes": 0}, {"action": "enable", "confirmed": True},
                              {"action": "status", "user_id": "1002"}):
                self.assertEqual(json.loads(self.service.conversation.call("assistant", arguments))["status"], "unavailable")
        self.fresh(9, "Pause updates and keep the focus on tasks", voice=True)
        with self.bound(9):
            self.assertEqual(self.say("pause")["status"], "applied")
            self.assertEqual(self.say("focus", topic="commitments")["status"], "applied")

    def test_conversation_refuses_cron_subagents_foreign_expired_and_revoked_turns(self):
        self.fresh(1, "Pause my reminders")
        for changes in ({"key": ""}, {"key": "other-route"}, {"delegated": True}, {"HERMES_CRON_SESSION": "1"},
                        {"HERMES_SESSION_PLATFORM": "cli"}, {"HERMES_SESSION_ID": "other-session"},
                        {"HERMES_SESSION_CHAT_ID": "1002"}, {"HERMES_SESSION_MESSAGE_ID": "2"}):
            with self.bound(1, **changes):
                self.assertIsNone(self.service.conversation.context())
                self.assertEqual(self.say("pause")["status"], "unavailable")
        self.runner._is_user_authorized_for_source = lambda source: False
        with self.bound(1):
            self.assertEqual(self.say("pause")["status"], "unavailable")
        self.runner._is_user_authorized_for_source = lambda source: True
        with patch.object(component.time, "monotonic", return_value=component.time.monotonic() + 601):
            with self.bound(1):
                self.assertEqual(self.say("pause")["status"], "unavailable")
        self.fresh(2, "A new request")
        with self.bound(1):
            self.assertEqual(self.say("pause")["status"], "unavailable")

    def test_conversation_proposals_cancel_expire_restart_and_configuration_changes(self):
        self.fresh(1, "Let me know when something needs my attention")
        with self.bound(1):
            self.assertEqual(self.say("enable")["status"], "confirmation_required")
        self.fresh(2, "Actually, let's leave that off")
        with self.bound(2):
            self.assertEqual(self.say("cancel")["status"], "cancelled")
        self.fresh(3, "Yes")
        with self.bound(3):
            self.assertEqual(self.say("confirm")["status"], "no_pending_proposal")
        self.fresh(4, "Keep me posted")
        with self.bound(4):
            self.say("enable")
        self.ctx.config["sources"] = ["continuity"]
        self.fresh(5, "Go ahead")
        with self.bound(5):
            self.assertEqual(self.say("confirm")["status"], "proposal_changed")
        self.fresh(6, "Keep me posted")
        with self.bound(6):
            self.say("enable")
        with patch.object(component.time, "monotonic", return_value=component.time.monotonic() + 601):
            self.service.conversation.prune()
        self.fresh(7, "Sounds good")
        with self.bound(7):
            self.assertEqual(self.say("confirm")["status"], "no_pending_proposal")
        self.fresh(8, "Keep me posted")
        with self.bound(8):
            self.say("enable")
        self.service.close()
        self.assertFalse(self.service.conversation.pending)
        self.assertFalse(self.service.conversation.receipts)
        self.service = component.Assistant(self.ctx)
        self.fresh(9, "Agreed")
        with self.bound(9):
            self.assertEqual(self.say("confirm")["status"], "no_pending_proposal")
        self.assertFalse(self.service.state.subscribers())

    def test_conversational_continuity_requires_exact_proposal_and_later_human_confirmation(self):
        spec = importlib.util.spec_from_file_location("synthetic_conversation_ledger", ROOT / "runtimes/hermes/plugins/soma-continuity/__init__.py")
        ledger_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ledger_module)
        loaded = NS(enabled=True, error=None, module=ledger_module, manifest=NS())
        self.ctx._manager._plugins["soma-continuity"] = loaded
        self.fresh(1, "Please remember that I prefer short answers", voice=True)
        with self.bound(1):
            self.assertEqual(self.say("add", "continuity", kind="preference", text="Prefer short answers")["status"], "confirmation_required")
            self.assertFalse(self.say("list", "continuity")["entries"])
        self.fresh(2, "Exactly, remember that")
        with self.bound(2):
            result = self.say("confirm", "continuity")
            self.assertEqual(result["status"], "applied")
            self.assertEqual(self.say("confirm", "continuity"), result)
            rows = self.say("list", "continuity")["entries"]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["text"], "Prefer short answers")
        entry_id = rows[0]["id"]
        self.fresh(3, "I meant detailed answers for complex topics")
        with self.bound(3):
            self.assertEqual(self.say("correct", "continuity", entry_id=entry_id, text="Detailed answers for complex topics")["status"], "confirmation_required")
        self.fresh(4, "Leave the original preference alone")
        with self.bound(4):
            self.assertEqual(self.say("discard", "continuity")["status"], "cancelled")
            self.assertEqual(self.say("list", "continuity")["entries"][0]["text"], "Prefer short answers")
        self.fresh(5, "Forget that preference")
        with self.bound(5):
            self.assertEqual(self.say("forget", "continuity", entry_id=entry_id)["status"], "confirmation_required")
        self.fresh(6, "Yes, remove it", voice=True)
        with self.bound(6):
            self.assertEqual(self.say("confirm", "continuity")["status"], "applied")
            self.assertFalse(self.say("list", "continuity")["entries"])
        self.assertNotIn("Prefer short answers", json.dumps(self.service.state.get(self.owner)))

    def test_forwarded_voice_cannot_authorize_conversation_tools(self):
        evt = event("1", "[Voice]")
        evt.message_type.value = "voice"
        evt.raw_message.voice = NS(file_id="synthetic")
        evt.media_urls = ["/synthetic/voice.ogg"]
        for attribute in ("forward_origin", "via_bot", "edit_date"):
            setattr(evt.raw_message, attribute, "synthetic")
            self.assertIsNone(component.direct(evt, self.runner))
            delattr(evt.raw_message, attribute)
        self.assertEqual(component.direct(evt, self.runner), self.owner)
        evt.media_urls.append("/synthetic/extra.ogg")
        self.assertIsNone(component.direct(evt, self.runner))

    def test_unusable_voice_does_not_authorize_tools(self):
        for number, transcript in enumerate(("", "[voice message could not be transcribed automatically]",
                "[The user sent a voice message: /synthetic/audio.ogg]",
                "[The user sent a voice message but it came through empty or inaudible]"), 1):
            self.fresh(number, "[Voice]", voice=True)
            with self.bound(number, transcript=transcript):
                self.assertEqual(self.say("pause")["status"], "unavailable")

    def test_followups_use_conversation_language_and_hide_internal_commands(self):
        self.subscribe(feedback=1)
        self.fresh(1, "Напоминай мне не чаще раза в день")
        with self.bound(1):
            self.assertEqual(self.say("frequency", per_day=1, language="ru")["status"], "applied")
        config = component.settings(self.ctx)
        with patch.object(self.service, "continuity", return_value=[("synthetic-id", 1)]):
            self.service.prepare_owner(self.owner, config, self.now + 8 * 86400)
        for notice in self.service.state.get(self.owner)["pending"].values():
            message = notice["candidate"]["message"]
            self.assertRegex(message, "[А-Яа-я]")
            self.assertNotIn("/soma", message)
            self.assertNotIn("configuration", message)

    def test_pending_continuity_rejects_changed_revision_and_preserves_other_owner(self):
        spec = importlib.util.spec_from_file_location("synthetic_revision_ledger", ROOT / "runtimes/hermes/plugins/soma-continuity/__init__.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.ctx._manager._plugins["soma-continuity"] = NS(enabled=True, error=None, module=module, manifest=NS())
        routing = event().source.to_dict()
        ledger = module.Ledger(self.home, module.principal(routing))
        ledger.apply("add", None, "Review synthetic plan", "commitment", "synthetic-add", {"message_id": "1"})
        row = ledger.list()[0]
        self.fresh(2, "I finished reviewing that plan")
        with self.bound(2):
            self.assertEqual(self.say("complete", "continuity", entry_id=row["id"])["status"], "confirmation_required")
        ledger.apply("correct", row["id"], "Review updated synthetic plan", None, "synthetic-correct", {"message_id": "3"}, 1)
        self.fresh(4, "Yes, mark it done")
        with self.bound(4):
            self.assertEqual(self.say("confirm", "continuity")["status"], "unavailable")
        self.assertEqual(ledger.list()[0]["status"], "active")
        self.fresh(5, "Show my tasks", user="1002")
        with self.bound(5, user="1002"):
            self.assertFalse(self.say("list", "continuity")["entries"])
        self.assertEqual(ledger.list()[0]["text"], "Review updated synthetic plan")

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
            for text in ("Synthetic request", "/soma_assistant enable"):
                evt = event(text=text)
                modify(evt)
                self.service.ingress(event=evt, gateway=self.runner)
                self.assertFalse(self.service.receipts)
        for kind in ("photo", "voice", "document", "location"):
            evt = event(text="/soma_assistant enable")
            evt.message_type.value = kind
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
        self.assertIn("Would one update a day work better?", candidate["message"])
        self.assertLessEqual(len(candidate["message"]), 500)
        self.assertEqual(self.service.gate(self.owner, config).settings["daily_limit"], 2)
        self.assertNotIn("/soma", candidate["message"])
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
                self.assertIn("Would one update a day work better?", sent[0])
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
