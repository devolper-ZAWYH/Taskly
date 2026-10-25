"""Offline replay: feed a WAV file through the exact streaming pipeline.

`--replay FILE.wav` (or `python -m taskly_live replay FILE`) is the CI/test
mode from plan §7: no capture devices needed. The file is VAD-sliced with
the same Segmenter as live capture, every slice is decoded with the same
SttPipeline, rows land in the journal and are pushed with pacing that
mimics a live stream (utterance pushed when its virtual end time has
arrived, scaled by --speed), and the session is ended at the end.

Downmix/resample: handled by PyAV (bundled with faster-whisper), so most
audio formats work; stdlib `wave` is used as a fallback for plain PCM WAV.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def load_pcm_mono_16k(path: Path, target_rate: int = 16000) -> tuple[np.ndarray, int, float]:
    """Decode any supported audio file to mono float32 at target_rate.

    Returns (pcm, source_rate, duration_s). Tries PyAV first (mp3/m4a/opus/
    float wav/...) and falls back to the stdlib `wave` module for plain PCM.
    """
    try:
        return _decode_with_av(path, target_rate)
    except ImportError as exc:  # PyAV missing: only possible in odd installs
        raise RuntimeError(f"PyAV unavailable for decoding {path}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - try stdlib before giving up
        log.debug("PyAV decode failed (%s); trying stdlib wave", exc)
        return _decode_with_wave(path, target_rate)


def _decode_with_av(path: Path, target_rate: int) -> tuple[np.ndarray, int, float]:
    import av

    src_rate = 0
    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        src_rate = int(stream.rate) if getattr(stream, "rate", None) else target_rate
        resampler = av.AudioResampler(
            format="s16", layout="mono", rate=target_rate
        )
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                arr = rf.to_ndarray().ravel()
                chunks.append(arr.astype(np.float32))
    if not chunks:
        raise RuntimeError(f"no audio frames decoded from {path}")
    pcm = np.concatenate(chunks) / 32768.0
    duration = len(pcm) / target_rate
    return pcm, src_rate, duration


def _decode_with_wave(path: Path, target_rate: int) -> tuple[np.ndarray, int, float]:
    import wave

    with wave.open(str(path), "rb") as wf:
        n_channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        arr = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    elif width == 4:
        arr = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2 ** 31
    elif width == 1:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise RuntimeError(f"unsupported sample width {width} bytes")
    if n_channels > 1:
        arr = arr.reshape(-1, n_channels).mean(axis=1)
    ds_rate = rate if rate == target_rate else target_rate
    from .audio import resample_to_16k

    pcm = resample_to_16k(arr, rate)
    return pcm, ds_rate, len(pcm) / target_rate


def run_replay(
    cfg,  # Config
    client,  # LiveClient
    journal,  # Journal
    stt,  # SttPipeline (already built)
    wav_path: Path,
    *,
    title: str,
    date: str,
    speed: float = 1.0,
    meeting_id: str | None = None,
) -> dict:
    """Replay one file end-to-end; returns a summary dict for the CLI."""
    from .pusher import Pusher
    from .vad import Segmenter

    pcm, src_rate, duration_s = load_pcm_mono_16k(wav_path)
    log.info(
        "replay: %s (%d Hz decoded to mono 16k, %.1fs, speed x%g)",
        wav_path, src_rate, duration_s, speed,
    )

    session = client.create_session(title, date, meeting_id)
    session_id = str(session["id"])
    # A claimed meeting brings its own title and date.
    title = str(session.get("meetingTitle") or title)
    date = str(session.get("meetingDate") or date)
    t0_epoch_ms = int(time.time() * 1000)
    journal.ensure_session(session_id, title, date, t0_epoch_ms)
    journal.set_session_status(session_id, "capturing")
    log.info("replay session %s -> %s", session_id, client.base_url)

    pusher = Pusher(
        client, journal, session_id,
        coalesce_s=0.0 if speed <= 0 else min(3.0, max(0.2, 3.0 / max(speed, 0.1))),
        batch_limit=cfg.batch_limit,
    ).start()

    segmenter = Segmenter(gap_ms=cfg.gap_ms)
    t_start = time.monotonic()
    delivered = 0
    skipped = 0
    metrics_total: list[tuple[float, float]] = []
    lines: list[tuple[str, str, str, str]] = []

    def push_pace(utterance):
        nonlocal delivered, skipped
        transcript = stt.transcribe(utterance.pcm)
        if transcript is None or not transcript.text:
            skipped += 1
            return
        decode_s = transcript.transcribe_s + (transcript.translate_s or 0.0)
        seq = journal.append(
            session_id,
            source="system",
            lang=transcript.lang,
            text=transcript.text,
            text_en=transcript.text_en,
            text_ar=getattr(transcript, "text_ar", None),
            started_ms=int(utterance.start_ms),
            ended_ms=int(utterance.end_ms),
        )
        delivered += 1
        aud_s = utterance.duration_s
        rtf = (decode_s / aud_s) if aud_s > 0 else 0.0
        log.info(
            "seg #%d audio=%.1fs decode=%.2fs (stt=%.2fs translate=%.2fs) rtf=%.2f "
            "(%s) %d chars en=%s ar=%s",
            seq, aud_s, decode_s, transcript.transcribe_s,
            transcript.translate_s or 0.0, rtf, transcript.lang or "?",
            len(transcript.text), "y" if transcript.text_en else "-",
            "y" if getattr(transcript, "text_ar", None) else "-",
        )
        metrics_total.append((aud_s, decode_s))
        lines.append((transcript.lang or "?", transcript.text,
                      transcript.text_en or "", getattr(transcript, "text_ar", None) or ""))
        pusher.wake()
        # Live-like pacing: wait until the utterance's virtual end-of-stream.
        if speed > 0:
            target = t_start + utterance.end_ms / 1000.0 / speed
            delay = target - time.monotonic()
            if delay > 0:
                time.sleep(delay)

    for utterance in segmenter.feed(pcm):
        push_pace(utterance)
    for utterance in segmenter.flush():
        push_pace(utterance)

    pusher.stop(drain_timeout=120.0)
    counts = journal.counts(session_id)
    fatal = None
    if pusher.fatal_error is not None:
        fatal = str(pusher.fatal_error)
    if fatal is None:
        client.end_session(session_id)
        journal.set_session_status(session_id, "ended")
    total_audio = sum(m[0] for m in metrics_total)
    total_decode = sum(m[1] for m in metrics_total)
    return {
        "session_id": session_id,
        "duration_s": duration_s,
        "utterances": delivered,
        "skipped_silence": skipped,
        "counts": counts,
        "fatal": fatal,
        "lines": lines,
        "pushed_to": client.base_url,
        "stt_total_audio_s": total_audio,
        "stt_total_decode_s": total_decode,
        "stt_rtf": (total_decode / total_audio) if total_audio > 0 else 0.0,
    }
