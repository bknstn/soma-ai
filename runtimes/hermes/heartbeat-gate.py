"""SOMA heartbeat gate v1: offline preparation and durable, at-most-once handoff.

This module collects nothing and has no scheduler, model or transport. An authorized
caller supplies a bounded candidate and handles the returned, short-lived permit.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_BYTES = 8192
MAX_SOURCES = 16
MAX_ATTEMPTS = 256
MAX_TIME = 4102444800
ROOT = Path(__file__).resolve().parents[2]
DEFAULTS = {"schema_version": 1, "enabled": False, "timezone": "UTC",
            "quiet_start": "22:00", "quiet_end": "08:00", "minimum_interval_seconds": 3600,
            "daily_limit": 2, "maximum_age_seconds": 7200, "sources": [], "focus": []}


class GateError(Exception):
    pass


def integer(value, low=0, high=MAX_TIME):
    return type(value) is int and low <= value <= high


def slug(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,39}", value) is not None


def slugs(value):
    return isinstance(value, list) and len(value) <= MAX_SOURCES and all(map(slug, value)) and len(set(value)) == len(value)


def owner_id(value):
    if not isinstance(value, str) or re.fullmatch(r"telegram:[1-9][0-9]{0,19}", value) is None:
        raise GateError("invalid_owner")
    return value


def minute(value):
    if not isinstance(value, str) or re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", value) is None:
        raise GateError("invalid_policy")
    return int(value[:2]) * 60 + int(value[3:])


def policy(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise GateError("invalid_policy")
    result = {**DEFAULTS, **value}
    if (type(result["schema_version"]) is not int or result["schema_version"] != 1 or
            type(result["enabled"]) is not bool or not slugs(result["sources"]) or not slugs(result["focus"]) or
            not integer(result["daily_limit"], 1, 32) or
            not integer(result["minimum_interval_seconds"], 60, 86400) or
            not integer(result["maximum_age_seconds"], 60, 86400)):
        raise GateError("invalid_policy")
    minute(result["quiet_start"])
    minute(result["quiet_end"])
    try:
        if not isinstance(result["timezone"], str) or len(result["timezone"]) > 80:
            raise ValueError()
        ZoneInfo(result["timezone"])
    except (ValueError, ZoneInfoNotFoundError):
        raise GateError("invalid_policy") from None
    # Do not share mutable default lists with callers.
    return {**result, "sources": list(result["sources"]), "focus": list(result["focus"])}


def prepare(value):
    """Validate private preparation, without opening storage or granting delivery."""
    fields = {"schema_version", "owner", "source", "revision", "topic", "observed_at", "expires_at", "meaningful", "message"}
    if not isinstance(value, dict) or set(value) != fields:
        raise GateError("invalid_candidate")
    if (type(value["schema_version"]) is not int or value["schema_version"] != 1 or
            not slug(value["source"]) or not slug(value["topic"]) or
            not integer(value["revision"], 1, 2 ** 53 - 1) or
            not integer(value["observed_at"]) or not integer(value["expires_at"]) or
            value["expires_at"] <= value["observed_at"] or type(value["meaningful"]) is not bool or
            not isinstance(value["message"], str) or not value["message"].strip() or len(value["message"]) > 500 or
            any(ord(c) < 32 or ord(c) == 127 for c in value["message"])):
        raise GateError("invalid_candidate")
    owner_id(value["owner"])
    return dict(value)


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise GateError("invalid_json")
            result[key] = value
        return result
    if len(raw) > MAX_BYTES:
        raise GateError("input_too_large")
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(GateError("invalid_json")))
    except (ValueError, UnicodeError, RecursionError):
        raise GateError("invalid_json") from None


def private_file(filename, *, create=False, limit=MAX_BYTES):
    flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_RDWR | os.O_CREAT if create else os.O_RDONLY)
    fd = os.open(filename, flags, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or
                info.st_size > limit):
            raise GateError("unsafe_storage")
        raw = os.read(fd, limit + 1) if not create else None
        if raw is not None and len(raw) > limit:
            raise GateError("unsafe_storage")
        return raw
    finally:
        os.close(fd)


class Gate:
    def __init__(self, home, owner, settings):
        self.home, self.owner, self.settings = Path(home), owner_id(owner), policy(settings)

    @contextmanager
    def transaction(self):
        home = self.home
        if (not home.is_absolute() or home.resolve() != home or home.is_symlink() or
                home == ROOT or ROOT in home.parents or home in ROOT.parents or
                any(part in {".hermes", ".health-os", ".git"} for part in home.parts)):
            raise GateError("unsafe_storage")
        # Only this explicit leaf may be created; never enumerate another user's state.
        home.mkdir(mode=0o700, exist_ok=True)
        info = home.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise GateError("unsafe_storage")
        filename = home / (hashlib.sha256(self.owner.encode()).hexdigest() + ".sqlite")
        private_file(filename, create=True, limit=1024 * 1024)
        # Reject SQLite sidecar links too. Same-account processes remain trusted.
        for suffix in ("-journal", "-wal", "-shm"):
            try:
                private_file(Path(str(filename) + suffix), limit=1024 * 1024)
            except FileNotFoundError:
                pass
        db = sqlite3.connect(filename, timeout=2, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("PRAGMA max_page_count=256")
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise GateError("unsupported_version")
            db.execute("CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), "
                       "paused INTEGER NOT NULL, snooze INTEGER NOT NULL, focus TEXT, clock INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO control VALUES (1, 0, 0, NULL, 0)")
            db.execute("CREATE TABLE IF NOT EXISTS sources (source TEXT PRIMARY KEY, revision INTEGER NOT NULL, muted INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (token TEXT PRIMARY KEY, source TEXT NOT NULL, revision INTEGER NOT NULL, "
                       "created INTEGER NOT NULL, status TEXT NOT NULL)")
            db.execute("PRAGMA user_version=1")
            self.validate_state(db)
            yield db
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def validate_state(db):
        """A readable database with malformed metadata must also fail closed."""
        controls = list(db.execute("SELECT * FROM control LIMIT 2"))
        sources = list(db.execute("SELECT * FROM sources LIMIT ?", (MAX_SOURCES + 1,)))
        attempts = list(db.execute("SELECT * FROM attempts LIMIT ?", (MAX_ATTEMPTS + 1,)))
        try:
            control = controls[0]
            focus = json.loads(control["focus"]) if control["focus"] is not None else []
            invalid = (len(controls) != 1 or control["id"] != 1 or
                       not integer(control["paused"], 0, 1) or not integer(control["snooze"]) or
                       not integer(control["clock"]) or not slugs(focus) or
                       len(sources) > MAX_SOURCES or len(attempts) > MAX_ATTEMPTS)
            invalid = invalid or any(not slug(row["source"]) or not integer(row["revision"], 0, 2 ** 53 - 1) or
                                     not integer(row["muted"], 0, 1) for row in sources)
            watermarks = {row["source"]: row["revision"] for row in sources}
            invalid = invalid or any(not isinstance(row["token"], str) or re.fullmatch(r"[a-f0-9]{32}", row["token"]) is None or
                                     not integer(row["created"]) or row["created"] > control["clock"] or
                                     not integer(row["revision"], 1, 2 ** 53 - 1) or
                                     row["revision"] > watermarks.get(row["source"], -1) or
                                     row["status"] not in {"reserved", "delivered", "failed", "unknown"} for row in attempts)
        except (IndexError, TypeError, ValueError, RecursionError):
            invalid = True
        if invalid:
            raise GateError("invalid_state")

    def status(self):
        """Bounded metadata only; no candidate or notification text is persisted."""
        with self.transaction() as db:
            controls = dict(db.execute("SELECT paused, snooze, focus FROM control WHERE id=1").fetchone())
            controls["paused"] = bool(controls["paused"])
            controls["focus"] = json.loads(controls["focus"]) if controls["focus"] is not None else None
            controls["muted_sources"] = [row[0] for row in db.execute("SELECT source FROM sources WHERE muted=1 ORDER BY source")]
            controls["attempts"] = db.execute("SELECT count(*) FROM attempts").fetchone()[0]
            return controls

    def control(self, value, now=None):
        """Caller must authenticate an explicit user/operator control request first."""
        now = int(time.time()) if now is None else now
        if not integer(now) or not isinstance(value, dict):
            raise GateError("invalid_control")
        action = value.get("action")
        extras = {"snooze": {"until"}, "focus": {"topics"}, "mute": {"source"}, "unmute": {"source"}}
        if not isinstance(action, str) or action not in {"pause", "resume", "snooze", "focus", "unfocus", "mute", "unmute"} or set(value) != {"action"} | extras.get(action, set()):
            raise GateError("invalid_control")
        if ((action == "snooze" and (not integer(value["until"], now + 1, min(MAX_TIME, now + 30 * 86400)))) or
                (action == "focus" and not slugs(value["topics"])) or
                (action in {"mute", "unmute"} and value["source"] not in self.settings["sources"])):
            raise GateError("invalid_control")
        with self.transaction() as db:
            clock = db.execute("SELECT clock FROM control WHERE id=1").fetchone()[0]
            if now < clock:
                raise GateError("clock_rollback")
            db.execute("UPDATE control SET clock=? WHERE id=1", (now,))
            if action == "pause":
                db.execute("UPDATE control SET paused=1 WHERE id=1")
            elif action == "resume":
                db.execute("UPDATE control SET paused=0, snooze=0 WHERE id=1")
            elif action == "snooze":
                db.execute("UPDATE control SET snooze=? WHERE id=1", (value["until"],))
            elif action in {"focus", "unfocus"}:
                db.execute("UPDATE control SET focus=? WHERE id=1", (json.dumps(value["topics"]) if action == "focus" else None,))
            else:
                self.source(db, value["source"])
                db.execute("UPDATE sources SET muted=? WHERE source=?", (int(action == "mute"), value["source"]))
        return {"changed": True}

    @staticmethod
    def source(db, name):
        row = db.execute("SELECT revision, muted FROM sources WHERE source=?", (name,)).fetchone()
        if row is None:
            if db.execute("SELECT count(*) FROM sources").fetchone()[0] >= MAX_SOURCES:
                raise GateError("source_capacity")
            db.execute("INSERT INTO sources VALUES (?, 0, 0)", (name,))
            return {"revision": 0, "muted": 0}
        return row

    def evaluate(self, candidate, *, claim=False, now=None):
        """Recheck current policy/controls and reserve durably BEFORE transport handoff."""
        item = prepare(candidate)
        now = int(time.time()) if now is None else now
        if not integer(now):
            raise GateError("invalid_time")
        config = self.settings
        def silent(reason):
            return {"decision": "silent", "reason": reason}
        if item["owner"] != self.owner:
            return silent("owner_mismatch")
        if not config["enabled"]:
            return silent("disabled")
        if item["source"] not in config["sources"]:
            return silent("source_not_authorized")
        if not item["meaningful"]:
            return silent("no_meaningful_change")
        if item["observed_at"] > now or now >= item["expires_at"] or now - item["observed_at"] > config["maximum_age_seconds"]:
            return silent("stale_or_future")
        local = datetime.fromtimestamp(now, ZoneInfo(config["timezone"]))
        start, end = minute(config["quiet_start"]), minute(config["quiet_end"])
        current = local.hour * 60 + local.minute
        if (start < end and start <= current < end) or (start > end and (current >= start or current < end)):
            return silent("quiet_hours")
        with self.transaction() as db:
            controls = db.execute("SELECT * FROM control WHERE id=1").fetchone()
            if now < controls["clock"]:
                return silent("clock_rollback")
            if controls["paused"]:
                return silent("paused")
            if now < controls["snooze"]:
                return silent("snoozed")
            focus = config["focus"] if controls["focus"] is None else json.loads(controls["focus"])
            if focus and item["topic"] not in focus:
                return silent("outside_focus")
            source = db.execute("SELECT revision, muted FROM sources WHERE source=?", (item["source"],)).fetchone()
            if source and source["muted"]:
                return silent("source_muted")
            if source and item["revision"] <= source["revision"]:
                return silent("already_attempted")
            attempts = list(db.execute("SELECT created FROM attempts ORDER BY created DESC LIMIT ?", (MAX_ATTEMPTS,)))
            if attempts and now - attempts[0][0] < config["minimum_interval_seconds"]:
                return silent("frequency_limit")
            if sum(datetime.fromtimestamp(row[0], ZoneInfo(config["timezone"])).date() == local.date() for row in attempts) >= config["daily_limit"]:
                return silent("daily_limit")
            if not claim:
                return {"decision": "eligible"}
            # Pruning receipts cannot resurrect an old revision: per-source watermarks never expire.
            db.execute("DELETE FROM attempts WHERE created < ?", (now - 3 * 86400,))
            if db.execute("SELECT count(*) FROM attempts").fetchone()[0] >= MAX_ATTEMPTS:
                return silent("attempt_capacity")
            self.source(db, item["source"])
            token = uuid.uuid4().hex
            db.execute("UPDATE sources SET revision=? WHERE source=?", (item["revision"], item["source"]))
            db.execute("INSERT INTO attempts VALUES (?, ?, ?, ?, 'reserved')", (token, item["source"], item["revision"], now))
            db.execute("UPDATE control SET clock=? WHERE id=1", (now,))
            return {"decision": "send", "token": token, "owner": self.owner, "message": item["message"], "created_at": now,
                    "valid_until": min(item["expires_at"], item["observed_at"] + config["maximum_age_seconds"] + 1,
                                       now + 5, now + 60 - local.second)}

    def record(self, token, outcome):
        if (not isinstance(token, str) or re.fullmatch(r"[a-f0-9]{32}", token) is None or
                not isinstance(outcome, str) or outcome not in {"delivered", "failed", "unknown"}):
            raise GateError("invalid_result")
        with self.transaction() as db:
            row = db.execute("SELECT status FROM attempts WHERE token=?", (token,)).fetchone()
            if not row:
                raise GateError("unknown_attempt")
            if row[0] not in {"reserved", outcome}:
                raise GateError("conflicting_result")
            db.execute("UPDATE attempts SET status=? WHERE token=?", (outcome, token))
        return {"recorded": True}

    def deliver(self, candidate, send, *, clock=time.time):
        """Optional synchronous adapter: send(owner, message, token), once, never retry.

        A transport must return exactly True for confirmed success, False for a
        confirmed failure, or anything else for an ambiguous result. Exceptions
        remain ambiguous. No transport exception or message enters persistent state.
        """
        permit = self.evaluate(candidate, claim=True, now=int(clock()))
        if permit["decision"] != "send":
            return permit
        now = int(clock())
        if not permit["created_at"] <= now < permit["valid_until"]:
            self.record(permit["token"], "unknown")
            return {"decision": "silent", "reason": "handoff_expired"}
        try:
            result = send(permit["owner"], permit["message"], permit["token"])
            outcome = "delivered" if result is True else "failed" if result is False else "unknown"
        except Exception:
            outcome = "unknown"
        self.record(permit["token"], outcome)
        return {"decision": "attempted", "outcome": outcome}


def main():
    class SafeParser(argparse.ArgumentParser):
        def error(self, _message):
            print(json.dumps({"schema_version": 1, "ok": False, "error": "invalid_arguments"}))
            raise SystemExit(2)
    parser = SafeParser(description=__doc__)
    parser.add_argument("--state-home", required=True, type=Path)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("action", choices=("prepare", "check", "claim", "control", "record", "status"))
    args = parser.parse_args()
    try:
        # Operator config is private and explicit; never read Hermes/provider credentials.
        gate = Gate(args.state_home, args.owner, decode(private_file(args.config)))
        request = None if args.action == "status" else decode(sys.stdin.buffer.read(MAX_BYTES + 1))
        if args.action == "prepare":
            prepare(request)
            result = {"prepared": True}
        elif args.action in {"check", "claim"}:
            result = gate.evaluate(request, claim=args.action == "claim")
        elif args.action == "control":
            result = gate.control(request)
        elif args.action == "record":
            if not isinstance(request, dict) or set(request) != {"token", "outcome"}:
                raise GateError("invalid_result")
            result = gate.record(**request)
        else:
            result = gate.status()
        print(json.dumps({"schema_version": 1, "ok": True, "data": result}, ensure_ascii=True))
        return 0
    except (GateError, OSError, sqlite3.Error) as error:
        code = str(error) if isinstance(error, GateError) else "storage_unavailable"
        print(json.dumps({"schema_version": 1, "ok": False, "error": code}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
