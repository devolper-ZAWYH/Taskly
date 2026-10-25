"""Idempotent batched pusher with coalescing, backoff and crash-resume replay.

Delivery rules (spec):
  * trigger: >=1 pending utterance; never more aggressive than one push per
    coalesce window (default 3 s); a full batch (<=200) may bypass the window;
  * batches carry <=200 segments in strictly ascending seq;
  * retry ladder 1 s -> 5 s -> 30 s -> 120 s (cap) with +/- 25% jitter;
  * fatal errors (400/401/403/404) mark rows 'failed' and stop this session's
    delivery (they are kept for inspection / requeue — nothing is destroyed);
  * everything is driven from the journal, so a crash/sleep/network loss
    anywhere just replays the pending rows on the next run ("append-before-
    send"); the server dedupes by (session_id, seq), making replays safe.
"""

from __future__ import annotations

import logging
import random
import threading
import time

from .api import ApiError, Segment
from .journal import Journal, JournalRow

log = logging.getLogger(__name__)

DEFAULT_BACKOFF: tuple[float, ...] = (1.0, 5.0, 30.0, 120.0)


class Pusher:
    """Background worker pushing journalled segments; also usable synchronously."""

    def __init__(
        self,
        client,  # LiveClient; untyped to avoid a circular test shim
        journal: Journal,
        session_id: str,
        *,
        coalesce_s: float = 3.0,
        batch_limit: int = 200,
        backoff: tuple[float, ...] = DEFAULT_BACKOFF,
        jitter: float = 0.25,
        on_fatal=None,  # Callable[[ApiError], None] | None
        on_acked=None,  # Callable[[str, list[int]], None] | None
    ) -> None:
        self.client = client
        self.journal = journal
        self.session_id = session_id
        self.coalesce_s = coalesce_s
        self.batch_limit = max(1, min(batch_limit, 200))
        self.backoff = backoff or DEFAULT_BACKOFF
        self.jitter = jitter
        self.on_fatal = on_fatal
        self.on_acked = on_acked

        self._stop_event = threading.Event()
        self._cv = threading.Condition()
        self._thread: threading.Thread | None = None
        self.last_push: float = 0.0
        self.fatal_error: ApiError | None = None
        self.pushed_batches = 0
        self.retried_batches = 0

    # ---- lifecycle --------------------------------------------------------
    def start(self) -> "Pusher":
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("pusher already running")
        thread = threading.Thread(
            target=self._run, name=f"pusher-{self.session_id[:8]}", daemon=True
        )
        self._thread = thread
        thread.start()
        return self

    def stop(self, drain_timeout: float = 90.0) -> None:
        """Stop the worker after a best-effort final drain (bounded)."""
        self._stop_event.set()
        with self._cv:
            self._cv.notify_all()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=drain_timeout)

    def wake(self) -> None:
        """Called by the engine after appending new journal rows."""
        with self._cv:
            self._cv.notify_all()

    # ---- worker -------------------------------------------------------------
    def _run(self) -> None:
        log.info("pusher: running for session %s", self.session_id)
        try:
            while not self._stop_event.is_set():
                if self._drain_once() is False and self.fatal_error:
                    break
                with self._cv:
                    self._cv.wait(timeout=self._wait_hint())
            if self.fatal_error is None:
                self._drain_sync(deadline=time.monotonic() + 10.0)
            if self.fatal_error is not None:
                log.error("pusher: fatal, stopping: %s", self.fatal_error)
                if self.on_fatal:
                    self.on_fatal(self.fatal_error)
        finally:
            log.info(
                "pusher: exited (%d batches pushed, %d retries)",
                self.pushed_batches, self.retried_batches,
            )

    def _wait_hint(self) -> float:
        """Wait until the coalesce window has passed or a wake arrives."""
        since = time.monotonic() - self.last_push
        if since >= self.coalesce_s or self.last_push == 0.0:
            return 0.25
        return min(self.coalesce_s - since, 30.0) + 0.05

    # ---- batch drivers -----------------------------------------------------
    def _drain_once(self) -> bool | None:
        """Try to push one batch of whatever is pending. Returns False on fatal."""
        rows = self.journal.pending(self.session_id, self.batch_limit)
        if not rows:
            return True
        return self._push_rows(rows)

    def _push_rows(self, rows: list[JournalRow]) -> bool | None:
        """Push one batch with the retry ladder. False on fatal-error stop."""
        while not self._stop_event.is_set():
            attempt = max(row.attempts for row in rows) + 1
            segments = [
                Segment(
                    seq=row.seq, source=row.source, lang=row.lang, text=row.text,
                    text_en=row.text_en, started_ms=row.started_ms,
                    ended_ms=row.ended_ms, text_ar=row.text_ar,
                )
                for row in rows
            ]
            seqs = [row.seq for row in rows]
            try:
                outcome = self.client.push(self.session_id, segments)
            except ApiError as exc:
                if exc.fatal:
                    self._handle_fatal(exc, seqs)
                    return False
                self.journal.mark_attempt(self.session_id, seqs)
                self.retried_batches += 1
                delay = self._delay_for(attempt)
                log.warning(
                    "pushing %d segs failed (%s); attempt %d, retry in %.1fs",
                    len(seqs), exc.message[:120], attempt, delay,
                )
                self._stop_event.wait(delay)
                if self._stop_event.is_set():
                    return True  # stopped: rows stay pending (crash-safe)
                rows = self.journal.pending(self.session_id, self.batch_limit)
                if not rows:
                    return True
                continue  # re-pull may have grown/reordered: rebuild next loop
            else:
                self._accept_outcome(outcome, seqs)
                return True
        # Stopped mid-retry: rows remain pending (crash-safe by construction).
        return True

    def _delay_for(self, attempt: int) -> float:
        idx = min(attempt - 1, len(self.backoff) - 1)
        base = self.backoff[idx]
        return base * (1.0 + random.uniform(-self.jitter, self.jitter))

    def _accept_outcome(self, outcome, seqs: list[int]) -> None:
        self.journal.ack(self.session_id, seqs)
        self.last_push = time.monotonic()
        self.pushed_batches += 1
        if self.on_acked is not None:
            try:
                self.on_acked(self.session_id, seqs)
            except Exception as exc:  # noqa: BLE001 - metrics must not kill pushes
                log.warning("on_acked callback failed: %s", exc)
        log.debug(
            "pushed %d segs: accepted=%d last_seq=%d", len(seqs),
            outcome.accepted, outcome.last_seq,
        )

    def _handle_fatal(self, exc: ApiError, seqs: list[int]) -> None:
        self.journal.mark_failed(self.session_id, seqs)
        self.fatal_error = exc
        log.error(
            "pusher: fatal %s; %d rows marked failed: %s",
            exc.message[:200], len(seqs), exc.message,
        )

    # ---- synchronous API (tests, stop path, CLI) ---------------------------
    def drain(self, deadline: float | None = None) -> None:
        """Synchronously push everything pending until the journal is clean.

        Retry ladder applies. Raises on fatal to the caller.
        """
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("drain() not allowed while the worker runs")
        self._drain_sync(deadline=deadline)

    def _drain_sync(self, deadline: float | None = None) -> None:
        """Drain loop shared by drain() and the worker's final pass."""
        while True:
            rows = self.journal.pending(self.session_id, self.batch_limit)
            if not rows:
                return
            if deadline is not None and time.monotonic() >= deadline:
                return
            self._push_batch_sync(rows[: self.batch_limit], deadline)

    def _push_batch_sync(self, rows, deadline: float | None) -> None:
        """One batch-level push with the retry ladder; raises on fatal."""
        seqs = [row.seq for row in rows]
        segments = [
            Segment(
                seq=row.seq, source=row.source, lang=row.lang, text=row.text,
                text_en=row.text_en, started_ms=row.started_ms,
                ended_ms=row.ended_ms, text_ar=row.text_ar,
            )
            for row in rows
        ]
        attempt = max(row.attempts for row in rows) + 1
        while True:
            try:
                outcome = self.client.push(self.session_id, segments)
            except ApiError as exc:
                if exc.fatal:
                    self._handle_fatal(exc, seqs)
                    raise
                self.journal.mark_attempt(self.session_id, seqs)
                self.retried_batches += 1
                delay = self._delay_for(attempt)
                if deadline is not None and time.monotonic() + delay > deadline:
                    log.warning("push failed (%s); out of deadline window",
                                exc.message[:120])
                    return
                attempt += 1
                log.warning("push failed (%s); retry in %.1fs",
                            exc.message[:120], delay)
                self._stop_event.wait(delay)
                continue
            else:
                self._accept_outcome(outcome, seqs)
                return
