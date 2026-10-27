"""Synthetic clocks, gateway state, transports and temporary installation; no live services."""

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "runtimes/hermes/plugins/soma-progress"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


feature = load("soma_progress_test", SOURCE / "__init__.py")
installer = load("soma_progress_installer_test", ROOT / "runtimes/hermes/install-continuity.py")


class Context:
    plugin_id = "soma-progress"
    _manager = NS(home_path=Path("/synthetic/runtime/hermes-home"))

    def __init__(self):
        self.config = {"enabled": True, "interval_seconds": 15}
        self.tasks = []

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def spawn_task(self, coro, **kwargs):
        task = asyncio.create_task(coro)
        self.tasks.append(task)
        return task


def fixture():
    source = NS(platform=NS(value="telegram"), user_id="1001", chat_id="1001", chat_type="dm",
                thread_id=None, is_bot=False, delivered_via_upstream_relay=False)
    raw = NS(from_user=NS(id=1001, is_bot=False), chat=NS(id=1001, type="private"), message_id=1)
    event = NS(source=source, message_id="1", internal=False, allow_gateway_control=True, inherit_channel_pin=False,
               edit_revision=None, message_type=NS(value="text"), media_urls=[], metadata={}, raw_message=raw)
    agent = NS(session_id="synthetic-session", is_interrupted=lambda: False)
    state = NS(turn=NS(agent=agent, event=event), persistent=NS(run_generation=7))
    runner = NS(_running=True, _peek_session_state=lambda key: state if key == "synthetic-route" else None)
    notice = feature.Notice("synthetic-route", "synthetic-session", "synthetic-turn", 7, agent, event,
                            100.0, 115.0, 15, feature.DEFAULT_MESSAGE)
    return runner, state, notice


class PolicyTest(unittest.TestCase):
    def test_strict_settings(self):
        ctx = Context()
        self.assertEqual(feature.settings(ctx), (15, feature.DEFAULT_MESSAGE))
        for key, values in {"enabled": [False, 1, "true"], "interval_seconds": [True, "60", 14, 3601, 15.0],
                            "message": ["", " ", "x\ny", "x" * 241, None]}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    other = Context()
                    other.config[key] = value
                    self.assertIsNone(feature.settings(other))
        ctx.config = {}
        self.assertIsNone(feature.settings(ctx))

    def test_deadlines_nested_waits_and_stale_responses(self):
        _, _, n = fixture()
        self.assertFalse(n.ready(114.9))
        self.assertTrue(n.ready(115))
        n.wait("a", False, 114)
        n.wait("b", False, 114)
        self.assertFalse(n.ready(200))
        n.wait("unrelated", True, 200)
        self.assertEqual(n.due, 115)
        n.wait("a", True, 200)
        self.assertFalse(n.ready(300))
        n.wait("b", True, 300)
        self.assertFalse(n.ready(314.9))
        self.assertTrue(n.ready(315))
        n.attempted = True
        self.assertFalse(n.ready(316))
        n.attempted = False
        self.assertFalse(n.ready(100 + feature.MAX_AGE))
        n.wait(None, False, 316)
        n.wait("unrelated", True, 317)
        self.assertFalse(n.ready(400))

    def test_fail_closed_native_identity_and_generation(self):
        runner, state, n = fixture()
        self.assertTrue(feature.live(runner, n))
        self.assertTrue(feature.direct_event(n.event, "1001"))
        self.assertFalse(feature.direct_event(n.event, "1002"))
        for obj, key, value in [(n.event, "internal", True), (n.event, "metadata", {"synthetic": True}),
                                (n.event, "edit_revision", "2"), (n.event, "raw_message", None),
                                (n.event.source, "chat_type", "group"), (n.event.source, "thread_id", "3"),
                                (n.event.raw_message, "forward_origin", object()),
                                (n.event.raw_message.from_user, "is_bot", True)]:
            with patch.object(obj, key, value, create=True):
                self.assertFalse(feature.direct_event(n.event, "1001"))
        for obj, key, value in [(runner, "_running", False), (state.turn, "agent", None),
                                (state.turn, "event", object()), (state.persistent, "run_generation", 8),
                                (n.agent, "session_id", "new-session"), (n.agent, "is_interrupted", lambda: True)]:
            with patch.object(obj, key, value):
                self.assertFalse(feature.live(runner, n))

    def test_lifecycle_and_wait_correlation(self):
        progress = feature.Progress(Context())
        _, _, n = fixture()
        progress.active[n.key] = n
        progress.wait(session_key=n.key, session_id=n.session, turn_id="old-turn", request_id="a")
        self.assertEqual(n.waiting, set())
        progress.wait(session_key="other-route", request_id="a")
        self.assertEqual(n.waiting, set())
        progress.wait(session_key=n.key, request_id="a")
        progress.wait(session_id=n.session, turn_id=n.turn, tool_call_id="tool", approval=True)
        self.assertEqual(len(n.waiting), 2)
        progress.wait(session_key=n.key, request_id="a", resolved=True)
        self.assertEqual(len(n.waiting), 1)
        progress.wait(session_id=n.session, turn_id=n.turn, tool_call_id="tool", approval=True, resolved=True)
        self.assertEqual(n.waiting, set())
        progress.finish(session_id=n.session, turn_id="old-turn")
        self.assertFalse(n.ended)
        progress.finish(session_id=n.session, turn_id=n.turn)
        self.assertTrue(n.ended)
        self.assertEqual(progress.active, {})
        progress.close()
        self.assertTrue(progress.closed)

    def test_bounded_authorized_ingress_receipts_without_message_content(self):
        progress = feature.Progress(Context())
        runner, _, n = fixture()
        runner._is_user_authorized_for_source = lambda source: False
        runner._session_key_for_source = lambda source: n.key
        progress.ingress(event=n.event, gateway=runner)
        self.assertEqual(progress.receipts, {})
        runner._is_user_authorized_for_source = lambda source: True
        with patch.object(feature, "time", NS(monotonic=lambda: 100)):
            for number in range(1, feature.MAX_INGRESS + 3):
                n.event.message_id = str(number)
                n.event.raw_message.message_id = number
                progress.ingress(event=n.event, gateway=runner)
        self.assertEqual(len(progress.receipts), feature.MAX_INGRESS)
        self.assertNotIn((n.key, "1", "1001"), progress.receipts)
        identity = (n.key, n.event.message_id, "1001")
        self.assertEqual(progress.receipts[identity], [100, False, False])
        progress.admitted(session_key=n.key, message_id=n.event.message_id, platform="telegram", source={"user_id": "1001"})
        self.assertEqual(progress.receipts[identity], [100, True, False])
        n.event.raw_message = None
        self.assertFalse(feature.direct_event(n.event, "1001"))
        self.assertTrue(feature.direct_event(n.event, "1001", require_raw=False))
        progress.prune_receipts(100 + feature.MAX_AGE)
        self.assertEqual(progress.receipts, {})


class MonitorTest(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, *, before=None, resolve=None, send_error=False, target_chat="1001", refusal=None):
        ctx = Context()
        progress = feature.Progress(ctx)
        runner, state, n = fixture()
        progress.active[n.key] = n
        clock = [100.0]
        sent = []
        ticks = []

        async def tick(_seconds):
            clock[0] += 15
            ticks.append(clock[0])
            self.assertLess(len(ticks), 8)
            if before:
                before(progress, state, n, len(ticks))

        def resolver(*args, **kwargs):
            if resolve:
                resolve(progress, state, n)
            return NS(platform="telegram", chat_id=target_chat), refusal

        async def post(target, text, **kwargs):
            sent.append((target.chat_id, text))
            return {"ok": not send_error}

        fake_messages = NS(resolve=resolver, post=post)
        async_api = NS(sleep=tick, to_thread=asyncio.to_thread)
        with patch.dict(sys.modules, {"gateway": NS(plugin_messages=fake_messages)}), \
                patch.object(feature, "asyncio", async_api), patch.object(feature, "time", NS(monotonic=lambda: clock[0])):
            await progress.monitor(runner, n)
        return progress, n, sent

    async def test_one_attempt_and_ambiguous_failure_never_retry(self):
        for error in (False, True):
            progress, n, sent = await self.exercise(send_error=error)
            self.assertEqual(sent, [("1001", feature.DEFAULT_MESSAGE)])
            self.assertTrue(n.attempted)
            self.assertIs(progress.active[n.key], n)
            progress.finish(session_id=n.session, turn_id=n.turn)
            self.assertEqual(progress.active, {})

    async def test_complete_cancel_disable_and_stale_resolution(self):
        changes = [lambda p, s, n: p.finish(session_id=n.session, turn_id=n.turn),
                   lambda p, s, n: setattr(s.persistent, "run_generation", 8),
                   lambda p, s, n: setattr(s.turn, "agent", None),
                   lambda p, s, n: p.ctx.config.update(enabled=False),
                   lambda p, s, n: p.close()]
        for change in changes:
            for seam in ("before", "resolve"):
                kwargs = {seam: (lambda p, s, n, tick: change(p, s, n)) if seam == "before" else change}
                progress, n, sent = await self.exercise(**kwargs)
                self.assertEqual(sent, [])
                self.assertFalse(n.attempted)
                self.assertEqual(progress.active, {})

    async def test_wait_defers_notice_after_input_is_resolved(self):
        def changes(progress, state, n, tick):
            if tick == 1:
                progress.wait(session_key=n.key, request_id="input")
            elif tick == 3:
                progress.wait(session_key=n.key, request_id="input", resolved=True)
        _, n, sent = await self.exercise(before=changes)
        self.assertTrue(n.attempted)
        self.assertEqual(len(sent), 1)

    async def test_cancelled_supervised_task_cleans_marker(self):
        progress = feature.Progress(Context())
        runner, _, n = fixture()
        progress.active[n.key] = n
        task = asyncio.create_task(progress.monitor(runner, n))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(progress.active, {})

    async def test_wrong_route_and_refused_profile_never_send(self):
        for options in ({"target_chat": "1002"}, {"refusal": {"error": "no_conversation"}}):
            _, n, sent = await self.exercise(**options)
            self.assertEqual(sent, [])
            self.assertTrue(n.attempted)


class JsonCodec:
    def load(self, raw):
        return json.loads(raw)

    def dump(self, value, stream):
        stream.write(json.dumps(value))


class InstallerTest(unittest.TestCase):
    def test_repeat_disabled_upgrade_preserve_settings_and_unsafe_target(self):
        with tempfile.TemporaryDirectory(prefix="soma-progress-test-") as temporary:
            home = Path(temporary).resolve()
            config = {"model": {"default": "synthetic-model"}, "plugins": {"disabled": ["soma-progress"],
                      "entries": {"soma-progress": {"settings": {"interval_seconds": 120}}}}}
            filename = home / "config.yaml"
            filename.write_text(json.dumps(config))
            installer.install(SOURCE, home, JsonCodec())
            before = filename.read_bytes(), filename.stat().st_mtime_ns
            installer.install(SOURCE, home, JsonCodec())
            self.assertEqual((filename.read_bytes(), filename.stat().st_mtime_ns), before)
            saved = json.loads(filename.read_text())
            self.assertEqual(saved["plugins"]["enabled"], [])
            self.assertEqual(saved["plugins"]["entries"], config["plugins"]["entries"])
            self.assertEqual(saved["model"], config["model"])
            self.assertEqual((home / "plugins/soma-progress/__init__.py").read_bytes(), (SOURCE / "__init__.py").read_bytes())
            target = home / "plugins/soma-progress/__init__.py"
            target.unlink()
            target.symlink_to(filename)
            with self.assertRaises(Exception):
                installer.install(SOURCE, home, JsonCodec())
            self.assertEqual(filename.read_bytes(), before[0])
            self.assertEqual(list(home.rglob(".soma-progress-*")), [])
            self.assertEqual(list(home.glob("*.sqlite")), [])
        self.assertFalse(home.exists())


if __name__ == "__main__":
    unittest.main()
