"""Utterance segmentation per source (VAD + hangover/gap state machine).

Backend ladder:
  1. `webrtcvad` (WebRTC VAD) when the package is importable — the preferred
     path per plan §3;
  2. otherwise a robust energy VAD: RMS-in-dB relative to an adaptive noise
     floor (fast-attack minimum tracker with slow upward drift) plus an
     absolute floor. This is the *default* on Python 3.13: webrtcvad's C
     extension requires MSVC C++ build tools which cannot be assumed.

Segmentation semantics:
  * speech confirmed after `onset_frames` consecutive voiced frames (debounce);
  * an open utterance finalises after `gap_ms` (default 700) of sustained
    unvoiced audio;
  * finalised audio keeps a `hangover_ms` (default 600) tail and a
    `lookbehind_ms` (default 200) lead-in;
  * utterances are force-finalised at `max_utterance_ms` (30 s) to bound
    STT latency;
  * timestamps are milliseconds on this segmenter's feed timeline
    (per-source; the engine maps them onto session-relative ms).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

try:  # optional C extension; Py3.13 typically lacks prebuilt wheels
    import webrtcvad as _webrtcvad  # type: ignore
except ImportError:  # pragma: no cover - exercised via import guard test
    _webrtcvad = None

SAMPLE_RATE = 16000
FRAME_MS = 30  # webrtcvad-compatible frame size (10/20/30)
FRAME_LENGTH = SAMPLE_RATE * FRAME_MS // 1000  # 480 samples


@dataclass
class Utterance:
    """A finalised utterance: PCM @16 kHz float32 mono + timeline ms."""

    pcm: np.ndarray
    start_ms: int
    end_ms: int

    @property
    def duration_s(self) -> float:
        return len(self.pcm) / SAMPLE_RATE


class VadBackend:
    """Frame classifier: 30 ms float32 frame -> voice activity bool."""

    def is_speech(self, frame: np.ndarray) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


class WebRtcVadBackend(VadBackend):
    """Adapter for `webrtcvad` (aggressiveness 0..3)."""

    def __init__(self, mode: int = 3) -> None:
        if _webrtcvad is None:
            raise RuntimeError("webrtcvad is not importable")
        self._vad = _webrtcvad.Vad(mode)

    def is_speech(self, frame: np.ndarray) -> bool:
        pcm16 = np.clip(frame, -1.0, 1.0)
        pcm16 = (pcm16 * 32767.0).astype(np.int16).tobytes()
        return self._vad.is_speech(pcm16, SAMPLE_RATE)


class EnergyVadBackend(VadBackend):
    """Adaptive-noise-floor energy VAD (default; no native dependencies).

    Decision: db_rms > max(absolute_speech_db, noise_floor_db + margin_db).
    The noise floor snaps down toward local minima quickly (10%/frame, i.e.
    roughly a 3x slower rise than fall) and drifts upward slowly so long
    speech passages do not melt the threshold into the speech level.
    """

    def __init__(
        self,
        onset_margin_db: float = 6.0,
        absolute_speech_db: float = -40.0,
        floor_init_db: float = -65.0,
        floor_min_db: float = -90.0,
        floor_max_db: float = -20.0,
        floor_up_drift_db_s: float = 1.0,
    ) -> None:
        self.margin_db = onset_margin_db
        self.absolute_db = absolute_speech_db
        self.floor_db = floor_init_db
        self.floor_min = floor_min_db
        self.floor_max = floor_max_db
        self.drift_per_s = floor_up_drift_db_s

    def is_speech(self, frame: np.ndarray) -> bool:
        rms = float(np.sqrt(np.mean(np.square(frame))))
        db = 20.0 * math.log10(rms + 1e-12)
        if db < self.floor_db:
            self.floor_db = 0.9 * self.floor_db + 0.1 * db
        else:
            self.floor_db += self.drift_per_s * (len(frame) / SAMPLE_RATE)
        self.floor_db = float(
            np.clip(self.floor_db, self.floor_min, self.floor_max)
        )
        threshold = max(self.absolute_db, self.floor_db + self.margin_db)
        return db > threshold

    @property
    def noise_floor_db(self) -> float:
        return self.floor_db


def default_backend() -> VadBackend:
    """Best available backend (webrtcvad when importable, else energy VAD)."""
    if _webrtcvad is not None:
        return WebRtcVadBackend()
    return EnergyVadBackend()


def has_webrtcvad() -> bool:
    return _webrtcvad is not None


@dataclass
class _State:
    """Segmenter FSM state (all indices are global frame indices)."""

    in_speech: bool = False
    pending: list[np.ndarray] | None = None
    pending_first: int = -1  # global frame index of the first pending frame
    last_speech: int = -1  # global frame index of the last voiced frame
    onset_run: int = 0
    silence: int = 0  # unvoiced frames since the last voiced frame

    def __post_init__(self) -> None:
        if self.pending is None:
            self.pending = []


class Segmenter:
    """Streaming utterance segmentation over 30 ms frames."""

    def __init__(
        self,
        *,
        gap_ms: int = 700,
        hangover_ms: int = 600,
        lookbehind_ms: int = 200,
        max_utterance_ms: int = 30_000,
        backend: VadBackend | None = None,
        onset_frames: int = 2,
    ) -> None:
        self.gap_ms = gap_ms
        self.hangover_ms = hangover_ms
        self.lookbehind_ms = lookbehind_ms
        self.max_utterance_ms = max_utterance_ms
        self.onset_frames = max(1, onset_frames)
        self.backend = backend if backend is not None else default_backend()

        self._tail = np.empty(0, dtype=np.float32)  # sub-frame leftovers
        self._history: deque[np.ndarray] = deque(
            maxlen=max(1, lookbehind_ms // FRAME_MS)
        )
        self._frame_index = 0  # persistent global frame counter
        self._st = _State()

    # ---- streaming API ------------------------------------------------------
    def feed(self, pcm: np.ndarray) -> list[Utterance]:
        """Absorb PCM (16 kHz float32, any length); emit finalised utterances."""
        buf = np.concatenate([self._tail, np.asarray(pcm, dtype=np.float32)])
        n_full = len(buf) // FRAME_LENGTH
        out: list[Utterance] = []
        for i in range(n_full):
            frame = buf[i * FRAME_LENGTH : (i + 1) * FRAME_LENGTH]
            utterance = self._process_frame(frame)
            if utterance is not None:
                out.append(utterance)
        self._tail = buf[n_full * FRAME_LENGTH :].copy()
        return out

    def flush(self) -> list[Utterance]:
        """Stream ended: finalise any open utterance (full tail)."""
        if not self._st.in_speech:
            return []
        utterance = self._finalise(use_full_tail=True)
        return [utterance] if utterance is not None else []

    # ---- internals -----------------------------------------------------------
    def _process_frame(self, frame: np.ndarray) -> Utterance | None:
        index = self._frame_index
        self._frame_index += 1
        voiced = self.backend.is_speech(frame)
        st = self._st

        if not st.in_speech:
            if voiced:
                st.onset_run += 1
                if st.onset_run >= self.onset_frames:
                    # Confirmed onset: lookbehind ring + the onset frames.
                    st.pending = list(self._history) + [frame] * st.onset_run
                    st.pending_first = index - st.onset_run + 1
                    st.last_speech = index
                    st.in_speech = True
                    st.silence = 0
            else:
                st.onset_run = 0
                self._history.append(frame)
            return None

        # In speech.
        if voiced:
            st.last_speech = index
            st.silence = 0
        else:
            st.silence += 1
        assert st.pending is not None
        st.pending.append(frame)

        span_ms = (index - st.pending_first + 1) * FRAME_MS
        if span_ms >= self.max_utterance_ms:
            return self._finalise(use_full_tail=False)  # long-utterance bound
        if st.silence * FRAME_MS >= self.gap_ms:
            return self._finalise(use_full_tail=False)  # normal gap close
        return None

    def _finalise(self, *, use_full_tail: bool) -> Utterance | None:
        st = self._st
        pending = st.pending or []
        silence_at_close = st.silence  # snapshot before the reset below
        st.pending = []
        st.in_speech = False
        st.onset_run = 0
        st.silence = 0
        if not pending:
            return None

        if use_full_tail:
            keep = len(pending)
        else:
            last_keep = (st.last_speech - st.pending_first + 1)  # 1-based span
            tail = min(silence_at_close, self.hangover_ms // FRAME_MS)
            keep = max(last_keep + tail, 1)
            keep = min(keep, len(pending))

        pcm = np.concatenate(pending)[: keep * FRAME_LENGTH].astype(np.float32)
        start_ms = int(st.pending_first * FRAME_MS)
        end_ms = int(start_ms + keep * FRAME_MS)
        if len(pcm) < SAMPLE_RATE // 10:  # <100 ms: not a usable utterance
            return None
        return Utterance(pcm=pcm, start_ms=start_ms, end_ms=end_ms)
