"""Bounded assistant metadata, separate from transcripts, health data and delivery receipts."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import stat


class State:
    def __init__(self, home):
        self.home = Path(home)

    @contextmanager
    def transaction(self):
        home = self.home
        if not home.is_absolute() or home.resolve() != home or home.is_symlink() or not home.is_dir():
            raise ValueError("Unavailable assistant home")
        directory = home / "soma-assistant"
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("Unsafe assistant directory")
        filename = directory / "metadata.sqlite"
        fd = os.open(filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024:
                raise ValueError("Unsafe assistant file")
        finally:
            os.close(fd)
        for suffix in ("-journal", "-wal", "-shm"):
            sidecar = Path(str(filename) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                info = sidecar.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024:
                    raise ValueError("Unsafe assistant sidecar")
        db = sqlite3.connect(filename, timeout=2, isolation_level=None)
        try:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("PRAGMA max_page_count=512")
            db.execute("BEGIN IMMEDIATE")
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise ValueError("Unsupported assistant version")
            db.execute("CREATE TABLE IF NOT EXISTS owners (owner TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute("PRAGMA user_version=1")
            yield db
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def update(self, owner, change):
        if not isinstance(owner, str) or not owner.startswith("telegram:") or not owner[9:].isdigit() or not 1 <= len(owner[9:]) <= 20:
            raise ValueError("Invalid owner")
        with self.transaction() as db:
            row = db.execute("SELECT data FROM owners WHERE owner=?", (owner,)).fetchone()
            if row is None and db.execute("SELECT count(*) FROM owners").fetchone()[0] >= 64:
                raise ValueError("Assistant capacity reached")
            raw = row[0] if row else "{}"
            if len(raw) > 16384:
                raise ValueError("Invalid metadata")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("Invalid metadata")
            result = change(value)
            serialized = json.dumps(value, ensure_ascii=True)
            if len(serialized) > 16384:
                raise ValueError("Assistant metadata too large")
            if serialized != raw:
                db.execute("INSERT OR REPLACE INTO owners VALUES (?,?)", (owner, serialized))
            return result

    def get(self, owner):
        return self.update(owner, lambda value: dict(value))

    def subscribers(self):
        # This index contains explicit subscriptions, never continuity or health records.
        with self.transaction() as db:
            rows = db.execute("SELECT owner FROM owners WHERE json_extract(data, '$.subscribed')=1 ORDER BY owner LIMIT 64")
            return [row[0] for row in rows]


def consume(value, message, session, day, route, key):
    if type(message) is not int or message <= value.get("message", 0):
        return None
    old = dict(value)
    # A backwards wall clock must not erase the last observed local day.
    recorded_day = max(value.get("day", day), day) if value.get("session") == session else day
    value.update(message=message, session=session, day=recorded_day, route=route, key=key)
    return old
