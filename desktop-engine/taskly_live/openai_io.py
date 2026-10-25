"""Pure helpers for the model server's OpenAI-compatible routes.

Stock OpenAI SDKs post `multipart/form-data` audio to
`/v1/audio/transcriptions`, expect OpenAI's exact error envelope, and ask for
one of five `response_format`s. Everything here is transport-free (bytes in,
bytes out) so the stdlib `http.server` handler stays thin and these can be
tested without a socket.

Multipart is parsed by hand: Python 3.13 removed `cgi`, and the `email`
package's MIME parser normalises line endings and decodes text parts, which
corrupts a binary audio upload. Splitting on the boundary keeps file bytes
exact.

Audio is decoded from memory by PyAV (so mp3/m4a/ogg/opus/webm/flac/wav all
work without temp files), with the stdlib `wave` module as a fallback for
plain PCM WAV, mirroring `replay.load_pcm_mono_16k`.
"""

from __future__ import annotations

import io
import json
import logging
import wave
from dataclasses import dataclass
from email.parser import Parser

import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
DEFAULT_MAX_AUDIO_S = 2 * 60 * 60.0  # a long meeting; beyond this is a mistake

# OpenAI reports the language as an English name, not an ISO code.
_LANGUAGE_NAMES = {"ar": "arabic", "en": "english"}

RESPONSE_FORMATS = ("json", "text", "verbose_json", "srt", "vtt")


# ---- errors ---------------------------------------------------------------------------


class OpenAIError(Exception):
    """An error the route code turns into OpenAI's `{"error": {...}}` envelope.

    `type` and `code` default from the status so callers usually pass only the
    status and a message: 5xx is a `server_error`, 429 carries the
    `rate_limit_exceeded` code and 401 `invalid_api_key`, as the SDKs' own
    retry/auth handling keys off them.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        param: str | None = None,
        type: str | None = None,  # noqa: A002 - matches OpenAI's field name
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = int(status)
        self.message = message
        self.param = param
        if type is None:
            type = "server_error" if self.status >= 500 else "invalid_request_error"
        self.type = type
        if code is None:
            code = {429: "rate_limit_exceeded", 401: "invalid_api_key"}.get(self.status)
        self.code = code

    def body(self) -> dict:
        return {
            "error": {
                "message": self.message,
                "type": self.type,
                "param": self.param,
                "code": self.code,
            }
        }


# ---- multipart ------------------------------------------------------------------------


@dataclass
class UploadedFile:
    filename: str
    content_type: str
    data: bytes


def _boundary(content_type: str) -> bytes:
    """Pull the boundary out of a `multipart/form-data; boundary=...` header."""
    if not content_type or not content_type.lower().lstrip().startswith("multipart/"):
        raise OpenAIError(
            400, "Content-Type must be multipart/form-data", param="content-type"
        )
    from email.message import Message

    msg = Message()
    msg["Content-Type"] = content_type
    boundary = msg.get_param("boundary")
    if isinstance(boundary, tuple):  # RFC 2231 form: (charset, lang, value)
        boundary = boundary[2]
    if not boundary or not str(boundary).strip():
        raise OpenAIError(400, "multipart boundary is missing", param="content-type")
    return str(boundary).encode("latin-1", errors="replace")


def parse_multipart(
    content_type: str, body: bytes
) -> tuple[dict[str, str], dict[str, UploadedFile]]:
    """Split a multipart/form-data body into (fields, files).

    A repeated name keeps its last value (SDKs send `timestamp_granularities[]`
    that way; we only need it not to crash). Parts with a `filename` are files,
    all others are UTF-8 text fields.
    """
    boundary = _boundary(content_type)
    delimiter = b"--" + boundary
    # Prepend CRLF so the very first delimiter looks like every other one
    # (the spec's delimiter includes the CRLF that precedes it).
    chunks = (b"\r\n" + body).split(b"\r\n" + delimiter)
    if len(chunks) < 2:
        raise OpenAIError(400, "multipart body has no parts", param="body")

    fields: dict[str, str] = {}
    files: dict[str, UploadedFile] = {}
    closed = False
    for chunk in chunks[1:]:  # chunks[0] is the (ignored) preamble
        if chunk.startswith(b"--"):
            closed = True
            break
        # Optional transport padding, then the CRLF ending the delimiter line.
        eol = chunk.find(b"\r\n")
        if eol < 0 or chunk[:eol].strip(b" \t"):
            raise OpenAIError(400, "malformed multipart delimiter", param="body")
        part = chunk[eol + 2 :]
        if part.startswith(b"\r\n"):  # no headers at all
            head, data = b"", part[2:]
        else:
            sep = part.find(b"\r\n\r\n")
            if sep < 0:
                raise OpenAIError(400, "malformed multipart part headers", param="body")
            head, data = part[:sep], part[sep + 4 :]

        headers = Parser().parsestr(head.decode("utf-8", errors="replace"))
        if headers.get_content_disposition() != "form-data":
            raise OpenAIError(400, "multipart part is not form-data", param="body")
        name = headers.get_param("name", header="content-disposition")
        if isinstance(name, tuple):
            name = name[2]
        if not name:
            raise OpenAIError(400, "multipart part has no name", param="body")
        name = str(name)
        filename = headers.get_filename()
        if filename is not None:
            files[name] = UploadedFile(
                filename=str(filename),
                content_type=headers.get_content_type()
                if headers.get("Content-Type")
                else "application/octet-stream",
                data=data,
            )
        else:
            fields[name] = data.decode("utf-8", errors="replace")
    if not closed:
        # Tolerate a missing closing delimiter if we got at least one part:
        # some clients truncate it, and the data we hold is complete.
        log.debug("multipart body had no closing delimiter")
    if not fields and not files:
        raise OpenAIError(400, "multipart body has no parts", param="body")
    return fields, files


# ---- audio ----------------------------------------------------------------------------


def decode_audio(
    data: bytes, filename: str = "", *, max_seconds: float = DEFAULT_MAX_AUDIO_S
) -> tuple[np.ndarray, float]:
    """Decode an uploaded audio file to (mono float32 at 16 kHz, duration_s).

    PyAV reads the container from memory, so the upload never touches disk.
    Raises OpenAIError(400) when nothing decodable is found and 413 when the
    decoded audio runs past `max_seconds` (checked while decoding, so an
    oversized file is refused early instead of fully expanded in RAM).
    """
    if not data:
        raise OpenAIError(400, "could not decode audio file", param="file")
    try:
        return _decode_with_av(data, max_seconds)
    except OpenAIError:
        raise
    except ImportError as exc:
        raise OpenAIError(
            500, f"audio decoding is unavailable: {exc}", type="server_error"
        ) from exc
    except Exception as exc:  # noqa: BLE001 - try stdlib before giving up
        log.debug("PyAV decode of %r failed (%s); trying stdlib wave", filename, exc)
    try:
        return _decode_with_wave(data, max_seconds)
    except OpenAIError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.debug("wave decode of %r failed (%s)", filename, exc)
        raise OpenAIError(400, "could not decode audio file", param="file") from exc


def _too_long(max_seconds: float) -> OpenAIError:
    return OpenAIError(
        413,
        f"audio is longer than the {max_seconds / 60:.0f} minute limit",
        param="file",
    )


def _decode_with_av(data: bytes, max_seconds: float) -> tuple[np.ndarray, float]:
    import av

    max_samples = int(max_seconds * SAMPLE_RATE)
    chunks: list[np.ndarray] = []
    total = 0

    def take(frames) -> None:
        nonlocal total
        for rf in frames:
            arr = rf.to_ndarray().ravel().astype(np.float32, copy=False)
            total += arr.size
            if total > max_samples:
                raise _too_long(max_seconds)
            chunks.append(arr)

    # A file object, not a path: `av.open(path)` under faster-whisper's PyAV
    # build tripped over the `metadata_errors` argument; BytesIO sidesteps it.
    with av.open(io.BytesIO(data)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("no audio stream")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(stream):
            take(resampler.resample(frame))
        take(resampler.resample(None))  # flush what the resampler still holds
    if total == 0:
        raise RuntimeError("no audio frames decoded")
    pcm = np.clip(np.concatenate(chunks), -1.0, 1.0)
    return pcm, len(pcm) / SAMPLE_RATE


def _decode_with_wave(data: bytes, max_seconds: float) -> tuple[np.ndarray, float]:
    from .audio import resample_to_16k

    with wave.open(io.BytesIO(data), "rb") as wf:
        n_channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        if rate <= 0 or wf.getnframes() / rate > max_seconds:
            if rate > 0:
                raise _too_long(max_seconds)
            raise RuntimeError("invalid sample rate")
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        arr = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2**31
    elif width == 1:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise RuntimeError(f"unsupported sample width {width} bytes")
    if n_channels > 1:
        arr = arr[: arr.size - arr.size % n_channels].reshape(-1, n_channels).mean(axis=1)
    pcm = np.clip(resample_to_16k(arr, rate), -1.0, 1.0)
    if pcm.size == 0:
        raise RuntimeError("no audio frames decoded")
    return pcm, pcm.size / SAMPLE_RATE


# ---- responses ------------------------------------------------------------------------


def _timestamp(seconds: float, sep: str) -> str:
    ms = max(0, int(round(float(seconds) * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _json_body(obj: dict) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def transcription_response(
    text: str,
    *,
    language: str | None,
    duration: float,
    segments: list[tuple[float, float, str]],
    response_format: str | None = "json",
    task: str = "transcribe",
) -> tuple[str, bytes]:
    """Render a transcription in OpenAI's `response_format`, as (content_type, body).

    `segments` are (start_s, end_s, text). `language` is an ISO code and is
    reported the way OpenAI does ("arabic", "english"); unknown codes pass
    through lowercased.
    """
    fmt = (response_format or "json").strip().lower()
    if fmt == "json":
        return "application/json", _json_body({"text": text})
    if fmt == "text":
        # OpenAI ends the plain-text body with a newline.
        return "text/plain; charset=utf-8", (text + "\n").encode("utf-8")
    if fmt == "verbose_json":
        code = (language or "").strip().lower()
        return "application/json", _json_body(
            {
                "task": task,
                "language": _LANGUAGE_NAMES.get(code, code),
                "duration": float(duration),
                "text": text,
                "segments": [
                    {
                        "id": i,
                        "seek": 0,
                        "start": float(start),
                        "end": float(end),
                        "text": seg_text,
                        "tokens": [],
                        "temperature": 0.0,
                        "avg_logprob": 0.0,
                        "compression_ratio": 0.0,
                        "no_speech_prob": 0.0,
                    }
                    for i, (start, end, seg_text) in enumerate(segments)
                ],
            }
        )
    if fmt == "srt":
        cues = [
            f"{i}\n{_timestamp(start, ',')} --> {_timestamp(end, ',')}\n{seg_text.strip()}\n"
            for i, (start, end, seg_text) in enumerate(segments, 1)
        ]
        return "text/plain; charset=utf-8", "\n".join(cues).encode("utf-8")
    if fmt == "vtt":
        cues = [
            f"{_timestamp(start, '.')} --> {_timestamp(end, '.')}\n{seg_text.strip()}\n"
            for start, end, seg_text in segments
        ]
        return "text/vtt; charset=utf-8", ("WEBVTT\n\n" + "\n".join(cues)).encode("utf-8")
    raise OpenAIError(
        400,
        f"response_format must be one of {', '.join(RESPONSE_FORMATS)}",
        param="response_format",
    )


# ---- language -------------------------------------------------------------------------

_ARABIC_RANGES = (
    (0x0600, 0x06FF),
    (0x0750, 0x077F),
    (0x08A0, 0x08FF),
    (0xFB50, 0xFDFF),  # presentation forms A
    (0xFE70, 0xFEFF),  # presentation forms B
)


def _is_arabic(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _ARABIC_RANGES)


def detect_language(text: str) -> str:
    """"ar" when most letters are Arabic-script, else "en".

    Only used to pick a translation direction when the caller gave no
    `source`, so a cheap script check beats loading a language-id model.
    """
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "en"
    arabic = sum(1 for c in letters if _is_arabic(c))
    return "ar" if arabic * 2 > len(letters) else "en"
