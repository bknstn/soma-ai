"""Pinned native idle-only Telegram rotation; no transcript or health-context reads."""

import asyncio
from contextlib import AsyncExitStack
from datetime import datetime, timezone
import json
import threading
import time
import uuid


def greeting(text, greetings, continuations):
    normalize = lambda value: " ".join(value.casefold().strip().rstrip(".!?…").split())
    text = normalize(text)
    if any(text == normalize(p) or text.startswith(normalize(p) + " ") for p in continuations):
        return False
    return text in {normalize(p) for p in greetings}


def memory_idle(runner, key):
    if runner._running is not True or runner._draining or runner.config.multiplex_profiles:
        return False
    state = runner._peek_session_state(key)
    if state is not None and (state.turn.agent is not None or state.conversation.queued_events or
                              state.persistent.pending_command_text or state.persistent.approvals):
        return False
    adapter = runner._delivery_adapter_for(runner.session_store._entries[key].origin)
    if adapter is None or getattr(adapter, "_pending_messages", {}).get(key):
        return False
    if runner.session_store._has_active_processes_safe(key, context="soma_new_day"):
        return False
    from tools.async_delegation import has_live_for_session
    return not has_live_for_session(session_key=key, parent_session_id=runner.session_store._entries[key].session_id)


def rotate_transaction(store, db, key, old_sid):
    """Native writer serializes the idle guard, child row and route CAS in ONE transaction.

    Store/save locks also fence native whole-index snapshots. Only the supported
    single-profile store, whose routing and session DB are identical, is eligible.
    """
    from gateway.session import SessionEntry
    from hermes_state_mutation_guards import require_idle
    from hermes_state_runtime_workers import runtime_lineage
    with store._lock:
        old = store._entries.get(key)
        if old is None or old.session_id != old_sid or store._routing_db is not db or store._db_for_key(key) is not db:
            return None
        if old.active_turn_token or old.resume_pending or old.suspended or store._has_active_processes_safe(key, context="soma_new_day"):
            return None
        now = datetime.now(timezone.utc)
        entry = SessionEntry(key, uuid.uuid4().hex, now, now, origin=old.origin, platform=old.platform,
                             chat_type=old.chat_type, transport_profile=old.transport_profile,
                             display_name=old.display_name, is_fresh_reset=True)
        encoded = json.dumps(entry.to_dict())
        scope = store._routing_scope()
        def commit(conn):
            row = conn.execute("SELECT entry_json FROM gateway_routing WHERE scope=? AND session_key=?", (scope, key)).fetchone()
            if row is None or json.loads(row[0]).get("session_id") != old_sid:
                raise ValueError("Stale routing metadata")
            targets = runtime_lineage(conn, old_sid)
            require_idle(db, conn, list(targets))
            # Read only the columns consumed by the native child publisher, never messages/prompts.
            columns = ("id,source,created_source,model,model_config,tool_names,cwd,git_branch,git_repo_root,profile_name,"
                       "user_id,session_key,chat_id,chat_type,thread_id,display_name,origin_json,pinned,archived,auto_archived,ended_at")
            parent = conn.execute("SELECT " + columns + " FROM sessions WHERE id=?", (old_sid,)).fetchone()
            if parent is None or parent["ended_at"] is not None:
                raise ValueError("Unavailable session metadata")
            db._publish_child_session_row(conn, parent, parent_session_id=old_sid, child_session_id=entry.session_id,
                                         source=parent["source"], model=parent["model"], model_config={"_reset_from": old_sid},
                                         system_prompt=None, cwd=parent["cwd"], profile_name=parent["profile_name"])
            conn.execute("UPDATE sessions SET ended_at=?,end_reason='session_reset' WHERE id=?", (time.time(), old_sid))
            db._bump_conversation_generation(conn, old_sid, "session_reset")
            conn.execute("UPDATE gateway_routing SET entry_json=?,updated_at=? WHERE scope=? AND session_key=?",
                         (encoded, time.time(), scope, key))
        with store._lazy("_save_lock", threading.Lock):
            revision = store._next_routing_generation_locked()
            db._execute_write(commit)
            store._entries[key] = entry
            store._lazy("_fast_persisted_entries", dict)[key] = (revision, encoded)
        return entry


async def rotate(runner, key, old_sid):
    from gateway.session_authorities import active_authority
    from gateway.session_runtime_workers import track_mutation
    authority = active_authority(runner)
    if authority is None or not memory_idle(runner, key):
        return None
    if (getattr(authority, "_side_agents", {}) or getattr(authority, "_managed_workers", {}) or
            any(not task.done() for task in getattr(authority, "_mutation_tasks", ()))):
        return None
    # Hook cancellation/unload must not release reservation/claim locks while the
    # native off-loop commit still runs. The authority owns the WHOLE operation.
    return await asyncio.shield(track_mutation(authority, _rotate_owned(runner, authority, key, old_sid)))


async def _rotate_owned(runner, authority, key, old_sid):
    from gateway.session_authority import keyed_turn
    # Same FIFO reservation lock as native ingress. Existing input commits first;
    # later input waits and binds to the replacement instead of being cancelled.
    async with keyed_turn(authority._route_turns, key):
        if authority._route_turns[key][1] > 1:
            return None
        sid = authority.logical_owner(old_sid)
        live = authority.sessions.get(sid)
        async with AsyncExitStack() as locks:
            if live is not None:
                await locks.enter_async_context(live.claim_gate)
                await locks.enter_async_context(live.mutation_lock)
                if live.settling or getattr(live.review, "task", None):
                    return None
            if not memory_idle(runner, key):
                return None
            from gateway.session_runtime_workers import tracked_write
            def publish(entry):
                if entry is not None:
                    if live is not None:
                        live.superseded = True
                    authority._publish_route(entry.origin, entry.session_id, key)
                    state = runner._peek_session_state(key)
                    queued = list(state.conversation.queued_events) if state else []
                    runner._clear_conversation_scope(key, reason="soma_new_day")
                    if state is not None:
                        state.conversation.queued_events.extend(queued)
                    runner._evict_cached_agent_at_boundary(key)
                return entry
            entry = await tracked_write(authority, lambda: rotate_transaction(runner.session_store, authority.db, key, old_sid), then=publish)
    if entry is not None:
        await runner._reset_session_off_loop(session_key=key, session_id=entry.session_id, reason="soma_new_day",
                                            old_session_id=old_sid, new_session_id=entry.session_id, platform="telegram")
    return entry
