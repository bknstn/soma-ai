"""Fully synthetic gate contracts; no Hermes state, health files or network."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "runtimes/hermes/heartbeat-gate.py"
spec = importlib.util.spec_from_file_location("soma_heartbeat_gate", MODULE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def timestamp(value):
    return int(datetime.fromisoformat(value).timestamp())


class GateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soma-heartbeat-test-")
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "gate"
        self.now = timestamp("2026-10-27T12:00:00+00:00")
        self.config = {"enabled": True, "sources": ["synthetic-preparation"],
                       "timezone": "Europe/Warsaw", "minimum_interval_seconds": 60}
        self.service = gate.Gate(self.home, "telegram:1001", self.config)
        self.item = {"schema_version": 1, "owner": "telegram:1001", "source": "synthetic-preparation", "revision": 1,
                     "topic": "planning", "observed_at": self.now - 10, "expires_at": self.now + 300,
                     "meaningful": True, "message": "A synthetic preparation needs your review."}
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.temp.cleanup()
        self.assertFalse(self.root.exists())

    def evaluate(self, **changes):
        return self.service.evaluate({**self.item, **changes}, now=self.now)

    def claim(self, **changes):
        return self.service.evaluate({**self.item, **changes}, claim=True, now=self.now)

    def reason(self, expected, result):
        self.assertEqual(result, {"decision": "silent", "reason": expected})

    def control(self, **value):
        return self.service.control(value, now=self.now)

    def test_prepare_is_private_and_not_delivery_permission(self):
        self.assertEqual(gate.prepare(self.item), self.item)
        self.assertFalse(self.home.exists())
        disabled = gate.Gate(self.home, "telegram:1001", {})
        self.reason("disabled", disabled.evaluate(self.item, claim=True, now=self.now))
        self.reason("owner_mismatch", self.evaluate(owner="telegram:1002"))
        self.reason("source_not_authorized", self.evaluate(source="other-source"))
        self.reason("no_meaningful_change", self.evaluate(meaningful=False))
        self.assertFalse(self.home.exists())

    def test_validation_strict_and_bounded(self):
        for patch_data in ({"enabled": "true"}, {"schema_version": True}, {"daily_limit": True}, {"daily_limit": 33},
                           {"timezone": "Missing/Zone"}, {"timezone": []}, {"quiet_start": "24:00"},
                           {"quiet_end": "8:00"}, {"minimum_interval_seconds": 1}, {"maximum_age_seconds": 1.2},
                           {"sources": ["bad/source"]}, {"sources": ["same", "same"]}, {"focus": "planning"},
                           {"unknown": 1}):
            with self.subTest(policy=patch_data), self.assertRaises(gate.GateError):
                gate.policy(patch_data)
        for patch_data in ({"schema_version": True}, {"revision": True}, {"revision": 0}, {"revision": 2 ** 53},
                           {"meaningful": "yes"}, {"message": " "}, {"message": "x" * 501}, {"message": "a\nb"},
                           {"observed_at": float("nan")}, {"owner": "telegram:0"}, {"topic": []}, {"extra": 1}):
            with self.subTest(candidate=patch_data), self.assertRaises(gate.GateError):
                gate.prepare({**self.item, **patch_data})
        for raw in (b'{"enabled":true,"enabled":false}', b'{"a":NaN}', b'{', b'X' * 8193):
            with self.assertRaises(gate.GateError):
                gate.decode(raw)
        self.assertFalse(self.home.exists())

    def test_published_schema_defaults_and_example_match_gate(self):
        schema = json.loads((ROOT / "runtimes/hermes/heartbeat-policy.schema.json").read_bytes())
        self.assertEqual({name: item["default"] for name, item in schema["properties"].items()}, gate.DEFAULTS)
        candidate = json.loads((ROOT / "runtimes/hermes/heartbeat-candidate.schema.json").read_bytes())
        self.assertEqual(set(candidate["required"]), set(self.item))
        sample = json.loads((ROOT / "examples/heartbeat-policy.json").read_bytes())
        self.assertEqual(gate.policy(sample), sample)
        self.assertFalse(sample["enabled"])

    def test_stale_future_and_expiry_boundaries(self):
        self.reason("stale_or_future", self.evaluate(observed_at=self.now + 1))
        self.reason("stale_or_future", self.evaluate(expires_at=self.now))
        self.reason("stale_or_future", self.evaluate(observed_at=self.now - 7201))
        self.assertEqual(self.evaluate(observed_at=self.now - 7200)["decision"], "eligible")

    def test_dry_check_never_claims_or_returns_message(self):
        self.assertEqual(self.evaluate(), {"decision": "eligible"})
        self.assertEqual(self.evaluate(), {"decision": "eligible"})
        self.assertEqual(self.service.status()["attempts"], 0)
        self.assertEqual(self.claim()["decision"], "send")

    def test_restart_ambiguous_failure_and_result_idempotence(self):
        permit = self.claim()
        self.assertEqual(permit["valid_until"], self.now + 5)
        self.service = gate.Gate(self.home, "telegram:1001", self.config)
        self.reason("already_attempted", self.claim())
        self.service.record(permit["token"], "unknown")
        self.service.record(permit["token"], "unknown")
        with self.assertRaises(gate.GateError):
            self.service.record(permit["token"], "delivered")
        self.reason("already_attempted", self.claim(message="Reworded synthetic proposal"))
        for result in ({"token": [], "outcome": "failed"}, {"token": permit["token"], "outcome": []}):
            with self.assertRaises(gate.GateError):
                self.service.record(**result)

    def test_concurrent_workers_reserve_exactly_once(self):
        def claim(_):
            return gate.Gate(self.home, "telegram:1001", self.config).evaluate(self.item, claim=True, now=self.now)
        # Initialize schema before exercising independent concurrent connections.
        self.service.status()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(claim, range(16)))
        self.assertEqual(sum(item["decision"] == "send" for item in results), 1)
        self.assertEqual(self.service.status()["attempts"], 1)

    def test_user_isolation_no_payload_in_storage(self):
        self.claim()
        other = gate.Gate(self.home, "telegram:1002", self.config)
        item = {**self.item, "owner": "telegram:1002"}
        self.assertEqual(other.evaluate(item, claim=True, now=self.now)["decision"], "send")
        for file in self.home.iterdir():
            self.assertNotIn(self.item["message"].encode(), file.read_bytes())
            self.assertNotIn(b"telegram:1001", file.read_bytes())
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)

    def test_pause_resume_snooze_focus_and_feedback_survive_restart(self):
        self.control(action="pause")
        self.service = gate.Gate(self.home, "telegram:1001", self.config)
        self.reason("paused", self.claim())
        self.control(action="snooze", until=self.now + 120)
        self.control(action="resume")
        self.assertEqual(self.evaluate()["decision"], "eligible")
        self.control(action="snooze", until=self.now + 60)
        self.reason("snoozed", self.claim())
        self.now += 60
        self.control(action="focus", topics=["habits"])
        self.reason("outside_focus", self.claim())
        self.control(action="unfocus")
        self.control(action="mute", source="synthetic-preparation")
        self.reason("source_muted", self.claim())
        self.control(action="unmute", source="synthetic-preparation")
        self.assertEqual(self.claim()["decision"], "send")

    def test_malformed_controls_do_not_mutate_state(self):
        before = self.service.status()
        for value in ({}, {"action": []}, {"action": "resume", "extra": True}, {"action": "snooze", "until": self.now},
                      {"action": "focus", "topics": ["bad topic"]}, {"action": "mute", "source": []},
                      {"action": "mute", "source": "other-source"}):
            with self.assertRaises(gate.GateError):
                self.service.control(value, now=self.now)
            self.assertEqual(self.service.status(), before)

    def test_rate_limits_count_failures_and_utc_elapsed_time(self):
        permit = self.claim()
        self.service.record(permit["token"], "failed")
        self.now += 59
        self.reason("frequency_limit", self.claim(revision=2))
        self.now += 1
        self.assertEqual(self.claim(revision=2)["decision"], "send")
        self.now += 60
        self.reason("daily_limit", self.claim(revision=3))

    def test_quiet_hours_dst_repeated_and_missing_hour(self):
        self.service = gate.Gate(self.home, "telegram:1001", {**self.config, "quiet_start": "01:30", "quiet_end": "03:30"})
        # Both occurrences of 02:30 on the autumn transition are quiet.
        for value in ("2026-10-25T00:30:00+00:00", "2026-10-25T01:30:00+00:00",
                      "2026-03-29T00:30:00+00:00", "2026-03-29T01:29:00+00:00"):
            now = timestamp(value)
            self.reason("quiet_hours", self.service.evaluate({**self.item, "observed_at": now, "expires_at": now + 100}, now=now))
        now = timestamp("2026-03-29T01:30:00+00:00")
        self.assertEqual(self.service.evaluate({**self.item, "observed_at": now, "expires_at": now + 100}, now=now)["decision"], "eligible")

    def test_cross_midnight_and_same_day_quiet_windows(self):
        for start, end, hour, quiet in (("22:00", "08:00", 22, True), ("22:00", "08:00", 0, True),
                                        ("22:00", "08:00", 8, False), ("12:00", "13:00", 12, True),
                                        ("12:00", "13:00", 13, False), ("00:00", "00:00", 0, False)):
            service = gate.Gate(self.home, "telegram:1001", {**self.config, "timezone": "UTC", "quiet_start": start, "quiet_end": end})
            now = timestamp(f"2026-10-27T{hour:02d}:00:00+00:00")
            result = service.evaluate({**self.item, "observed_at": now, "expires_at": now + 60}, now=now)
            self.assertEqual(result["decision"], "silent" if quiet else "eligible")

    def test_local_day_cap_and_permit_end_at_midnight(self):
        settings = {**self.config, "quiet_start": "00:00", "quiet_end": "00:00", "daily_limit": 1}
        self.service = gate.Gate(self.home, "telegram:1001", settings)
        self.now = timestamp("2026-10-27T22:59:59+00:00")  # Warsaw 23:59:59.
        self.item.update(observed_at=self.now, expires_at=self.now + 300)
        permit = self.claim()
        self.assertEqual(permit["valid_until"], self.now + 1)
        self.now += 60
        self.assertEqual(self.claim(revision=2)["decision"], "send")

    def test_pruning_does_not_reset_highwater_and_clock_rollback_is_silent(self):
        self.claim(revision=50)
        self.now -= 1
        self.reason("clock_rollback", self.claim(revision=51))
        with self.assertRaisesRegex(gate.GateError, "clock_rollback"):
            self.control(action="resume")
        self.now += 4 * 86400
        self.item.update(observed_at=self.now, expires_at=self.now + 300)
        self.assertEqual(self.claim(revision=51)["decision"], "send")
        self.assertEqual(self.service.status()["attempts"], 1)
        self.reason("already_attempted", self.claim(revision=50))

    def test_source_watermarks_survive_disable_remove_and_reenable(self):
        self.claim()
        gate.Gate(self.home, "telegram:1001", {}).status()
        self.service = gate.Gate(self.home, "telegram:1001", self.config)
        self.reason("already_attempted", self.claim())
        with self.service.transaction() as db:
            for number in range(15):
                self.service.source(db, f"source-{number}")
        with self.assertRaisesRegex(gate.GateError, "source_capacity"):
            with self.service.transaction() as db:
                self.service.source(db, "source-overflow")

    def test_transport_receives_committed_permit_and_never_retries(self):
        called = []
        def send(owner, message, token):
            called.append((owner, message))
            # Simulate a second process or a crash at network handoff.
            self.reason("already_attempted", self.claim())
            raise OSError("SYNTHETIC_PRIVATE_TRANSPORT_DETAIL")
        result = self.service.deliver(self.item, send, clock=lambda: self.now)
        self.assertEqual(result, {"decision": "attempted", "outcome": "unknown"})
        self.assertEqual(called, [(self.item["owner"], self.item["message"])])
        self.reason("already_attempted", self.service.deliver(self.item, send, clock=lambda: self.now))
        self.assertEqual(len(called), 1)
        for file in self.home.iterdir():
            self.assertNotIn(b"SYNTHETIC_PRIVATE", file.read_bytes())

    def test_delayed_handoff_expires_without_transport_or_retry(self):
        clock = iter([self.now, self.now + 5])
        self.reason("handoff_expired", self.service.deliver(self.item, lambda *_: self.fail("expired send"), clock=lambda: next(clock)))
        self.reason("already_attempted", self.claim())

    def test_clock_rollback_at_short_permit_does_not_send(self):
        self.now = timestamp("2026-10-27T12:00:59+00:00")
        self.item.update(observed_at=self.now, expires_at=self.now + 100)
        clock = iter([self.now, self.now - 1])
        self.reason("handoff_expired", self.service.deliver(self.item, lambda *_: self.fail("backward send"), clock=lambda: next(clock)))

    def test_evidence_becoming_stale_before_handoff_does_not_send(self):
        self.service = gate.Gate(self.home, "telegram:1001", {**self.config, "maximum_age_seconds": 60})
        self.item.update(observed_at=self.now - 60)
        clock = iter([self.now, self.now + 1])
        self.reason("handoff_expired", self.service.deliver(self.item, lambda *_: self.fail("stale send"), clock=lambda: next(clock)))

    def test_readable_but_corrupt_metadata_is_refused_without_repair(self):
        self.service.status()
        file = next(self.home.glob("*.sqlite"))
        with closing(sqlite3.connect(file)) as db:
            db.execute("UPDATE control SET focus='SYNTHETIC_BAD_JSON'")
            db.commit()
        before = file.read_bytes()
        with self.assertRaisesRegex(gate.GateError, "invalid_state"):
            self.claim()
        self.assertEqual(file.read_bytes(), before)

    def test_quiet_boundary_during_handoff_and_confirmation_results(self):
        self.now = timestamp("2026-10-27T20:59:59+00:00")  # Quiet starts at Warsaw 22:00.
        self.item.update(observed_at=self.now, expires_at=self.now + 100)
        clock = iter([self.now, self.now + 1])
        self.reason("handoff_expired", self.service.deliver(self.item, lambda *_: self.fail("quiet send"), clock=lambda: next(clock)))
        self.now += 12 * 3600
        self.item.update(observed_at=self.now, expires_at=self.now + 100, revision=2)
        self.assertEqual(self.service.deliver(self.item, lambda *_: True, clock=lambda: self.now),
                         {"decision": "attempted", "outcome": "delivered"})
        self.now += 60
        self.item.update(observed_at=self.now, expires_at=self.now + 100, revision=3)
        self.assertEqual(self.service.deliver(self.item, lambda *_: False, clock=lambda: self.now),
                         {"decision": "attempted", "outcome": "failed"})

    def test_unsafe_storage_symlink_hardlink_permissions_version_and_corruption(self):
        self.service.status()
        file = next(self.home.glob("*.sqlite"))
        original = file.read_bytes()
        file.chmod(0o644)
        with self.assertRaises(gate.GateError):
            self.service.status()
        file.chmod(0o600)
        linked = self.root / "linked"
        os.link(file, linked)
        with self.assertRaises(gate.GateError):
            self.service.status()
        linked.unlink()
        file.unlink()
        file.symlink_to(self.root / "never-create")
        with self.assertRaises(OSError):
            self.service.status()
        self.assertFalse((self.root / "never-create").exists())
        file.unlink()
        file.write_bytes(original)
        file.chmod(0o600)
        with closing(sqlite3.connect(file)) as db:
            db.execute("PRAGMA user_version=2")
        with self.assertRaisesRegex(gate.GateError, "unsupported_version"):
            self.service.status()
        file.write_bytes(b"synthetic invalid database")
        with self.assertRaises(sqlite3.DatabaseError):
            self.service.status()
        self.assertEqual(file.read_bytes(), b"synthetic invalid database")
        self.home.chmod(0o755)
        with self.assertRaises(gate.GateError):
            self.service.status()
        for path in (ROOT / "synthetic-state", self.root / ".hermes", self.root / ".health-os"):
            with self.assertRaises(gate.GateError):
                gate.Gate(path, "telegram:1001", self.config).status()
            self.assertFalse(path.exists())

    def test_cli_bounded_json_no_secret_errors_and_no_network(self):
        config = self.root / "policy.json"
        config.write_text(json.dumps(self.config))
        config.chmod(0o600)
        args = [sys.executable, "-I", "-B", str(MODULE), "--state-home", str(self.home), "--config", str(config), "--owner", "telegram:1001"]
        # Preparation does not persist state or echo the message.
        result = subprocess.run([*args, "prepare"], input=json.dumps(self.item), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.item["message"], result.stdout)
        self.assertFalse(self.home.exists())
        result = subprocess.run([*args, "claim"], input="SYNTHETIC_PRIVATE_BAD_INPUT", capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"], "invalid_json")
        self.assertNotIn("SYNTHETIC_PRIVATE", result.stdout + result.stderr)
        result = subprocess.run([*args, "SYNTHETIC_PRIVATE_BAD_ACTION"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"], "invalid_arguments")
        self.assertNotIn("SYNTHETIC_PRIVATE", result.stdout + result.stderr)
        with patch.object(socket.socket, "connect", side_effect=AssertionError("offline")), \
                patch.object(socket, "getaddrinfo", side_effect=AssertionError("offline")):
            self.assertEqual(self.evaluate()["decision"], "eligible")


if __name__ == "__main__":
    unittest.main()
