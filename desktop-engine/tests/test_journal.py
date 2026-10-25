"""Journal state machine tests: seq assignment, ack/failed/requeue, persistence."""

from __future__ import annotations

import pytest

from taskly_live.journal import Journal


def rowdicts(rows):
    return [(r.seq, r.source, r.state if hasattr(r, "state") else None) for r in rows]


class TestSeqAssignment:
    def test_monotonic_seq_over_interleaved_sources(self, journal: Journal):
        journal.ensure_session("s1", "Meeting", "2026-10-22", t0_ms=0)
        got = []
        for source, text in [("mic", "one"), ("system", "two"), ("mic", "three"),
                             ("system", "four"), ("mic", "five")]:
            got.append(journal.append("s1", source=source, lang="en", text=text,
                                      text_en=text, started_ms=0, ended_ms=100))
        assert got == [1, 2, 3, 4, 5]

    def test_per_source_subsequence_monotonic(self, journal: Journal):
        journal.ensure_session("s1", "Meeting", "2026-10-22", t0_ms=0)
        mic, system = [], []
        for source, sink in [("mic", mic), ("system", system), ("mic", mic),
                             ("system", system), ("system", system)]:
            sink.append(journal.append("s1", source=source, lang="en", text="x",
                                       text_en="x", started_ms=0, ended_ms=10))
        assert mic == sorted(mic)
        assert system == sorted(system)

    def test_independent_sessions_independent_counters(self, journal: Journal):
        journal.ensure_session("s1", "A", "2026-10-22", t0_ms=0)
        journal.ensure_session("s2", "B", "2026-10-22", t0_ms=0)
        assert journal.append("s1", source="mic", lang="en", text="a", text_en="a",
                              started_ms=None, ended_ms=None) == 1
        assert journal.append("s2", source="mic", lang="en", text="b", text_en="b",
                              started_ms=None, ended_ms=None) == 1
        assert journal.append("s1", source="mic", lang="en", text="c", text_en="c",
                              started_ms=None, ended_ms=None) == 2


class TestReopenPersistence:
    def test_append_before_send_survives_reopen(self, tmp_path):
        path = tmp_path / "j.sqlite3"
        j1 = Journal(path)
        j1.ensure_session("s1", "M", "2026-10-22", t0_ms=12345)
        seq = j1.append("s1", source="mic", lang="ar", text="كلمة",
                        text_en="word", started_ms=40, ended_ms=940)
        j1.close()  # hard close right after append (crash path)

        j2 = Journal(path)
        pending = j2.pending("s1", 10)
        assert [r.seq for r in pending] == [seq]
        row = pending[0]
        assert row.text == "كلمة"
        assert row.text_en == "word"
        assert row.lang == "ar"
        assert row.attempts == 0
        sess = j2.get_session("s1")
        assert sess is not None and sess.t0_ms == 12345
        assert sess.status == "capturing"
        j2.close()


class TestStateTransitions:
    def _seed(self, j: Journal) -> str:
        j.ensure_session("s1", "M", "2026-10-22", t0_ms=0)
        for i, src in enumerate(["mic", "system", "mic"]):
            j.append("s1", source=src, lang="en", text=f"t{i}", text_en=f"t{i}",
                     started_ms=i * 100, ended_ms=i * 100 + 50)
        return "s1"

    def test_ack_moves_rows_to_acked_terminal(self, journal: Journal):
        sid = self._seed(journal)
        assert journal.counts(sid) == {"pending": 3, "acked": 0, "failed": 0}
        journal.ack(sid, [1, 2])
        assert journal.counts(sid) == {"pending": 1, "acked": 2, "failed": 0}
        remaining = journal.pending(sid, 10)
        assert [r.seq for r in remaining] == [3]

    def test_attempts_bump_then_ack(self, journal: Journal):
        sid = self._seed(journal)
        journal.mark_attempt(sid, [1, 2])
        rows = journal.pending(sid, 10)
        by_seq = {r.seq: r for r in rows}
        assert by_seq[1].attempts == 1 and by_seq[2].attempts == 1
        assert by_seq[3].attempts == 0
        journal.ack(sid, [1, 2, 3])
        assert journal.counts(sid)["acked"] == 3

    def test_failed_and_requeue(self, journal: Journal):
        sid = self._seed(journal)
        journal.mark_failed(sid, [1])
        rows = journal.failed(sid, 10)
        assert [r.seq for r in rows] == [1]
        assert journal.counts(sid) == {"pending": 2, "acked": 0, "failed": 1}
        assert journal.requeue_failed(sid) == 1
        assert journal.counts(sid) == {"pending": 3, "acked": 0, "failed": 0}

    def test_bad_inputs_rejected(self, journal: Journal):
        journal.ensure_session("s1", "M", "2026-10-22", t0_ms=0)
        with pytest.raises(ValueError):
            journal.append("s1", source="webcam", lang="en", text="x", text_en=None,
                           started_ms=None, ended_ms=None)
        with pytest.raises(ValueError):
            journal.append("s1", source="mic", lang="en", text="   ", text_en=None,
                           started_ms=None, ended_ms=None)


class TestArabicLine:
    def test_text_ar_round_trips_and_defaults_to_none(self, journal: Journal):
        journal.ensure_session("s1", "M", "2026-10-22", t0_ms=0)
        journal.append("s1", source="mic", lang="en", text="hello", text_en="hello",
                       started_ms=0, ended_ms=10, text_ar="مرحبا")
        journal.append("s1", source="mic", lang="en", text="bye", text_en="bye",
                       started_ms=20, ended_ms=30)
        by_seq = {r.seq: r for r in journal.segments("s1")}
        assert by_seq[1].text_ar == "مرحبا"
        assert by_seq[2].text_ar is None
        assert [r.text_ar for r in journal.pending("s1", 10)] == ["مرحبا", None]
        journal.mark_failed("s1", [1])
        assert journal.failed("s1", 10)[0].text_ar == "مرحبا"
        assert journal.failed(None, 10)[0].text_ar == "مرحبا"

    def test_old_journal_without_text_ar_is_migrated(self, tmp_path):
        import sqlite3

        path = tmp_path / "old.sqlite3"
        con = sqlite3.connect(str(path))
        con.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('capturing','ended')),
            t0_ms INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE segments (
            session_id TEXT NOT NULL, seq INTEGER NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('mic','system')),
            lang TEXT, text TEXT NOT NULL, text_en TEXT,
            started_ms INTEGER, ended_ms INTEGER,
            state TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','acked','failed')),
            attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
            PRIMARY KEY (session_id, seq)
        );
        INSERT INTO sessions VALUES ('s1', 'Old', '2026-10-01', 'capturing', 0, 'x');
        INSERT INTO segments (session_id, seq, source, lang, text, text_en,
                              started_ms, ended_ms, created_at)
            VALUES ('s1', 1, 'mic', 'en', 'old line', 'old line', 0, 5, 'x');
        """)
        con.commit()
        con.close()

        for _ in range(2):  # opening twice proves the migration is idempotent
            j = Journal(path)
            rows = j.pending("s1", 10)
            assert [(r.seq, r.text, r.text_ar) for r in rows] == [(1, "old line", None)]
            seq = j.append("s1", source="mic", lang="ar", text="جديد", text_en="new",
                           started_ms=10, ended_ms=20, text_ar="جديد")
            assert j.segments("s1")[-1].text_ar == "جديد"
            assert seq >= 2
            j.close()
            con = sqlite3.connect(str(path))
            con.execute("DELETE FROM segments WHERE seq > 1")
            con.commit()
            con.close()
