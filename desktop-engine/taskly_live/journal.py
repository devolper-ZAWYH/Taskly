"""Append-before-send SQLite journal of utterances (crash-safe delivery).

Every completed utterance is written here BEFORE its first push attempt.
The pusher picks up rows in strictly ascending ``seq`` order, so delivery
receives a monotonic stream even when sources interleave (per-source
subsequences are monotonic; ``seq`` is a single session-global counter the
engine assigns on journal append, matching the server's
``UNIQUE(session_id, seq)`` idempotency key).

State machine per row:
    pending --(server 200)--> acked      terminal
    pending --(fatal 4xx)---> failed     kept for inspection / requeue
    failed  --(requeue)-----> pending

WAL + ``synchronous=FULL``: a power cut or hard kill loses nothing that was
appended; on the next start the pending rows replay against the idempotent
server (duplicates simply no-op).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    date        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('capturing','ended')),
    t0_ms       INTEGER NOT NULL,          -- wallclock epoch ms of start
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('mic','system')),
    lang        TEXT,
    text        TEXT NOT NULL,
    text_en     TEXT,
    text_ar     TEXT,
    started_ms  INTEGER,
    ended_ms    INTEGER,
    state       TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','acked','failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS segments_state ON segments (session_id, state, seq);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass(frozen=True)
class JournalRow:
    """One journalled utterance as the pusher sees it."""

    session_id: str
    seq: int
    source: str
    lang: str | None
    text: str
    text_en: str | None
    started_ms: int | None
    ended_ms: int | None
    attempts: int
    text_ar: str | None = None


@dataclass(frozen=True)
class SessionRow:
    session_id: str
    title: str
    date: str
    status: str
    t0_ms: int


class Journal:
    """Thread-safe SQLite journal (append-before-send)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._con = sqlite3.connect(
            str(self.path), check_same_thread=False, isolation_level=None
        )
        self._con.row_factory = sqlite3.Row
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.execute("PRAGMA synchronous=FULL")
        self._con.execute("PRAGMA busy_timeout=5000")
        with self._lock:
            self._con.executescript(SCHEMA)
            # Journals written before the Arabic line existed lack the column.
            cols = {r["name"] for r in self._con.execute("PRAGMA table_info(segments)")}
            if "text_ar" not in cols:
                self._con.execute("ALTER TABLE segments ADD COLUMN text_ar TEXT")

    def close(self) -> None:
        with self._lock:
            self._con.close()

    # ---- sessions -------------------------------------------------------
    def ensure_session(self, session_id: str, title: str, date: str, t0_ms: int) -> None:
        """Register a session (created via the API or resumed from journal)."""
        with self._lock:
            self._con.execute(
                "INSERT INTO sessions (id, title, date, status, t0_ms, created_at) "
                "VALUES (?, ?, ?, 'capturing', ?, ?) "
                "ON CONFLICT(id) DO NOTHING",
                (session_id, title, date, t0_ms, _now_iso()),
            )

    def get_session(self, session_id: str) -> SessionRow | None:
        with self._lock:
            row = self._con.execute(
                "SELECT id, title, date, status, t0_ms FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        return SessionRow(row["id"], row["title"], row["date"], row["status"], row["t0_ms"])

    def open_sessions(self) -> list[SessionRow]:
        with self._lock:
            rows = self._con.execute(
                "SELECT id, title, date, status, t0_ms FROM sessions "
                "ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
        return [
            SessionRow(r["id"], r["title"], r["date"], r["status"], r["t0_ms"])
            for r in rows
        ]

    def set_session_status(self, session_id: str, status: str) -> None:
        with self._lock:
            self._con.execute(
                "UPDATE sessions SET status = ? WHERE id = ?", (status, session_id)
            )

    # ---- segments ---------------------------------------------------------
    def append(self, session_id: str, *, source: str, lang: str | None,
               text: str, text_en: str | None, started_ms: int | None,
               ended_ms: int | None, text_ar: str | None = None) -> int:
        """Insert an utterance with the next monotonic seq; returns the seq.

        Durable at return time (append-before-send, synchronous=FULL).
        """
        if source not in ("mic", "system"):
            raise ValueError(f"source must be mic|system, got {source!r}")
        if not text.strip():
            raise ValueError("cannot journal an empty utterance")
        with self._lock:
            row = self._con.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM segments "
                "WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next"])
            self._con.execute(
                "INSERT INTO segments (session_id, seq, source, lang, text, text_en, "
                "text_ar, started_ms, ended_ms, state, attempts, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
                (session_id, seq, source, lang, text, text_en, text_ar,
                 started_ms, ended_ms, _now_iso()),
            )
        return seq

    def segments(self, session_id: str) -> list[JournalRow]:
        """Every journalled utterance of a session, any state, in seq order
        (what the on-device summary reads)."""
        with self._lock:
            rows = self._con.execute(
                "SELECT session_id, seq, source, lang, text, text_en, text_ar, started_ms, "
                "ended_ms, attempts FROM segments WHERE session_id = ? ORDER BY seq ASC",
                (session_id,),
            ).fetchall()
        return [self._row(r) for r in rows]

    def pending(self, session_id: str, limit: int = 200) -> list[JournalRow]:
        return self._by_state(session_id, "pending", limit)

    def failed(self, session_id: str | None = None, limit: int = 200) -> list[JournalRow]:
        if session_id is None:
            return self._by_state_any_session("failed", limit)
        return self._by_state(session_id, "failed", limit)

    def _by_state(self, session_id: str, state: str, limit: int) -> list[JournalRow]:
        with self._lock:
            rows = self._con.execute(
                "SELECT session_id, seq, source, lang, text, text_en, text_ar, started_ms, "
                "ended_ms, attempts FROM segments WHERE session_id = ? AND state = ? "
                "ORDER BY seq ASC LIMIT ?",
                (session_id, state, limit),
            ).fetchall()
        return [self._row(r) for r in rows]

    def _by_state_any_session(self, state: str, limit: int) -> list[JournalRow]:
        with self._lock:
            rows = self._con.execute(
                "SELECT session_id, seq, source, lang, text, text_en, text_ar, started_ms, "
                "ended_ms, attempts FROM segments WHERE state = ? ORDER BY seq LIMIT ?",
                (state, limit),
            ).fetchall()
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(row: sqlite3.Row) -> JournalRow:
        return JournalRow(
            row["session_id"], row["seq"], row["source"], row["lang"], row["text"],
            row["text_en"], row["started_ms"], row["ended_ms"], row["attempts"],
            row["text_ar"],
        )

    def ack(self, session_id: str, seqs: list[int]) -> None:
        self._set_state(session_id, seqs, "acked")

    def mark_failed(self, session_id: str, seqs: list[int]) -> None:
        self._set_state(session_id, seqs, "failed")

    def mark_attempt(self, session_id: str, seqs: list[int]) -> None:
        """Bump attempts for retry accounting (backoff ladder)."""
        if not seqs:
            return
        marks = ",".join("?" for _ in seqs)
        with self._lock:
            self._con.execute(
                f"UPDATE segments SET attempts = attempts + 1 "
                f"WHERE session_id = ? AND seq IN ({marks})",
                (session_id, *seqs),
            )

    def requeue_failed(self, session_id: str | None = None) -> int:
        """Move failed rows back to pending (e.g. after fixing credentials)."""
        with self._lock:
            if session_id:
                cur = self._con.execute(
                    "UPDATE segments SET state = 'pending' "
                    "WHERE session_id = ? AND state = 'failed'",
                    (session_id,),
                )
            else:
                cur = self._con.execute(
                    "UPDATE segments SET state = 'pending' WHERE state = 'failed'"
                )
            return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

    def _set_state(self, session_id: str, seqs: list[int], state: str) -> None:
        if not seqs:
            return
        marks = ",".join("?" for _ in seqs)
        with self._lock:
            self._con.execute(
                f"UPDATE segments SET state = ? "
                f"WHERE session_id = ? AND seq IN ({marks})",
                (state, session_id, *seqs),
            )

    def counts(self, session_id: str | None = None) -> dict[str, int]:
        where, params = "", []  # type: ignore[var-annotated]
        if session_id:
            where = " WHERE session_id = ?"
            params = [session_id]
        with self._lock:
            rows = self._con.execute(
                f"SELECT state, COUNT(*) AS n FROM segments{where} GROUP BY state",
                params,
            ).fetchall()
        out = {"pending": 0, "acked": 0, "failed": 0}
        for row in rows:
            out[row["state"]] = row["n"]
        return out

    # For cross-process `stop`/`status` introspection -----------------------
    def session_summary(self) -> str:
        """Compact human-readable one-line-per-session summary."""
        lines = []
        for s in self.open_sessions():
            counts = self.counts(s.session_id)
            lines.append(
                f"  {s.session_id}  {s.status:9s} {s.date} {s.title!r}  "
                f"pending={counts['pending']} acked={counts['acked']} "
                f"failed={counts['failed']}"
            )
        return "\n".join(lines) if lines else "  (no sessions in journal)"

    def dump_debug(self) -> str:
        """Full journal row dump for `status --debug` triage."""
        return json.dumps(self.audit_snapshot(), ensure_ascii=False, default=str)

    def audit_snapshot(self) -> list[dict]:
        with self._lock:
            rows = self._con.execute(
                "SELECT session_id, seq, source, state, attempts, text FROM segments "
                "ORDER BY session_id, seq"
            ).fetchall()
        return [dict(r) for r in rows]
