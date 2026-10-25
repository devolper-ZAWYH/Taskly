"""Live capture orchestration: sources -> VAD -> STT -> journal -> pusher.

Capture-origin boundary (v0.2): every origin feeds ONE entry point behind
per-source bounded frame queues:

    capture origin (local AudioFeeds worker | remote WebSocket frame receiver)
        ->  LiveEngine.ingest(source, pcm16k)
        ->  per-source SourceLane queue (backpressure: drop-oldest, counted)
        ->  lane thread: Segmenter.feed -> utterances -> executor.submit
        ->  per-source assigner thread: futures in FIFO -> journal.append(seq)
        ->  pusher thread: batched idempotent delivery

Single-box `start` uses the local origin (`AudioFeeds`, unchanged contract).
Split mode `serve` starts with NO session: the engine defers "ensure
session" until the first journalable utterance (or an explicit --resume),
anchoring the session timeline at the earliest lane's first frame so
utterance ms stay coherent despite the network hop.

Windows-friendly: stop is a cooperative Event (Ctrl-C, the `stop`
command's flag file, or a fatal pusher error); no unix-only APIs.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from queue import Full, Queue

import numpy as np

from . import audio
from .api import LiveClient
from .config import Config
from .journal import Journal
from .pusher import Pusher
from .stt import SttPipeline
from .vad import Segmenter

log = logging.getLogger(__name__)

# Lane backpressure: a lane queue holds at most this many seconds of audio.
DEFAULT_LANE_BACKLOG_S = 25.0
# Unknown/dropped decodes waited for at shutdown.
SHUTDOWN_DECODE_GRACE_S = 30.0


def decode_wait_s(stt) -> float:
    """How long one utterance's decode may take before it's given up.

    Local Whisper answers in seconds or not at all; a remote model server
    (remote.RemoteStt) retries through an outage and says how long via
    `result_timeout_s`, so its speech isn't dropped at the 30 s mark.
    """
    return max(SHUTDOWN_DECODE_GRACE_S, float(getattr(stt, "result_timeout_s", 0.0) or 0.0))


@dataclass
class UtteranceMetric:
    """Observability row for e2e latency measurement (tests + status)."""

    seq: int
    source: str
    lane_start_ms: int
    lane_end_ms: int
    wall_end_epoch: float  # approx loudspeaker-side epoch (lane anchor + end ms)
    deliver_epoch: float
    decode_s: float
    acked_epoch: float | None = None

    @property
    def e2e_s(self) -> float | None:
        """Speech (approx) -> server ack of the push, in seconds."""
        if self.acked_epoch is None:
            return None
        return self.acked_epoch - self.wall_end_epoch


@dataclass
class _Meta:
    """Timeline bookkeeping travelling with one submitted utterance."""

    source: str
    started_ms: int
    ended_ms: int


class SourceLane(threading.Thread):
    """Per-source bounded queue -> VAD -> decode-submission thread."""

    def __init__(self, engine: "LiveEngine", source: str, backlog_s: float) -> None:
        super().__init__(name=f"lane-{source}", daemon=True)
        self.engine = engine
        self.source = source
        self.duration_cap = int(backlog_s)
        self._q: "Queue[np.ndarray | None]" = Queue(maxsize=backlog_s * 50)  # 50 fps
        self.dropped_s = 0.0
        self._segmenter = Segmenter(gap_ms=engine.cfg.gap_ms)

    def enqueue(self, pcm: "np.ndarray") -> None:
        """Producer-side backpressure: drop-oldest when the lane is saturated."""
        try:
            self._q.put_nowait(pcm)
        except Full:
            try:
                old = self._q.get_nowait()
                self.dropped_s += len(old) / 16000.0
            except Exception:  # pragma: no cover - raced empty
                pass
            try:
                self._q.put_nowait(pcm)
            except Full:  # pragma: no cover - extremely unlikely
                self.dropped_s += len(pcm) / 16000.0

    def close(self) -> None:
        self._q.put(None)

    def run(self) -> None:
        while True:
            pcm = self._q.get()
            if pcm is None:
                self._flush_and_exit()
                return
            utterances = self._segmenter.feed(pcm)
            for u in utterances:
                self.engine._submit(self.source, u)

    def _flush_and_exit(self) -> None:
        for u in self._segmenter.flush():
            self.engine._submit(self.source, u)
        self.engine._lane_finished(self.source)


class _Assigner(threading.Thread):
    """FIFO decode-result writer for one source (keeps source order)."""

    def __init__(self, engine: "LiveEngine", source: str) -> None:
        super().__init__(name=f"assign-{source}", daemon=True)
        self.engine = engine
        self.source = source
        self.jobs: "Queue[tuple[Future, _Meta] | None]" = Queue()

    def run(self) -> None:
        while True:
            job = self.jobs.get()
            if job is None:
                return
            future, meta = job
            try:
                transcript = future.result(timeout=decode_wait_s(self.engine.stt))
            except Exception as exc:  # noqa: BLE001 - per-utterance decode failure
                log.error("%s: decode failed, skipping utterance: %s",
                          self.source, exc)
                self.engine._skip_utterance(failed=True)
                continue
            if transcript is None or not transcript.text:
                self.engine._skip_utterance()
                continue
            try:
                self.engine._deliver(self.source, transcript, meta)
            except Exception as exc:  # noqa: BLE001 - thread boundary
                # e.g. session creation failed (bad token/URL): stop the engine
                # cleanly instead of silently killing this source's writer.
                log.error("%s: deliver failed: %s", self.source, exc)
                self.engine.stop(f"deliver failure: {exc}")


class LiveEngine:
    """One capturing session pipeline (local or streaming capture origin)."""

    def __init__(
        self,
        cfg: Config,
        client: LiveClient,
        journal: Journal,
        stt: SttPipeline,
        *,
        title: str,
        date: str,
        meeting_id: str | None = None,
        streaming: bool = False,
        resume: str | None = None,
        lane_backlog_s: float = DEFAULT_LANE_BACKLOG_S,
    ) -> None:
        self.cfg = cfg
        self.client = client
        self.journal = journal
        self.stt = stt
        self.title = title
        self.date = date
        self.meeting_id = meeting_id  # the Taskly meeting this records, if any
        self.streaming = streaming
        self._resume_arg = resume
        self.lane_backlog_s = lane_backlog_s

        self.session_id: str | None = None
        self.stop_event = threading.Event()
        self._stop_reason = "stopped"
        self._deliverable: threading.Event | None = (
            threading.Event() if streaming else None
        )
        self._pusher: Pusher | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._assigners: dict[str, _Assigner] = {}
        self._lanes: dict[str, SourceLane] = {}
        self._lane_start_wall: dict[str, int] = {}  # epoch ms of first frame
        self._lane_stats: dict[str, dict] = {}
        self._feeds: audio.AudioFeeds | None = None
        self._capture_t0: int = 0
        self._lock = threading.Lock()
        self.utterances = 0
        self.skipped_utterances = 0
        self.failed_utterances = 0
        self.decode_seconds = 0.0
        self.metrics: list[UtteranceMetric] = []

    # ------------------------------------------------------------------
    # dispatch boundary (the only entry capture origins use)
    # ------------------------------------------------------------------
    def ingest(self, source: str, pcm: "np.ndarray") -> None:
        """Absorb one chunk of 16 kHz mono float32 from ANY capture origin."""
        if source not in (audio.SOURCE_MIC, audio.SOURCE_SYSTEM):
            raise ValueError(f"unknown source id {source!r}")
        lane = self._lanes.get(source)
        if lane is None:
            lane = self._attach_lane(source, pcm)
        self._lane_stats.setdefault(source, {"frames": 0, "samples": 0})
        stats = self._lane_stats[source]
        stats["frames"] += 1
        stats["samples"] += int(len(pcm))
        lane.enqueue(pcm)

    def _attach_lane(self, source: str, pcm) -> SourceLane:
        if not self.streaming and source not in self._allowed_local_sources():
            raise ValueError(f"{source} capture is disabled in this engine")
        lane = SourceLane(self, source, self.lane_backlog_s)
        self._lanes[source] = lane
        self._lane_start_wall[source] = int(time.time() * 1000)
        assigner = _Assigner(self, source)
        assigner.start()
        self._assigners[source] = assigner
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=2,
                                                thread_name_prefix="stt")
        lane.start()
        log.info("lane attached: %s (%d samples/chunk, backlog=%ss)",
                 source, len(pcm), self.lane_backlog_s)
        return lane

    def _allowed_local_sources(self) -> tuple[str, ...]:
        allowed = []
        if self.cfg.mic:
            allowed.append(audio.SOURCE_MIC)
        if self.cfg.system:
            allowed.append(audio.SOURCE_SYSTEM)
        return tuple(allowed)

    def lane_snapshot(self) -> dict:
        """Tiny status blob for `status`/serve observability."""
        with self._lock:
            return {
                src: {
                    "frames": st["frames"],
                    "samples": st["samples"],
                    "dropped_s": round(lane.dropped_s, 2)
                    if (lane := self._lanes.get(src)) else 0.0,
                }
                for src, st in self._lane_stats.items()
            }

    # ------------------------------------------------------------------
    # single-box (local capture origin)
    # ------------------------------------------------------------------
    def run(self, *, resume: str | None = None) -> "EngineSummary":
        """Probe devices first, then create (or resume) and capture until stop."""
        # Timeline anchor before capture so utterance ms never go negative;
        # resumed sessions keep their original t0 (correct absolute timeline).
        resume = resume or self._resume_arg

        # VAD/STT threads get created lazily on first ingest; local feeds
        # below decide availability BEFORE any session is created.
        self._feeds = audio.AudioFeeds(
            self.ingest, mic=self.cfg.mic, system=self.cfg.system,
            device=self.cfg.device, auto_gain=self.cfg.auto_gain,
            system_device=getattr(self.cfg, "system_device", None),
        )
        self._feeds.start()
        self._capture_t0 = int(time.time() * 1000)

        if resume is None:
            session = self.client.create_session(self.title, self.date, self.meeting_id)
            self.session_id = str(session["id"])
            # A claimed meeting brings its own title and date.
            self.title = str(session.get("meetingTitle") or self.title)
            self.date = str(session.get("meetingDate") or self.date)
            t0 = self._capture_t0
        else:
            self.session_id = resume
            existing = self.journal.get_session(resume)
            if existing is None:
                raise ValueError(f"cannot resume: unknown session {resume!r}")
            t0 = existing.t0_ms
            log.info("resuming session %s (title=%r)", resume, existing.title)
        self._begin_session(self.session_id, t0)

        self._write_state_file("capturing")
        self._wait_until_stop()
        return self._shutdown()

    def _begin_session(self, session_id: str, t0_ms: int) -> None:
        self.journal.ensure_session(session_id, self.title, self.date, t0_ms)
        self.journal.set_session_status(session_id, "capturing")
        self._capture_t0 = t0_ms if not self.streaming else self._capture_t0
        self._pusher = Pusher(
            self.client, self.journal, session_id,
            coalesce_s=self.cfg.coalesce_s, batch_limit=self.cfg.batch_limit,
            on_acked=self._on_rows_acked,
        ).start()
        self._deliverable = threading.Event()
        self._deliverable.set()
        log.info("session %s capturing (%s)", session_id, self.client.base_url)

    # ------------------------------------------------------------------
    # streaming mode (serve): session deferred until first utterance
    # ------------------------------------------------------------------
    def ensure_streaming_session(self) -> str:
        """Create/resume the session lazily; returns the session id."""
        with self._lock:
            if self.session_id is not None:
                return self.session_id
            resume = self._resume_arg
            if resume is not None:
                existing = self.journal.get_session(resume)
                if existing is None:
                    raise ValueError(f"cannot resume: unknown session {resume!r}")
                session_id = resume
                t0 = existing.t0_ms
                log.info("streaming: resuming session %s", resume)
            else:
                session = self.client.create_session(self.title, self.date, self.meeting_id)
                session_id = str(session["id"])
                # Anchor the timeline at the stream start (earliest lane),
                # not at creation time: utterance ms then line up with what
                # the laptop actually played (modulo one-way LAN latency).
                elapsed = max(
                    int(time.time() * 1000) - s
                    for s in (self._lane_start_wall.values() or {int(time.time() * 1000)})
                )
                t0 = int(time.time() * 1000) - elapsed
                log.info("streaming: session created on first utterance (%s)",
                         session_id)
            self.session_id = session_id
            self.journal.ensure_session(session_id, self.title, self.date, t0)
            self.journal.set_session_status(session_id, "capturing")
            self._pusher = Pusher(
                self.client, self.journal, session_id,
                coalesce_s=self.cfg.coalesce_s, batch_limit=self.cfg.batch_limit,
                on_acked=self._on_rows_acked,
            ).start()
            self._write_state_file("capturing")
            if self._deliverable is None:
                self._deliverable = threading.Event()
            self._deliverable.set()
            return session_id

    def run_stream(self) -> "EngineSummary | None":
        """serve-side lifecycle: wait for stop, then shut the pipeline down.

        Session creation is deferred (streaming); with no utterance and no
        resume there is nothing to end gracefully.
        """
        if not self.streaming:
            raise RuntimeError("run_stream() requires streaming=True")
        self._wait_until_stop()
        # Let an in-flight first-utterance session creation land before
        # deciding there is nothing to shut down (window is ~ms wide).
        if self.session_id is None:
            time.sleep(0.2)
        if self.session_id is None:
            log.info("streaming: stopping before any session existed")
            if self._deliverable is not None:
                self._deliverable.set()  # release any waiting deliverers
            self._remove_state_file()
            return None
        return self._shutdown()

    # ------------------------------------------------------------------
    # pipeline internals
    # ------------------------------------------------------------------
    def _submit(self, source: str, utterance) -> None:
        assert self._executor is not None
        if self.stop_event.is_set():  # late frames after stop: ignore
            return
        meta = _Meta(source, int(utterance.start_ms), int(utterance.end_ms))
        future = self._executor.submit(self.stt.transcribe, utterance.pcm)
        try:
            self._assigners[source].jobs.put((future, meta))
        except KeyError:  # pragma: no cover - lane torn down mid-flight
            return

    def _skip_utterance(self, *, failed: bool = False) -> None:
        """STT returned nothing usable (silence / hallucination filter), or
        the decode itself failed (`failed`: speech that was lost)."""
        with self._lock:
            self.skipped_utterances += 1
            if failed:
                self.failed_utterances += 1

    def _deliver(self, source: str, transcript, meta: _Meta) -> None:
        """Journal one decoded utterance and wake the pusher."""
        if not transcript.text:
            return
        if self.streaming and self.session_id is None:
            self.ensure_streaming_session()
        if self._deliverable is not None and not self._deliverable.wait(60.0):
            log.error("session never became deliverable; dropping utterance")
            return
        if self.stop_event.is_set():
            return
        assert self.session_id is not None
        sess = self.journal.get_session(self.session_id)
        lane_start_wall = self._lane_start_wall.get(
            source, self._capture_t0
        )
        offset = int(lane_start_wall) - sess.t0_ms  # type: ignore[union-attr]
        started_ms = max(0, int(meta.started_ms + offset))
        ended_ms = max(started_ms + 1, int(meta.ended_ms + offset))
        seq = self.journal.append(
            self.session_id,
            source=source,
            lang=transcript.lang,
            text=transcript.text,
            text_en=transcript.text_en,
            text_ar=getattr(transcript, "text_ar", None),
            started_ms=started_ms,
            ended_ms=ended_ms,
        )
        with self._lock:
            self.utterances += 1
            self.decode_seconds += transcript.total_s
            anchor = self._lane_start_wall.get(source, self._capture_t0)
            metric = UtteranceMetric(
                seq=seq,
                source=source,
                lane_start_ms=meta.started_ms,
                lane_end_ms=meta.ended_ms,
                wall_end_epoch=anchor / 1000.0 + meta.ended_ms / 1000.0,
                deliver_epoch=time.time(),
                decode_s=transcript.total_s,
            )
            self.metrics.append(metric)
        # Ids, sizes and timings only: the words stay out of logs.
        log.info(
            "seg #%d %s [%.2fs] (%s) %d chars en=%s ar=%s decode=%.2fs",
            seq, source, (ended_ms - started_ms) / 1000,
            transcript.lang or "?", len(transcript.text),
            "y" if transcript.text_en else "-",
            "y" if getattr(transcript, "text_ar", None) else "-",
            transcript.total_s,
        )
        if self._pusher:
            self._pusher.wake()

    def _on_rows_acked(self, session_id: str, seqs: list[int]) -> None:
        """Pusher callback: stamp ack time for e2e latency metrics."""
        del session_id
        seq_set = set(seqs)
        now = time.time()
        with self._lock:
            for metric in self.metrics:
                if metric.acked_epoch is None and metric.seq in seq_set:
                    metric.acked_epoch = now

    # ---- lane finalization -----------------------------------------
    def _lane_finished(self, source: str) -> None:
        assigner = self._assigners.get(source)
        if assigner is not None:
            assigner.jobs.put(None)  # sentinel: exit after draining

    def stats(self) -> dict:
        """Feeds-level stats (local capture only)."""
        return self._feeds.stats if self._feeds else {}

    def announce_state(self, status: str) -> None:
        """Public hook: serve writes a 'waiting' state file at boot so `stop`
        and `status` work even before the first utterance creates a session."""
        self._write_state_file(status)

    # ---- stop handling ------------------------------------------------------
    def _wait_until_stop(self) -> None:
        """Block until: stop event, stop-flag file, or fatal pusher error."""
        while not self.stop_event.is_set():
            if self.cfg.stop_flag.exists():
                self._stop_reason = "stop command"
                break
            if self._pusher and self._pusher.fatal_error is not None:
                self._stop_reason = "fatal push error"
                break
            self.stop_event.wait(0.3)

    def stop(self, reason: str = "interrupt") -> None:
        self._stop_reason = reason
        self.stop_event.set()

    def _shutdown(self) -> "EngineSummary":
        log.info("stopping engine (%s)...", self._stop_reason)
        if self._feeds is not None:
            self._feeds.stop()
        for lane in list(self._lanes.values()):
            lane.close()
        for lane in list(self._lanes.values()):
            lane.join(timeout=5.0)  # flushed and its writer's sentinel queued
        # A model server mid-outage may hold lines for minutes: wait for them
        # (they're speech), then for each writer to journal its last one.
        deadline = time.monotonic() + decode_wait_s(self.stt)
        for assigner in self._assigners.values():
            while not assigner.jobs.empty() and time.monotonic() < deadline:
                time.sleep(0.05)
        if self._executor is not None:
            self._executor.shutdown(wait=True)
        for assigner in self._assigners.values():
            assigner.join(timeout=max(1.0, deadline - time.monotonic()))
        if self._pusher is not None:
            self._pusher.stop(drain_timeout=120.0)

        assert self.session_id is not None
        counts = self.journal.counts(self.session_id)
        fatal = None
        if self._pusher and self._pusher.fatal_error:
            fatal = str(self._pusher.fatal_error)

        end_status = "reviewing"
        if fatal is None:
            # End even with pending rows: they replay on the next `--resume`.
            try:
                self.client.end_session(self.session_id)
            except Exception as exc:  # noqa: BLE001 - keep journal truth visible
                print(f"error: ending session on server failed: {exc}")
                print("the session stays open server-side; retry `stop --end` later")
                end_status = "still-capturing"
            else:
                self.journal.set_session_status(self.session_id, "ended")
        else:
            end_status = "fatal"

        self._remove_state_file()
        return EngineSummary(
            session_id=self.session_id,
            title=self.title,
            utterances=self.utterances,
            pushed_acked=counts["acked"],
            pushed_pending=counts["pending"],
            pushed_failed=counts["failed"],
            fatal=fatal,
            end_status=end_status,
        )

    def _remove_state_file(self) -> None:
        if self.cfg.state_file.exists():
            self.cfg.state_file.unlink()

    def _write_state_file(self, status: str) -> None:
        import json
        import os
        self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_id": self.session_id,
            "title": self.title,
            "date": self.date,
            "url": self.cfg.url,
            "engine_url": getattr(self.cfg, "engine_url", "") or "",
            "mode": "streaming" if self.streaming else "local",
            "status": status,
            "pid": os.getpid(),
            "started_epoch_ms": self._capture_t0,
        }
        self.cfg.state_file.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )


@dataclass
class EngineSummary:
    """What the CLI prints after a capture session ends."""

    session_id: str
    title: str
    utterances: int
    pushed_acked: int
    pushed_pending: int
    pushed_failed: int
    fatal: str | None
    end_status: str


def default_title(date: str) -> str:
    return f"Live meeting {date}"
