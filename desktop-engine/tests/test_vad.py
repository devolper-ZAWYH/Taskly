"""VAD/gap logic tests over synthetic level arrays (no audio devices needed)."""

from __future__ import annotations

import numpy as np
import pytest

from taskly_live.vad import (
    EnergyVadBackend,
    FRAME_MS,
    SAMPLE_RATE,
    Segmenter,
    has_webrtcvad,
)

SR = SAMPLE_RATE


def piecewise(levels: list[float], durations: list[float]) -> np.ndarray:
    """Build 16 kHz float32 audio with per-region constant amplitude."""
    return np.concatenate(
        [
            (np.zeros(int(d * SR), dtype=np.float32)
             if level == 0.0
             else (np.full(int(d * SR), float(level), dtype=np.float32)) * (
                 np.sin(2 * np.pi * 220.0 * np.arange(int(d * SR)) / SR).astype(np.float32)
             ))
            for level, d in zip(levels, durations)
        ]
    )


def feed_in_blocks(seg: Segmenter, pcm: np.ndarray, block_ms: int = 80):
    out = []
    block = int(block_ms * SR / 1000)
    for i in range(0, len(pcm), block):
        out.extend(seg.feed(pcm[i : i + block]))
    out.extend(seg.flush())
    return out


def energy(gap_ms: int = 700, **kw) -> Segmenter:
    return Segmenter(gap_ms=gap_ms, backend=EnergyVadBackend(), **kw)


class TestGapLogic:
    def test_two_bursts_ninehundred_ms_gap_split(self):
        # 0.3s speech / 0.9s silence / 0.5s speech / long tail.
        pcm = piecewise([0.2, 0, 0.2, 0], [0.3, 0.9, 0.5, 2.0])
        utts = feed_in_blocks(energy(), pcm)
        assert len(utts) == 2, [u.start_ms for u in utts]
        first, second = utts
        assert first.start_ms == pytest.approx(0, abs=FRAME_MS * 2)
        assert first.end_ms == pytest.approx(300 + 600, abs=120)  # + hangover
        assert second.start_ms == pytest.approx(1200, abs=FRAME_MS * 2)
        assert second.end_ms == pytest.approx(1200 + 500 + 600, abs=150)

    def test_short_gap_merges_into_one_utterance(self):
        # 0.5s gap (< default 700ms gap) must not split.
        pcm = piecewise([0.2, 0, 0.2], [0.3, 0.5, 0.3])
        utts = feed_in_blocks(energy(), pcm)
        assert len(utts) == 1, [(u.start_ms, u.end_ms) for u in utts]
        span = utts[0].end_ms - utts[0].start_ms
        assert span >= 1000  # covers both bursts + in-between silence

    def test_configurable_gap_threshold(self):
        # Same material with gap_ms=350: the 0.5s hole now splits.
        pcm = piecewise([0.2, 0, 0.2], [0.3, 0.5, 0.3])
        utts = feed_in_blocks(energy(gap_ms=350), pcm)
        assert len(utts) == 2

    def test_flag_false_onset_gap(self):
        # A single 60ms blip inside a 0.5s burst gap must NOT split.
        pcm = piecewise([0.2, 0, 0.05, 0, 0.2], [0.3, 0.22, 0.06, 0.22, 0.3])
        utts = feed_in_blocks(energy(), pcm)
        assert len(utts) == 1

    def test_timestamps_monotonic_nonoverlapping(self):
        pcm = piecewise([0.2, 0, 0.2, 0, 0.2], [0.4, 0.8, 0.3, 0.8, 0.4])
        utts = feed_in_blocks(energy(), pcm)
        for a, b in zip(utts, utts[1:]):
            assert a.end_ms <= b.start_ms
        assert all(u.end_ms > u.start_ms for u in utts)

    def test_hangover_tail_kept_at_end(self):
        pcm = piecewise([0.2, 0], [0.5, 3.0])
        utts = feed_in_blocks(energy(), pcm)
        assert len(utts) == 1
        u = utts[0]
        # end = last voiced frame end + hangover (600ms), NOT the full 3.5s
        assert u.end_ms == pytest.approx(500 + 600, abs=150)
        # the kept PCM really contains the ~600ms decay tail
        assert u.duration_s >= 1.0

    def test_force_finalise_long_run(self):
        pcm = np.full(int(31.0 * SR), 0.2, dtype=np.float32) * np.sin(
            2 * np.pi * 200.0 * np.arange(int(31.0 * SR)) / SR
        ).astype(np.float32)
        seg = energy(max_utterance_ms=8000)
        utts = feed_in_blocks(seg, pcm)
        assert len(utts) >= 3
        assert all(
            (u.end_ms - u.start_ms) <= 8500 for u in utts
        )

    def test_tool_short_utterance_dropped(self):
        pcm = piecewise([0.2, 0, 0.2], [0.02, 0.5, 0.02])
        utts = feed_in_blocks(energy(), pcm)
        assert len(utts) == 0

    def test_flush_closes_open_utterance(self):
        pcm = piecewise([0.2], [0.4])
        seg = energy()
        utts = seg.feed(pcm)
        assert utts == []  # still open (no gap yet)
        flushed = seg.flush()
        assert len(flushed) == 1
        assert flushed[0].duration_s >= 0.35


class TestEnergyBackend:
    def test_loud_vs_silence(self):
        b = EnergyVadBackend()
        loud = (np.full(480, 0.2, dtype=np.float32)) * np.sin(
            2 * np.pi * 220.0 * np.arange(480) / SR
        ).astype(np.float32)
        quiet = np.zeros(480, dtype=np.float32)
        verdicts = [b.is_speech(loud) for _ in range(5)] + [b.is_speech(quiet)]
        assert all(verdicts[:5])
        assert not verdicts[5]

    def test_floor_adaptation(self):
        # The floor should converge to a sustained ambient level and, with a
        # fast upward drift, reclassify the old "speech" level as ambient.
        import math

        def db_of(amp: float) -> float:
            return 20.0 * math.log10(amp * 0.7071)  # sine rms

        b = EnergyVadBackend(floor_up_drift_db_s=20.0)
        noise = (np.full(480, 0.005, dtype=np.float32)) * np.sin(
            2 * np.pi * 220.0 * np.arange(480) / SR
        ).astype(np.float32)
        b.is_speech(noise)  # floor starts at -65: first frame reads speech
        for _ in range(110):  # ~3.3 s of sustained ambient noise
            b.is_speech(noise)
        assert b.noise_floor_db == pytest.approx(db_of(0.005), abs=3.0)
        # Just-above-ambient wiggle is NOT speech once the floor has moved up.
        wiggle = (np.full(480, 0.0052, dtype=np.float32)) * np.sin(
            2 * np.pi * 220.0 * np.arange(480) / SR
        ).astype(np.float32)
        assert b.is_speech(wiggle) is False
        # A clearly-louder level still reads as speech.
        loud = (np.full(480, 0.05, dtype=np.float32)) * np.sin(
            2 * np.pi * 220.0 * np.arange(480) / SR
        ).astype(np.float32)
        assert b.is_speech(loud) is True

    def test_webrtcvad_adapter_or_skip(self):
        if not has_webrtcvad():
            pytest.skip("webrtcvad not importable on this Python (expected on 3.13)")
        from taskly_live.vad import WebRtcVadBackend

        wb = WebRtcVadBackend()
        loud = (np.full(480, 0.2, dtype=np.float32)) * np.sin(
            2 * np.pi * 220.0 * np.arange(480) / SR
        ).astype(np.float32)
        assert any(wb.is_speech(loud) for _ in range(3))
