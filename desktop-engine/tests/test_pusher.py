"""Pusher tests against the TEST-ONLY mock: ordering, retries, dedup replay."""

from __future__ import annotations

import threading
import time

import pytest

from taskly_live.api import ApiError, Segment
from taskly_live.mock_server import MockServer
from taskly_live.pusher import Pusher


def seg(seq: int, source="mic", text=None, start=None) -> Segment:
    return Segment(
        seq=seq, source=source, lang="en", text=text or f"u{seq}",
        text_en=text or f"u{seq}", started_ms=start, ended_ms=start,
    )


def wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def arrival_seqs(mock: MockServer, sid: str) -> list[int]:
    return [seq for method, session, seq in mock.state.arrival
            if method == "push" and session == sid]


class TestWorkerDelivery:
    def test_semantics_order_and_ack(self, client, journal, mock):
        client.create_session("T", "2026-10-22")
        sid = mock.state.sessions and next(iter(mock.state.sessions))
        journal.ensure_session(sid, "T", "2026-10-22", 0)
        seqs = []
        for src in ("mic", "system", "mic", "system"):
            seqs.append(journal.append(sid, source=src, lang="en", text=f"u{len(seqs)}",
                                       text_en=f"u{len(seqs)}", started_ms=len(seqs) * 100,
                                       ended_ms=len(seqs) * 100 + 50))
        pusher = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1))
        pusher.start()
        assert wait_until(lambda: journal.counts(sid)["acked"] == 4), journal.counts(sid)

        arrivals = arrival_seqs(mock, sid)
        assert arrivals == sorted(arrivals), "server received strictly ascending seq"
        assert len(set(arrivals)) == 4, "no duplicate deliveries"
        assert journal.counts(sid) == {"pending": 0, "acked": 4, "failed": 0}
        pusher.stop(drain_timeout=5.0)

    def test_batches_respect_limit(self, client, journal, mock):
        s = client.create_session("Bulk", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Bulk", "2026-10-22", 0)
        for i in range(230):
            journal.append(sid, source="mic", lang="en", text=f"bulk {i}",
                           text_en=f"bulk {i}", started_ms=i, ended_ms=i)
        pusher = Pusher(client, journal, sid, coalesce_s=0.0, batch_limit=200,
                        backoff=(0.05, 0.1))
        pusher.start()
        assert wait_until(lambda: journal.counts(sid)["acked"] == 230, 10.0), \
            journal.counts(sid)
        assert len(mock.state.sessions[sid]["segments"]) == 230
        pusher.stop(drain_timeout=5.0)


class TestRetryLadder:
    def test_retries_on_429_then_acks(self, client, journal, mock):
        s = client.create_session("Retry", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Retry", "2026-10-22", 0)
        journal.append(sid, source="mic", lang="en", text="hello", text_en="hello",
                       started_ms=0, ended_ms=100)
        mock.state.fail_next.append((429, 2))  # two transient failures

        pusher = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1))
        pusher.start()
        assert wait_until(lambda: journal.counts(sid)["acked"] == 1, 10.0), \
            journal.counts(sid)
        assert pusher.retried_batches >= 1, "injected 429s forced at least one retry"
        pusher.stop(drain_timeout=5.0)

    def test_fatal_401_marks_failed_not_lost(self, client, journal, mock):
        s = client.create_session("Fatal", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Fatal", "2026-10-22", 0)
        journal.append(sid, source="mic", lang="en", text="hello", text_en="hello",
                       started_ms=0, ended_ms=100)
        mock.state.fail_next.append((401, 10))  # persistent auth death
        pusher = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1))
        pusher.start()
        assert wait_until(lambda: journal.counts(sid)["failed"] == 1, 10.0)
        assert journal.counts(sid)["acked"] == 0
        # rows preserved: requeue -> pending -> new pusher delivers them.
        # (First clear the fault injection: it simulates expired bad creds.)
        mock.state.fail_next.clear()
        assert journal.requeue_failed(sid) == 1
        pusher2 = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1))
        pusher2.start()
        assert wait_until(lambda: journal.counts(sid)["acked"] == 1, 10.0)
        assert journal.counts(sid) == {"pending": 0, "acked": 1, "failed": 0}
        pusher2.stop(drain_timeout=5.0)
        pusher.stop(drain_timeout=0)


class TestIdempotentReplay:
    def test_crash_replay_is_idempotent_and_ordered(self, client, journal, mock):
        """Simulate: rows appended (append-before-send), engine dies before
        ack, new engine (same journal) replays them -> server stores each
        (session, seq) exactly once, in monotonic arrival order."""
        s = client.create_session("Replay", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Replay", "2026-10-22", 0)
        for i in range(6):
            source = "mic" if i % 2 == 0 else "system"
            journal.append(sid, source=source, lang="en", text=f"line {i}",
                           text_en=f"line {i}", started_ms=i * 250,
                           ended_ms=i * 250 + 200)

        # "crash": rows sent but ack lost -> re-mark all pending and replay
        rows_first_pass = Pusher(client, journal, sid, coalesce_s=0.0,
                                 backoff=(0.05, 0.1))
        rows_first_pass.start()
        assert wait_until(lambda: journal.counts(sid)["acked"] == 6)
        rows_first_pass.stop(drain_timeout=5.0)

        # Re-push the same rows (crash between response and ack): server
        # dedupes; engine receipts stay the single source of truth.
        rows = journal.pending(sid, 200)  # empty: acked locally
        assert rows == []
        outcome = client.push(
            sid, [seg(1), seg(2), seg(3)]
        )  # raw duplicates through the same key
        assert outcome.accepted == 0
        assert outcome.last_seq == 6
        assert len(mock.state.sessions[sid]["segments"]) == 6

        arrivals = arrival_seqs(mock, sid)
        assert len(arrivals) == 9  # 6 unique + 3 duplicate receipts recorded
        assert arrivals[:6] == [1, 2, 3, 4, 5, 6], (
            "first pass arrived in strictly increasing order"
        )
        assert sorted(set(mock.state.sessions[sid]["segments"].keys())) == [1, 2, 3, 4, 5, 6]

    def test_drain_sync_path(self, client, journal, mock):
        s = client.create_session("Sync", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Sync", "2026-10-22", 0)
        pusher = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1))
        pusher.drain()  # nothing pending: no-op, no error
        journal.append(sid, source="mic", lang="en", text="one", text_en="one",
                       started_ms=0, ended_ms=100)
        journal.append(sid, source="system", lang="ar", text="اثنان", text_en="two",
                       started_ms=200, ended_ms=300)
        pusher.drain()
        assert journal.counts(sid)["acked"] == 2

    def test_network_error_is_retryable(self, client, journal, mock):
        s = client.create_session("Net", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Net", "2026-10-22", 0)
        # Unknown session -> 404; simulate by pushing to a bogus session id.
        other = Pusher(client, journal, "does-not-exist", coalesce_s=0.0,
                       backoff=(0.05, 0.1))
        journal.ensure_session("does-not-exist", "Ghost", "2026-10-22", 0)
        journal.append("does-not-exist", source="mic", lang="en", text="x",
                       text_en="x", started_ms=None, ended_ms=None)
        with pytest.raises(ApiError):
            other.drain(deadline=time.monotonic() + 2.0)
        other.stop(drain_timeout=0)
        # 404 is fatal: row(s) preserved as failed
        assert journal.counts("does-not-exist")["failed"] >= 1
        assert journal.requeue_failed("does-not-exist") >= 1


class TestWakeLatency:
    def test_wake_pushes_within_coalesce_window(self, client, journal, mock):
        s = client.create_session("Wake", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Wake", "2026-10-22", 0)
        pusher = Pusher(client, journal, sid, coalesce_s=1.0, backoff=(0.05, 0.1))
        pusher.start()
        time.sleep(0.3)  # let it settle into its wait
        t0 = time.monotonic()
        journal.append(sid, source="mic", lang="en", text="wake", text_en="wake",
                       started_ms=0, ended_ms=100)
        pusher.wake()
        ok = wait_until(lambda: journal.counts(sid)["acked"] == 1, timeout=3.5)
        dt = time.monotonic() - t0
        assert ok, journal.counts(sid)
        assert dt < 1.5, "wake() should push without waiting the full window"
        pusher.stop(drain_timeout=5.0)


class TestArabicLine:
    def test_text_ar_reaches_the_server(self, client, journal, mock):
        s = client.create_session("Ar", "2026-10-22")
        sid = s["id"]
        journal.ensure_session(sid, "Ar", "2026-10-22", 0)
        journal.append(sid, source="mic", lang="en", text="hello", text_en="hello",
                       started_ms=0, ended_ms=100, text_ar="مرحبا")
        journal.append(sid, source="mic", lang="en", text="plain", text_en="plain",
                       started_ms=200, ended_ms=300)
        Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.05, 0.1)).drain()
        stored = mock.state.sessions[sid]["segments"]
        assert stored[1]["text_ar"] == "مرحبا"
        assert stored[2]["text_ar"] is None
        assert journal.counts(sid)["acked"] == 2
