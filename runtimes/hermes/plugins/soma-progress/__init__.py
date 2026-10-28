"""One bounded, factual notice per live user turn; compatible with the pinned gateway."""

import asyncio
from dataclasses import dataclass, field
import re
import threading
import time

DEFAULT_MESSAGE = "Still working on your request."
MAX_ACTIVE = 128
MAX_INGRESS = 256
MAX_AGE = 21600


def settings(ctx):
    enabled = ctx.get_config("enabled", False)
    interval = ctx.get_config("interval_seconds", 60)
    message = ctx.get_config("message", DEFAULT_MESSAGE)
    if (enabled is not True or type(interval) is not int or not 15 <= interval <= 3600 or
            not isinstance(message, str) or not message.strip() or len(message) > 240 or
            any(ord(c) < 32 or ord(c) == 127 for c in message)):
        return None
    return interval, message


@dataclass
class Notice:
    key: str
    session: str
    turn: str
    generation: int
    agent: object
    event: object
    started: float
    due: float
    interval: int
    message: str
    waiting: set = field(default_factory=set)
    suppressed: bool = False
    attempted: bool = False
    ended: bool = False

    def wait(self, identity, resolved, now):
        if not identity or len(self.waiting) >= 32:
            # An uncorrelated or overflowing wait cannot safely be cleared by a later event.
            self.suppressed = True
        elif resolved:
            if identity in self.waiting:
                self.waiting.remove(identity)
                self.due = now + self.interval
        else:
            self.waiting.add(identity)

    def ready(self, now):
        return (not self.ended and not self.attempted and not self.suppressed and
                not self.waiting and self.due <= now < self.started + MAX_AGE)


def live(runner, notice):
    """No history/database reads: require this exact live agent, event and generation."""
    try:
        state = runner._peek_session_state(notice.key)
        return (runner._running is True and state is not None and
                state.persistent.run_generation == notice.generation and
                state.turn.agent is notice.agent and state.turn.event is notice.event and
                notice.agent.session_id == notice.session and not notice.agent.is_interrupted())
    except Exception:
        return False


def direct_event(event, sender, *, require_raw=True):
    """Admitted native Telegram DMs only; no internal, relayed, edited or media turns."""
    try:
        source = event.source
        raw = event.raw_message
        valid = (source.platform.value == "telegram" and source.chat_type == "dm" and
                not source.is_bot and not source.thread_id and
                not source.delivered_via_upstream_relay and
                str(source.user_id) == str(source.chat_id) == sender and
                re.fullmatch(r"[1-9][0-9]{0,19}", sender) is not None and
                re.fullmatch(r"[1-9][0-9]{0,14}", str(event.message_id or "")) is not None and
                event.internal is False and event.allow_gateway_control is True and
                not event.inherit_channel_pin and not event.edit_revision and
                not getattr(event, "_hermes_startup_restore_replay", False) and
                event.message_type.value == "text" and not event.media_urls and not event.metadata)
        if not valid or raw is None:
            return valid and not require_raw
        return (not getattr(raw, "forward_origin", None) and not getattr(raw, "forward_date", None) and
                not getattr(raw, "via_bot", None) and not getattr(raw, "edit_date", None) and
                not getattr(getattr(raw, "from_user", None), "is_bot", True) and
                str(raw.from_user.id) == sender and str(raw.chat.id) == sender and
                raw.chat.type == "private" and str(raw.message_id) == str(event.message_id))
    except Exception:
        return False


class Progress:
    def __init__(self, ctx):
        self.ctx = ctx
        self.lock = threading.RLock()
        self.active = {}
        self.receipts = {}
        self.closed = False

    def ingress(self, *, event=None, gateway=None, **_ignored):
        # Native FIFO snapshots omit raw Telegram objects. Retain only a bounded
        # routing receipt; never the message text, SDK object or transcript.
        try:
            source = event.source
            if (not settings(self.ctx) or not direct_event(event, str(source.user_id)) or
                    gateway._is_user_authorized_for_source(source) is not True):
                return
            key = gateway._session_key_for_source(source)
            identity = (key, str(event.message_id), str(source.user_id))
            now = time.monotonic()
            with self.lock:
                self.prune_receipts(now)
                if not self.closed and identity not in self.receipts:
                    if len(self.receipts) >= MAX_INGRESS:
                        self.receipts.pop(next(iter(self.receipts)))
                    self.receipts[identity] = [now, False, False]
        except Exception:
            return

    def admitted(self, *, session_key="", message_id="", source=None, platform="", **_ignored):
        # This observer runs AFTER native auth/bot/prompt gates. It never consumes
        # or rewrites input and never changes the queue or session lifecycle.
        if platform != "telegram" or not isinstance(source, dict):
            return
        identity = (session_key, str(message_id), str(source.get("user_id", "")))
        with self.lock:
            receipt = self.receipts.get(identity)
            if receipt:
                receipt[1] = True

    def prune_receipts(self, now):
        for identity, receipt in list(self.receipts.items()):
            if now - receipt[0] >= MAX_AGE:
                self.receipts.pop(identity)

    def start(self, *, session_id="", turn_id="", platform="", sender_id="", parent_session_id="", **_ignored):
        config = settings(self.ctx)
        if not config or parent_session_id or platform != "telegram" or not session_id or not turn_id:
            return
        from gateway.session_context import bound_session_key, get_session_env
        key = bound_session_key()
        if (not key or get_session_env("HERMES_SESSION_ID", "") != session_id or
                get_session_env("HERMES_SESSION_USER_ID", "") != sender_id or
                get_session_env("HERMES_CRON_SESSION", "") == "1"):
            return
        from gateway.run import _gateway_runner_ref
        runner = _gateway_runner_ref()
        if runner is None:
            return
        try:
            state = runner._peek_session_state(key)
            event, agent = state.turn.event, state.turn.agent
            if not direct_event(event, sender_id, require_raw=False):
                return
            now = time.monotonic()
            interval, message = config
            notice = Notice(key, session_id, turn_id, state.persistent.run_generation,
                            agent, event, now, now + interval, interval, message)
            if not live(runner, notice):
                return
            with self.lock:
                self.prune_receipts(now)
                receipt = self.receipts.get((key, str(event.message_id), sender_id))
                if not receipt or not receipt[1] or receipt[2]:
                    return
                for prior_key, prior in list(self.active.items()):
                    if not live(runner, prior):
                        prior.ended = True
                        self.active.pop(prior_key)
                old = self.active.get(key)
                if self.closed or (old and old.session == session_id and old.turn == turn_id):
                    return
                if old:
                    old.ended = True
                elif len(self.active) >= MAX_ACTIVE:
                    return
                receipt[2] = True
                self.active[key] = notice
            # pre_llm_call runs on a worker. Schedule a supervised task on the host loop;
            # no timer thread, unowned task, global environment fallback or model request.
            runner._gateway_loop.call_soon_threadsafe(self.launch, runner, notice)
        except Exception:
            # A missing/changed pinned interface fails silently, never breaks a user turn.
            self.finish(session_id=session_id, turn_id=turn_id)

    def launch(self, runner, notice):
        with self.lock:
            if self.closed or self.active.get(notice.key) is not notice or notice.ended:
                return
        self.ctx.spawn_task(self.monitor(runner, notice), name="soma-progress")

    async def monitor(self, runner, notice):
        try:
            while True:
                await asyncio.sleep(1)
                with self.lock:
                    if (self.closed or self.active.get(notice.key) is not notice or notice.ended or
                            not settings(self.ctx) or not live(runner, notice) or
                            time.monotonic() >= notice.started + MAX_AGE):
                        return
                    if not notice.ready(time.monotonic()):
                        continue
                # Native resolver checks the plugin's profile ownership and selects the
                # receiving adapter. Resolve off-loop, then recheck generation and waits.
                from gateway import plugin_messages
                target, refusal = await asyncio.to_thread(
                    plugin_messages.resolve, runner, session_key=notice.key, route=notice.event.source,
                    plugin_home=self.ctx._manager.home_path, plugin_id=self.ctx.plugin_id)
                with self.lock:
                    if (self.closed or self.active.get(notice.key) is not notice or
                            not notice.ready(time.monotonic()) or not live(runner, notice) or
                            not settings(self.ctx)):
                        return
                    # Reserve BEFORE handing off: a refused/ambiguous delivery is never retried.
                    notice.attempted = True
                    if (refusal or target is None or target.platform != "telegram" or
                            target.chat_id != str(notice.event.source.user_id)):
                        return
                await plugin_messages.post(target, notice.message, plugin_id=self.ctx.plugin_id)
                return
        finally:
            with self.lock:
                # Keep the attempted marker until the turn ends: duplicate start hooks
                # cannot schedule another notice, including after a transport failure.
                if self.active.get(notice.key) is notice and not notice.attempted:
                    self.active.pop(notice.key)

    def finish(self, *, session_id="", turn_id="", session_key="", **_ignored):
        with self.lock:
            for key, notice in list(self.active.items()):
                if ((session_key and key == session_key) or
                        (session_id and notice.session == session_id and (not turn_id or notice.turn == turn_id))):
                    notice.ended = True
                    self.active.pop(key)

    def wait(self, *, resolved=False, approval=False, session_key="", session_id="", turn_id="",
             request_id="", tool_call_id="", **_ignored):
        with self.lock:
            for key, notice in self.active.items():
                if ((session_key and key != session_key) or (session_id and notice.session != session_id) or
                        (turn_id and notice.turn != turn_id) or not (session_key or session_id)):
                    continue
                identity = (("approval" if approval else "input", request_id) if request_id else
                            (("approval", turn_id, tool_call_id) if approval and turn_id and tool_call_id else None))
                notice.wait(identity, resolved, time.monotonic())

    def close(self):
        with self.lock:
            self.closed = True
            for notice in self.active.values():
                notice.ended = True
            self.active.clear()
            self.receipts.clear()


def register(ctx):
    progress = Progress(ctx)
    ctx.register_hook("pre_gateway_dispatch", progress.ingress)
    ctx.register_hook("post_gateway_admission", progress.admitted)
    ctx.register_hook("pre_llm_call", progress.start)
    ctx.register_hook("post_llm_call", progress.finish)
    ctx.register_hook("agent_loop_stopped", progress.finish)
    ctx.register_hook("on_session_end", progress.finish)
    ctx.register_hook("on_session_reset", progress.finish)
    ctx.register_hook("on_human_input_request", progress.wait)
    ctx.register_hook("on_human_input_resolved", lambda **kw: progress.wait(resolved=True, **kw))
    ctx.register_hook("pre_approval_request", lambda **kw: progress.wait(approval=True, **kw))
    ctx.register_hook("post_approval_response", lambda **kw: progress.wait(resolved=True, approval=True, **kw))
    ctx.on_unload(progress.close)
