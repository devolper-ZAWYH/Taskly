"""OpenAI-compat helpers: multipart parsing (binary-safe), in-memory audio
decoding, response formats, the error envelope and language detection."""

from __future__ import annotations

import io
import json
import math
import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from taskly_live.openai_io import (
    OpenAIError,
    UploadedFile,
    decode_audio,
    detect_language,
    parse_multipart,
    transcription_response,
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
BINARY = b"\x00\r\n--x\xff\r\n\r\n\x80"


def multipart(boundary: str, fields: dict[str, str], files: dict[str, tuple[str, str, bytes]]) -> bytes:
    out = b""
    for name, value in fields.items():
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
        ).encode() + value.encode("utf-8") + b"\r\n"
    for name, (filename, ctype, data) in files.items():
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
        ).encode() + data + b"\r\n"
    return out + f"--{boundary}--\r\n".encode()


# ---- multipart ------------------------------------------------------------------------


def test_multipart_fields_and_binary_file():
    body = multipart(
        "----WebKitFormBoundaryAbC123",
        {"model": "whisper-1", "language": "ar", "prompt": "مرحبا"},
        {"file": ("meeting.mp3", "audio/mpeg", BINARY)},
    )
    fields, files = parse_multipart(
        "multipart/form-data; boundary=----WebKitFormBoundaryAbC123", body
    )
    assert fields == {"model": "whisper-1", "language": "ar", "prompt": "مرحبا"}
    assert files == {"file": UploadedFile("meeting.mp3", "audio/mpeg", BINARY)}


def test_multipart_quoted_boundary_and_filename_without_content_type():
    body = (
        b'--bound ary;42\r\nContent-Disposition: form-data; name="file"; filename="a b.wav"\r\n\r\n'
        + BINARY
        + b"\r\n--bound ary;42--\r\n"
    )
    fields, files = parse_multipart('multipart/form-data; boundary="bound ary;42"', body)
    assert fields == {}
    assert files["file"].filename == "a b.wav"
    assert files["file"].content_type == "application/octet-stream"
    assert files["file"].data == BINARY


def test_multipart_repeated_field_keeps_last_and_empty_value():
    body = multipart(
        "b", {"timestamp_granularities[]": "word", "temperature": ""}, {}
    )
    body = body[: -len(b"--b--\r\n")] + (
        b'--b\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\n'
        b"segment\r\n--b--\r\n"
    )
    fields, files = parse_multipart("multipart/form-data; boundary=b", body)
    assert fields == {"timestamp_granularities[]": "segment", "temperature": ""}
    assert files == {}


def test_multipart_missing_boundary_is_400():
    with pytest.raises(OpenAIError) as err:
        parse_multipart("multipart/form-data", b"--x\r\n\r\n--x--\r\n")
    assert err.value.status == 400


def test_multipart_non_multipart_is_400():
    for ctype in ("application/json", ""):
        with pytest.raises(OpenAIError) as err:
            parse_multipart(ctype, b"{}")
        assert err.value.status == 400


def test_multipart_malformed_bodies_are_400():
    for body in (b"", b"no delimiter anywhere", b"--x\r\nContent-Disposition: form-data\r\n\r\nv\r\n--x--"):
        with pytest.raises(OpenAIError) as err:
            parse_multipart("multipart/form-data; boundary=x", body)
        assert err.value.status == 400


# ---- audio ----------------------------------------------------------------------------


def _check_pcm(pcm: np.ndarray, duration: float, expected: float, tol: float = 0.3):
    assert pcm.dtype == np.float32
    assert pcm.ndim == 1
    assert abs(duration - expected) < tol
    assert abs(len(pcm) - expected * 16000) < tol * 16000
    assert len(pcm) / 16000 == pytest.approx(duration)
    assert float(pcm.min()) >= -1.0 and float(pcm.max()) <= 1.0
    assert float(np.abs(pcm).max()) > 0.01  # not silence


@pytest.mark.parametrize("name,expected", [("clip-en2.mp3", 9.4), ("clip-ar.mp3", 13.1)])
def test_decode_fixture_mp3(name: str, expected: float):
    pcm, duration = decode_audio((FIXTURES / name).read_bytes(), name)
    _check_pcm(pcm, duration, expected)


def _wav_bytes(seconds: float = 1.0, rate: int = 44100, channels: int = 2) -> bytes:
    n = int(seconds * rate)
    frames = bytearray()
    for i in range(n):
        v = int(0.5 * 32767 * math.sin(2 * math.pi * 440 * i / rate))
        frames += struct.pack("<h", v) * channels
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def test_decode_stereo_44k_wav_to_mono_16k():
    pcm, duration = decode_audio(_wav_bytes(), "tone.wav")
    _check_pcm(pcm, duration, 1.0, tol=0.05)
    # PyAV's stereo->mono downmix weights each channel by ~0.707, so identical
    # channels come out ~1.41x louder (0.5 -> ~0.71); still inside [-1, 1].
    assert 0.4 < float(np.abs(pcm).max()) <= 1.0


def test_decode_wave_fallback_when_av_fails(monkeypatch: pytest.MonkeyPatch):
    from taskly_live import openai_io

    def boom(data, max_seconds):
        raise RuntimeError("av says no")

    monkeypatch.setattr(openai_io, "_decode_with_av", boom)
    pcm, duration = decode_audio(_wav_bytes(), "tone.wav")
    _check_pcm(pcm, duration, 1.0, tol=0.05)


@pytest.mark.parametrize("data", [b"", b"this is definitely not audio" * 50, bytes(range(256)) * 20])
def test_decode_garbage_is_400(data: bytes):
    with pytest.raises(OpenAIError) as err:
        decode_audio(data, "x.mp3")
    assert err.value.status == 400
    assert err.value.message == "could not decode audio file"
    assert err.value.param == "file"


def test_decode_over_max_seconds_is_413():
    with pytest.raises(OpenAIError) as err:
        decode_audio(_wav_bytes(2.0), "tone.wav", max_seconds=1.0)
    assert err.value.status == 413
    with pytest.raises(OpenAIError) as err:
        decode_audio((FIXTURES / "clip-en2.mp3").read_bytes(), "c.mp3", max_seconds=3.0)
    assert err.value.status == 413


# ---- responses ------------------------------------------------------------------------

SEGMENTS = [(0.0, 1.5, "Hello there."), (1.5, 3723.25, " Second line ")]


def _render(fmt: str | None, **kw):
    args = dict(language="en", duration=3723.25, segments=SEGMENTS, response_format=fmt)
    args.update(kw)
    return transcription_response("Hello there. Second line", **args)


def test_json_format():
    ctype, body = _render("json")
    assert ctype == "application/json"
    assert json.loads(body) == {"text": "Hello there. Second line"}
    assert _render(None)[1] == body  # json is the default


def test_arabic_text_is_not_escaped():
    ctype, body = transcription_response(
        "مرحبا بالعالم", language="ar", duration=1.0, segments=[], response_format="json"
    )
    assert "مرحبا بالعالم".encode("utf-8") in body
    assert b"\\u" not in body


def test_text_format():
    ctype, body = _render("text")
    assert ctype == "text/plain; charset=utf-8"
    assert body.decode("utf-8").strip() == "Hello there. Second line"


def test_verbose_json_shape_and_language_names():
    ctype, body = _render("verbose_json")
    assert ctype == "application/json"
    data = json.loads(body)
    assert list(data) == ["task", "language", "duration", "text", "segments"]
    assert data["task"] == "transcribe"
    assert data["language"] == "english"
    assert data["duration"] == 3723.25
    assert data["segments"][1] == {
        "id": 1, "seek": 0, "start": 1.5, "end": 3723.25, "text": " Second line ",
        "tokens": [], "temperature": 0.0, "avg_logprob": 0.0,
        "compression_ratio": 0.0, "no_speech_prob": 0.0,
    }
    assert json.loads(_render("verbose_json", language="ar", task="translate")[1])["language"] == "arabic"
    assert json.loads(_render("verbose_json", language="ar", task="translate")[1])["task"] == "translate"
    assert json.loads(_render("verbose_json", language="FR")[1])["language"] == "fr"


def test_verbose_json_arabic_round_trips_unescaped():
    _, body = transcription_response(
        "أهلا", language="ar", duration=2.0,
        segments=[(0.0, 2.0, "أهلا")], response_format="verbose_json",
    )
    assert "أهلا".encode("utf-8") in body and b"\\u" not in body


def test_srt_format():
    ctype, body = _render("srt")
    assert ctype.startswith("text/plain")
    assert body.decode("utf-8") == (
        "1\n00:00:00,000 --> 00:00:01,500\nHello there.\n\n"
        "2\n00:00:01,500 --> 01:02:03,250\nSecond line\n"
    )


def test_vtt_format():
    ctype, body = _render("vtt")
    assert ctype.startswith("text/vtt")
    assert body.decode("utf-8") == (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:01.500\nHello there.\n\n"
        "00:00:01.500 --> 01:02:03.250\nSecond line\n"
    )


def test_unknown_format_is_400():
    with pytest.raises(OpenAIError) as err:
        _render("docx")
    assert err.value.status == 400
    assert err.value.param == "response_format"


# ---- errors ---------------------------------------------------------------------------


def test_error_body_shape():
    err = OpenAIError(400, "bad thing", param="file")
    assert err.body() == {
        "error": {"message": "bad thing", "type": "invalid_request_error", "param": "file", "code": None}
    }
    assert err.status == 400 and str(err) == "bad thing"


def test_error_type_and_code_defaults():
    assert OpenAIError(503, "busy").body()["error"]["type"] == "server_error"
    assert OpenAIError(429, "slow down").body()["error"]["code"] == "rate_limit_exceeded"
    assert OpenAIError(401, "no").body()["error"]["code"] == "invalid_api_key"
    explicit = OpenAIError(400, "m", type="t", code="c", param="p")
    assert explicit.body() == {"error": {"message": "m", "type": "t", "param": "p", "code": "c"}}


# ---- language -------------------------------------------------------------------------


def test_detect_language():
    assert detect_language("مرحبا بكم في الاجتماع") == "ar"
    assert detect_language("Hello, this is a meeting 123") == "en"
    assert detect_language("") == "en"
    assert detect_language("1234 !!!") == "en"
    assert detect_language("اجتماع الفريق اليوم about the Q3 plan") == "ar"
    assert detect_language("the weekly meeting اجتماع") == "en"
    assert detect_language("ﺍﻠﺍﺟﺨﺑﺎﺩ") == "ar"  # presentation forms
