"""Opt-in daily preparation, bounded improvement proposals and natural day boundaries."""

import asyncio
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import threading
import time
from zoneinfo import ZoneInfo

from .state import State, consume
from .boundaries import greeting, rotate

_gate_path = Path(__file__).with_name("gate.py")
if not _gate_path.exists():
    _gate_path = Path(__file__).resolve().parents[2] / "heartbeat-gate.py"
_spec = importlib.util.spec_from_file_location(__name__ + "._delivery", _gate_path)
delivery = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(delivery)

DEFAULTS = {"enabled": False, "timezone": "UTC", "greetings": [], "continuations": ["continue", "продолжим", "продолжай"],
            "daily_time": "08:30", "review_interval_days": 7, "quiet_start": "22:00", "quiet_end": "08:00",
            "minimum_interval_seconds": 3600, "daily_limit": 2, "maximum_age_seconds": 7200, "sources": []}
HELP = ("/soma-assistant status | enable | disable | check | review | pause | resume | snooze MINUTES | "
        "focus commitments|improvements|all | mute continuity|operational | unmute continuity|operational. "
        "Enable requires explicit confirmation. Reviews propose changes and never apply them.")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, sort_keys=True).encode()).hexdigest()


def settings(ctx):
    config = {key: ctx.get_config(key, value) for key, value in DEFAULTS.items()}
    if config["enabled"] is not True:
        return None
    if (not delivery.integer(config["review_interval_days"], 1, 30) or
            not isinstance(config["sources"], list) or len(config["sources"]) > 2 or len(set(map(str, config["sources"]))) != len(config["sources"]) or
            any(source not in ("continuity", "operational") for source in config["sources"])):
        return None
    for key in ("greetings", "continuations"):
        values = config[key]
        if (not isinstance(values, list) or len(values) > 20 or any(not isinstance(p, str) or not p.strip() or
                len(p) > 80 or any(ord(c) < 32 for c in p) for p in values)):
            return None
    try:
        delivery.minute(config["daily_time"])
        delivery.policy({key: config[key] for key in delivery.DEFAULTS if key in config})
    except Exception:
        return None
    return config


def direct(event, runner):
    """Live native text DM with original Telegram provenance, before FIFO loses raw objects."""
    try:
        source, raw = event.source, event.raw_message
        owner = "telegram:" + str(source.user_id)
        delivery.owner_id(owner)
        valid = (source.platform.value == "telegram" and source.chat_type == "dm" and
                 str(source.chat_id) == str(source.user_id) and not source.is_bot and not source.thread_id and
                 not source.delivered_via_upstream_relay and event.internal is False and event.allow_gateway_control is True and
                 not event.inherit_channel_pin and not event.edit_revision and not event.metadata and not event.media_urls and
                 event.message_type.value in {"text", "command"} and isinstance(event.text, str) and len(event.text) <= 16000 and
                 not getattr(event, "_hermes_startup_restore_replay", False) and raw is not None and
                 not any(getattr(raw, key, None) for key in ("forward_origin", "forward_date", "via_bot", "edit_date")) and
                 raw.from_user.is_bot is False and str(raw.from_user.id) == str(source.user_id) == str(raw.chat.id) and
                 raw.chat.type == "private" and str(raw.message_id) == str(event.message_id) and
                 re.fullmatch(r"[1-9][0-9]{0,14}", str(event.message_id or "")) and
                 runner._is_user_authorized_for_source(source) is True and not runner.config.multiplex_profiles)
        if valid:
            return owner
    except Exception:
        pass
    return None


def natural(text):
    """Exact, bounded intent grammar; unrelated prose/quoted instructions are never controls."""
    text = " ".join(text.strip().casefold().rstrip(".!?").split())
    choices = {"поставь уведомления на паузу": "pause", "пауза уведомлений": "pause", "pause follow-ups": "pause",
               "возобнови уведомления": "resume", "resume follow-ups": "resume",
               "сфокусируй уведомления на задачах": "focus commitments", "focus follow-ups on commitments": "focus commitments",
               "сфокусируй уведомления на улучшениях": "focus improvements", "сними фокус уведомлений": "focus all",
               "уведомления о задачах не полезны": "mute continuity", "уведомления об улучшениях не полезны": "mute operational",
               "верни уведомления о задачах": "unmute continuity", "верни уведомления об улучшениях": "unmute operational",
               "уведомления слишком частые": "feedback", "follow-ups are too frequent": "feedback"}
    if text in choices:
        return choices[text]
    match = re.fullmatch(r"(?:отложи уведомления на|snooze follow-ups for) ([1-9][0-9]{0,4}) (минут[уы]?|minutes?|час(?:а|ов)?|hours?)", text)
    if match:
        amount = int(match[1]) * (60 if match[2].startswith(("час", "hour")) else 1)
        return f"snooze {amount}" if amount <= 30 * 1440 else "invalid"
    return None


class Assistant:
    def __init__(self, ctx):
        self.ctx = ctx
        self.home = Path(ctx._manager.home_path).resolve()
        self.state = State(self.home)
        self.lock = threading.RLock()
        self.receipts = {}
        self.turns = {}
        self.task = None
        self.closed = False

    def gate(self, owner, config):
        policy = {key: config[key] for key in delivery.DEFAULTS if key in config}
        return delivery.Gate(self.home.parent / "soma-heartbeat", owner, policy)

    def start(self, runner):
        if self.closed or not settings(self.ctx) or runner is None or runner.config.multiplex_profiles:
            return
        def launch():
            if not self.closed and (self.task is None or self.task.done()):
                self.task = self.ctx.spawn_task(self.monitor(runner), name="soma-assistant")
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is getattr(runner, "_gateway_loop", None) and loop is not None:
            launch()
        elif getattr(runner, "_gateway_loop", None) is not None:
            runner._gateway_loop.call_soon_threadsafe(launch)

    def ingress(self, *, event=None, gateway=None, **_ignored):
        config = settings(self.ctx)
        if not config:
            return
        self.start(gateway)
        owner = direct(event, gateway)
        if owner is None:
            return
        key = gateway._session_key_for_source(event.source)
        identity = (key, str(event.message_id), owner)
        now = time.monotonic()
        bounded = event.text if len(event.text) <= 160 else ""
        if natural(bounded) or greeting(bounded, config["greetings"], config["continuations"]):
            # Native /queue marker: preserve an active task before the gateway's
            # default plaintext interrupt path. Auth/prompt/admission gates still
            # run normally; explicit /stop and /new keep their epoch fence.
            epoch = getattr(gateway, "_route_stop_epoch", None)
            if callable(epoch):
                event._stop_epoch = epoch(key)
                event._fifo_only = True
        with self.lock:
            self.receipts = {k: v for k, v in self.receipts.items() if now - v[0] < 600}
            if identity in self.receipts or self.closed:
                return
            if len(self.receipts) >= 256:
                self.receipts.pop(next(iter(self.receipts)))
            self.receipts[identity] = (now, gateway, event.source, digest(event.text), bounded)

    def take(self, key, message, owner):
        with self.lock:
            receipt = self.receipts.pop((key, str(message), owner), None)
            if receipt is not None and 0 <= time.monotonic() - receipt[0] < 600 and not self.closed:
                return receipt
        return None

    async def admitted(self, *, session_key="", platform="", source=None, message_id="", text="", **_ignored):
        config = settings(self.ctx)
        if not config or platform != "telegram" or not isinstance(source, dict):
            return
        owner = "telegram:" + str(source.get("user_id", ""))
        receipt = self.take(session_key, message_id, owner)
        if receipt is None or receipt[3] != digest(text):
            return
        _, runner, original, _, bounded = receipt
        try:
            # Match all routing identities after native auth; never trust post-hook text alone.
            if (str(source.get("chat_id")) != owner[9:] or runner._is_user_authorized_for_source(original) is not True or
                    runner._session_key_for_source(original) != session_key):
                return
            route = {"platform": "telegram", "chat_type": "dm", "chat_id": owner[9:], "user_id": owner[9:]}
            entry = runner.session_store.lookup_by_session_key(session_key)
            sid = entry.session_id if entry else ""
            now = int(time.time())
            day = datetime.fromtimestamp(now, ZoneInfo(config["timezone"])).date().isoformat()
            old = await asyncio.to_thread(self.state.update, owner,
                lambda value: consume(value, int(message_id), sid, day, route, session_key))
            if old is None:
                return
            command = natural(bounded)
            if command:
                reply = await asyncio.to_thread(self.apply_control, owner, command, config, now)
                return {"action": "handled", "reply": reply}
            if (entry is not None and old.get("session") == sid and old.get("day", day) < day and
                    greeting(bounded, config["greetings"], config["continuations"])):
                fresh = await rotate(runner, session_key, sid)
                if fresh is not None:
                    await asyncio.to_thread(self.state.update, owner, lambda value: value.update(session=fresh.session_id))
        except Exception:
            # Unknown metadata never resets or consumes an ordinary user request.
            return

    def apply_control(self, owner, command, config, now):
        parts = command.split()
        action = parts[0]
        gate = self.gate(owner, config)
        if command == "feedback":
            if "operational" not in config["sources"]:
                return "Operational reviews are disabled; no review feedback was recorded."
            self.state.update(owner, lambda value: value.update(feedback=min(1000, value.get("feedback", 0) + 1)))
            return "Feedback recorded. The next improvement review can propose a lower frequency; no setting was changed."
        if action in {"pause", "resume"} and len(parts) == 1:
            control = {"action": action}
        elif action == "snooze" and len(parts) == 2 and parts[1].isdigit() and 1 <= int(parts[1]) <= 43200:
            control = {"action": "snooze", "until": now + int(parts[1]) * 60}
        elif action == "focus" and len(parts) == 2 and parts[1] in {"commitments", "improvements", "all"}:
            control = {"action": "focus", "topics": [] if parts[1] == "all" else [parts[1]]}
        elif action in {"mute", "unmute"} and len(parts) == 2 and parts[1] in config["sources"]:
            control = {"action": action, "source": parts[1]}
        else:
            return HELP
        gate.control(control, now=now)
        return "Follow-up control saved: " + command + "."

    def command(self, raw_args, *, source=None, session_key="", session_id="", platform=""):
        config = settings(self.ctx)
        if not config:
            return "SOMA assistant is disabled or its private settings are invalid."
        try:
            routing = source.to_dict() if hasattr(source, "to_dict") else source
            if not isinstance(routing, dict) or platform != "telegram":
                return "Use an authorized Telegram DM."
            owner = delivery.owner_id("telegram:" + str(routing.get("user_id", "")))
            message = str(routing.get("message_id", ""))
            receipt = self.take(session_key, message, owner)
            if receipt is None:
                return "A fresh direct user command is required."
            _, runner, original, _, _ = receipt
            if runner._is_user_authorized_for_source(original) is not True:
                return "Use an authorized Telegram DM."
            route = {"platform": "telegram", "chat_type": "dm", "chat_id": owner[9:], "user_id": owner[9:]}
            now = int(time.time())
            day = datetime.fromtimestamp(now, ZoneInfo(config["timezone"])).date().isoformat()
            old = self.state.update(owner, lambda value: consume(value, int(message), session_id, day, route, session_key))
            if old is None:
                return "Old or replayed command; send a fresh request."
            action = raw_args.strip() or "status"
            if action == "enable":
                if not config["sources"]:
                    return "Configure explicit authorized sources before enabling follow-ups."
                answer = self.ctx.ask_choice("Enable private daily preparation and periodic improvement reviews from " +
                    ", ".join(config["sources"]) + "? Only meaningful changes may notify you. Health records and conversations are not collected.",
                    [{"value": "confirm", "label": "Confirm"}, {"value": "cancel", "label": "Cancel"}])
                if answer != "confirm":
                    return "No subscription change was made."
                self.state.update(owner, lambda value: value.update(subscribed=True, review_at=now))
                self.start(runner)
                return "Follow-ups enabled for this DM. " + HELP
            if action == "disable":
                self.state.update(owner, lambda value: value.update(subscribed=False, pending={}))
                return "Follow-ups disabled for this DM. Delivery history was preserved."
            if action == "status":
                value = self.state.get(owner)
                return json.dumps({"subscribed": value.get("subscribed") is True, **self.gate(owner, config).status()}, ensure_ascii=True)
            if action in {"check", "review"}:
                if self.state.get(owner).get("subscribed") is not True:
                    return "Enable follow-ups explicitly first."
                self.prepare_owner(owner, config, now, force=action)
                return "Private preparation completed. Only a fresh, meaningful result passing delivery controls may notify you."
            return self.apply_control(owner, action, config, now)
        except Exception:
            return "Assistant state is unavailable or invalid. Check /soma-assistant status before retrying."

    def continuity(self, owner):
        loaded = self.ctx._manager._plugins.get("soma-continuity")
        if loaded is None or not loaded.enabled or loaded.error or loaded.module is None:
            return None
        from hermes_cli.plugins import PluginContext
        if PluginContext(loaded.manifest, self.ctx._manager).get_config("enabled", False) is not True:
            return None
        routing = {"platform": "telegram", "chat_type": "dm", "chat_id": owner[9:], "user_id": owner[9:]}
        module = loaded.module
        owner_hash = module.principal(routing)
        if not (self.home / "soma-continuity" / (owner_hash + ".sqlite")).exists():
            return []
        rows = module.Ledger(self.home, owner_hash).list()
        # IDs/revisions are enough for change detection. Never persist or send free-text entries.
        return sorted((row["id"], row["revision"]) for row in rows if row["kind"] == "commitment" and row["status"] == "active")

    def prepare_owner(self, owner, config, now, *, force=None):
        local = datetime.fromtimestamp(now, ZoneInfo(config["timezone"]))
        day = local.date().isoformat()
        value = self.state.get(owner)
        if value.get("subscribed") is not True:
            return
        daily = (force == "check" or (value.get("prepared_day") != day and local.hour * 60 + local.minute >= delivery.minute(config["daily_time"])))
        review = force == "review" or now - value.get("review_at", now) >= config["review_interval_days"] * 86400
        snapshot = self.continuity(owner) if daily and "continuity" in config["sources"] else None
        def change(current):
            if current.get("subscribed") is not True:
                return
            pending = current.setdefault("pending", {})
            revisions = current.setdefault("revisions", {})
            def candidate(source, fingerprint, message, topic):
                revisions[source] = revisions.get(source, 0) + 1
                pending[source] = {"fingerprint": fingerprint, "candidate": {"schema_version": 1, "owner": owner, "source": source,
                    "revision": revisions[source], "topic": topic, "observed_at": now, "expires_at": now + config["maximum_age_seconds"],
                    "meaningful": True, "message": message}}
            if daily and current.get("prepared_day") != day or force == "check":
                if snapshot is not None:
                    fingerprint = digest(snapshot)
                    if snapshot and fingerprint != current.get("continuity_digest"):
                        candidate("continuity", fingerprint, f"There are {len(snapshot)} explicitly confirmed open commitments. "
                                  "Use /soma-continuity list to review them and choose the next step. No task was marked complete.", "commitments")
                    elif not snapshot:
                        pending.pop("continuity", None)
                    current["continuity_digest"] = fingerprint
                    current["prepared_day"] = day
            if review and "operational" in config["sources"]:
                evidence = {key: current.get(key, 0) for key in ("errors", "slow", "feedback")}
                fingerprint = digest(evidence)
                proposal = ("Feedback indicates follow-ups are too frequent. Proposal: lower the daily limit. Next step: review and explicitly approve a configuration change."
                            if evidence["feedback"] else
                            "Several follow-up checks or deliveries were unavailable. Proposal: inspect bounded runtime diagnostics. Next step: explicitly approve an operator review."
                            if evidence["errors"] >= 3 else
                            "Several tasks ran longer than ten minutes. Proposal: split future work into smaller steps. Next step: explicitly approve a workflow change."
                            if evidence["slow"] >= 3 else "")
                if proposal and fingerprint != current.get("review_digest"):
                    candidate("operational", fingerprint, proposal + " No code, dependencies, services or permissions were changed.", "improvements")
                current.update(review_at=now, review_digest=fingerprint)
        self.state.update(owner, change)

    async def tick(self, runner, now=None):
        config = settings(self.ctx)
        if not config or self.closed or not runner._running or runner._draining or runner.config.multiplex_profiles:
            return
        clock = time.time if now is None else lambda: now
        now = int(clock())
        from gateway.session import SessionSource
        from gateway import plugin_messages
        for owner in await asyncio.to_thread(self.state.subscribers):
            try:
                value = await asyncio.to_thread(self.state.get, owner)
                source = SessionSource.from_dict(value["route"])
                key = value["key"]
                if runner._session_key_for_source(source) != key or runner._is_user_authorized_for_source(source) is not True:
                    continue
                # Preparation is private and runs independently of quiet hours or pause.
                await asyncio.to_thread(self.prepare_owner, owner, config, now)
                value = await asyncio.to_thread(self.state.get, owner)
                for name, prepared in list(value.get("pending", {}).items())[:2]:
                    if name not in config["sources"]:
                        continue
                    if name == "continuity":
                        current = await asyncio.to_thread(self.continuity, owner)
                        if current is None or digest(current) != prepared["fingerprint"]:
                            await asyncio.to_thread(self.drop, owner, name, prepared)
                            continue
                    elif name == "operational":
                        current = await asyncio.to_thread(self.state.get, owner)
                        evidence = {key: current.get(key, 0) for key in ("errors", "slow", "feedback")}
                        if digest(evidence) != prepared["fingerprint"]:
                            await asyncio.to_thread(self.drop, owner, name, prepared)
                            continue
                    target, refusal = await asyncio.to_thread(plugin_messages.resolve, runner, session_key=key, route=source,
                        plugin_home=self.home, plugin_id=self.ctx.plugin_id)
                    if refusal or target is None or target.platform != "telegram" or target.chat_id != owner[9:]:
                        continue
                    if self.closed or not settings(self.ctx) or not runner._running or runner._draining:
                        return
                    latest = await asyncio.to_thread(self.state.get, owner)
                    if runner._is_user_authorized_for_source(source) is not True or latest.get("subscribed") is not True:
                        continue
                    # Native profile ownership and route are resolved before the durable gate.
                    current_config = settings(self.ctx)
                    if not current_config or name not in current_config["sources"]:
                        continue
                    if name == "continuity":
                        current = await asyncio.to_thread(self.continuity, owner)
                        if current is None or digest(current) != prepared["fingerprint"]:
                            await asyncio.to_thread(self.drop, owner, name, prepared)
                            continue
                    elif name == "operational":
                        evidence = {field: latest.get(field, 0) for field in ("errors", "slow", "feedback")}
                        if digest(evidence) != prepared["fingerprint"]:
                            await asyncio.to_thread(self.drop, owner, name, prepared)
                            continue
                    gate = self.gate(owner, current_config)
                    permit = await asyncio.to_thread(gate.evaluate, prepared["candidate"], claim=True, now=int(clock()))
                    if permit["decision"] == "send":
                        # Recheck controls after the reservation await too. An already
                        # handed-off network send cannot be recalled by a later pause.
                        final_config = settings(self.ctx)
                        final = (await asyncio.to_thread(self.gate(owner, final_config).evaluate, prepared["candidate"], now=int(clock()))
                                 if final_config else {"reason": "disabled"})
                        latest = await asyncio.to_thread(self.state.get, owner)
                        actual = int(clock())
                        if (self.closed or actual < permit["created_at"] or actual >= permit["valid_until"] or
                                final.get("reason") != "already_attempted" or
                                runner._is_user_authorized_for_source(source) is not True or
                                latest.get("subscribed") is not True):
                            await asyncio.to_thread(gate.record, permit["token"], "unknown")
                        else:
                            result = await plugin_messages.post(target, permit["message"], plugin_id=self.ctx.plugin_id)
                            await asyncio.to_thread(gate.record, permit["token"], "delivered" if result.get("ok") is True else "unknown")
                            if result.get("ok") is not True:
                                await asyncio.to_thread(self.error, owner)
                        await asyncio.to_thread(self.drop, owner, name, prepared)
                    elif permit.get("reason") in {"already_attempted", "stale_or_future"}:
                        await asyncio.to_thread(self.drop, owner, name, prepared)
            except asyncio.CancelledError:
                raise
            except Exception:
                # No unredacted exception, prompt, history or log excerpt is retained.
                try:
                    await asyncio.to_thread(self.error, owner)
                except Exception:
                    pass

    def error(self, owner):
        config = settings(self.ctx)
        if config and "operational" in config["sources"]:
            self.state.update(owner, lambda value: value.update(errors=min(1000, value.get("errors", 0) + 1))
                              if value.get("subscribed") is True else None)

    def drop(self, owner, source, prepared):
        def change(value):
            if value.get("pending", {}).get(source) == prepared:
                value["pending"].pop(source, None)
        self.state.update(owner, change)

    async def monitor(self, runner):
        while not self.closed and runner._running and settings(self.ctx):
            try:
                await self.tick(runner)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(60)

    def turn_start(self, *, platform="", session_id="", turn_id="", sender_id="", parent_session_id="", **_ignored):
        config = settings(self.ctx)
        if not config or "operational" not in config["sources"] or platform != "telegram" or parent_session_id:
            return
        from gateway.session_context import bound_session_key, get_session_env
        key = bound_session_key()
        if (not key or get_session_env("HERMES_CRON_SESSION", "") == "1" or
                get_session_env("HERMES_SESSION_CHAT_TYPE", "") != "dm" or
                get_session_env("HERMES_SESSION_CHAT_ID", "") != sender_id or
                get_session_env("HERMES_SESSION_ID", "") != session_id or get_session_env("HERMES_SESSION_USER_ID", "") != sender_id):
            return
        try:
            if self.state.get("telegram:" + sender_id).get("subscribed") is not True:
                return
        except Exception:
            return
        with self.lock:
            if len(self.turns) < 128:
                self.turns.setdefault((session_id, turn_id), (time.monotonic(), "telegram:" + sender_id))

    def turn_end(self, *, session_id="", turn_id="", **_ignored):
        with self.lock:
            turn = self.turns.pop((session_id, turn_id), None)
        config = settings(self.ctx)
        if turn and config and "operational" in config["sources"] and 600 <= time.monotonic() - turn[0] <= 21600:
            try:
                self.state.update(turn[1], lambda value: value.update(slow=min(1000, value.get("slow", 0) + 1))
                                  if value.get("subscribed") is True else None)
            except Exception:
                pass

    def reset(self, *, old_session_id="", reason="", **_ignored):
        # The stored session ID mismatch on the next message makes manual resets
        # a new baseline. Do not enumerate or rewrite other owners on reset hooks.
        if old_session_id:
            with self.lock:
                for identity in list(self.turns):
                    if identity[0] == old_session_id:
                        self.turns.pop(identity)

    def close(self):
        with self.lock:
            self.closed = True
            self.receipts.clear()
            self.turns.clear()


def register(ctx):
    global assistant
    assistant = Assistant(ctx)
    ctx.register_hook("pre_gateway_dispatch", assistant.ingress)
    ctx.register_hook("post_gateway_admission", assistant.admitted)
    ctx.register_hook("pre_llm_call", assistant.turn_start)
    ctx.register_hook("post_llm_call", assistant.turn_end)
    ctx.register_hook("on_session_reset", assistant.reset)
    ctx.register_command("soma-assistant", assistant.command, description="Control opt-in preparation and follow-ups", args_hint="<action>")
    ctx.on_unload(assistant.close)
