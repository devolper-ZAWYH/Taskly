"""Capture-side spill buffer: no-lost-audio across reconnects (v0.2).

SUPERSEDED (2026-10): not wired into the CLI and not maintained. The
architecture that shipped keeps the whole pipeline on each laptop and sends
only utterance audio to the PC's model server (`serve` in server.py, client
in remote.py); see README.md and docs/live-meetings.md. Kept for reference.

While the WebSocket to `serve` is down, `capture` keeps capturing and stores
frames in a bounded in-memory ring (default cap 600 s = 10 minutes; oldest
blocks are dropped once the cap overflows and the loss is counted). The ring
is periodically rewritten to ``<spill_dir>/spill-<source>.wav`` (plain PCM
WAV) so a laptop crash/reboot still leaves the gap recoverable on restart.
The directory is gitignored.

Blocks are seq-stamped with the CaptureClient's GLOBAL capture counter, so
the transport can merge outbox content and spill content back into exact
capture order at reconnect: replay order == capture order, always.

After a successful reconnect the ring drains first (fast, not realtime
paced — the server's per-source lane consumes as fast as the link allows),
then live frames flow again.
"""

from __future__ import annotations

import logging
import threading
import time
import wave
from collections import deque
from pathlib import Path

from .protocol import RATE

log = logging.getLogger(__name__)

DEFAULT_SPILL_MAX_S = 600.0   # 10-minute ring
SPILL_FLUSH_S = 15.0          # rewrite the WAV this often while disconnected
# Blocks restored from disk sort before ever-counter-assigned live frames.
_PREHISTORIC_SEQ = -10 ** 12


class SpillRing:
    """Per-source FIFO ring of seq-stamped int16 PCM blocks + WAV backup."""

    def __init__(
        self,
        source: str,
        spill_dir: Path,
        *,
        max_s: float = DEFAULT_SPILL_MAX_S,
    ) -> None:
        self.source = source
        self.spill_dir = Path(spill_dir)
        self.max_s = float(max_s)
        self._cap_bytes = int(self.max_s * RATE * 2)  # int16 mono LE
        self._blocks: "deque[tuple[int, bytes]]" = deque()
        self._bytes = 0
        self._lock = threading.Lock()
        self._dirty = False
        self._last_flush = 0.0
        self.dropped_front_s = 0.0   # ring-overflow loss (oldest trimming)
        self.captured_s = 0.0        # cumulative seconds stored here ever
        self._load_existing()

    # ---- paths ---------------------------------------------------------------
    @property
    def wav_path(self) -> Path:
        return self.spill_dir / f"spill-{self.source}.wav"

    # ---- capture path ----------------------------------------------------------
    def add(self, seq: int, raw: bytes) -> None:
        """Store one seq-stamped block of raw int16 LE PCM."""
        with self._lock:
            self._blocks.append((seq, raw))
            self._bytes += len(raw)
            self._dirty = True
            self.captured_s += len(raw) / (RATE * 2.0)
            dropped_s = 0.0
            while self._bytes > self._cap_bytes and self._blocks:
                _seq, old = self._blocks.popleft()
                self._bytes -= len(old)
                dropped_s += len(old) / (RATE * 2.0)
            if dropped_s:
                self.dropped_front_s += dropped_s

    # ---- replay / merge ----------------------------------------------------------
    def drain(self) -> list[tuple[int, bytes]]:
        """Remove and return ALL blocks, sorted by capture seq."""
        with self._lock:
            blocks = sorted(self._blocks)
            self._blocks.clear()
            self._bytes = 0
            self._dirty = False
        if blocks:
            self._remove_wav()
        return blocks

    def replace_all(self, blocks: list[tuple[int, bytes]]) -> None:
        """Atomically swap the ring content (transport-side order merging)."""
        with self._lock:
            self._blocks.clear()
            self._bytes = 0
            for _seq, raw in blocks:
                self._blocks.append((_seq, raw))
                self._bytes += len(raw)
            self._dirty = bool(blocks)

    # ---- disk flush ---------------------------------------------------------------
    def maybe_flush(self, now: float) -> None:
        """Rewrite the WAV at most every SPILL_FLUSH_S (monotonic clock)."""
        with self._lock:
            dirty = self._dirty
            due = self._last_flush + SPILL_FLUSH_S <= now
        if dirty and due:
            self.flush_now()

    def flush_now(self) -> None:
        """Immediate disk flush (before a reconnect attempt, at shutdown)."""
        with self._lock:
            if not self._dirty:
                return
            dump = list(self._blocks)
        self._write_wav(dump)
        with self._lock:
            self._dirty = False
            self._last_flush = time.monotonic()

    def _remove_wav(self) -> None:
        try:
            self.wav_path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:  # pragma: no cover - locked file etc.
            log.warning("spill: could not clear %s: %s", self.wav_path, exc)

    # ---- introspection ------------------------------------------------------------
    def buffered_s(self) -> float:
        with self._lock:
            return self._bytes / (RATE * 2.0)

    def stats(self) -> dict:
        with self._lock:
            return {
                "source": self.source,
                "buffered_s": round(self._bytes / (RATE * 2.0), 1),
                "dropped_front_s": round(self.dropped_front_s, 1),
                "captured_s": round(self.captured_s, 1),
                "on_disk": self.wav_path.exists(),
            }

    # ---- persistence ------------------------------------------------------------
    def _write_wav(self, blocks: list[tuple[int, bytes]]) -> None:
        tmp = self.wav_path.with_suffix(".tmp")
        self.spill_dir.mkdir(parents=True, exist_ok=True)
        try:
            with wave.open(str(tmp), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(RATE)
                for _seq, b in blocks:
                    wf.writeframes(b)
            tmp.replace(self.wav_path)
        except OSError as exc:  # disk full / AV lock — buffer survives in RAM
            log.warning("spill: wav flush failed (%s); keeping memory ring", exc)

    def _load_existing(self) -> None:
        """Restore a leftover spill wav (e.g. capture crashed while down).

        Restored blocks get prehistoric seqs so they always sort (and replay)
        BEFORE any freshly captured audio.
        """
        if not self.wav_path.exists():
            return
        try:
            raw = self.wav_path.read_bytes()
        except OSError as exc:  # pragma: no cover
            log.warning("spill: cannot read leftover %s: %s", self.wav_path, exc)
            return
        if len(raw) > 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
            raw = raw[44:]  # canonical 44-byte PCM WAV header
        if not raw:
            return
        with self._lock:
            self._bytes = len(raw)
            self._blocks.clear()
            self._blocks.append((_PREHISTORIC_SEQ, raw))
            self.captured_s += len(raw) / (RATE * 2.0)
            self._dirty = True
        log.info(
            "spill: restored %.1fs for %s from %s",
            len(raw) / (RATE * 2.0), self.source, self.wav_path.name,
        )
