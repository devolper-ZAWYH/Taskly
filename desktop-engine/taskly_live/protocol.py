"""LAN transport protocol shared by `serve` and `capture` (v0.2 split mode).

SUPERSEDED (2026-10): not wired into the CLI and not maintained. The
architecture that shipped keeps the whole pipeline on each laptop and sends
only utterance audio to the PC's model server (`serve` in server.py, client
in remote.py); see README.md and docs/live-meetings.md. Kept for reference.

Wire shape (per spec): one WebSocket; control messages are JSON (text
messages); audio travels as BINARY WS messages whose payload is a JSON
document carrying base64 PCM with a per-frame source tag:

    {"type":"frame","source":"mic","seq":123,"pcm":"<b64 int16 LE>"}

Deviation note: the spec's "20 ms frame_size=640 samples" is internally
inconsistent at 16 kHz (640 samples = 40 ms; 20 ms = 320 samples). The
protocol therefore derives the frame size from the hello-declared
sample_rate/frame_ms pair and both sides agree on it; 10/20/40 ms are
accepted, the default is 20 ms (320 samples/frame).

Handshake:
    capture -> {"type":"hello","agent":"taskly-live","version":1,
                "token":"<LAN pairing token>",
                "sources":[{"id":"mic","sample_rate":16000,"frame_ms":20}, ...]}
    serve   -> {"type":"welcome","ok":true,"version":1,
                "session_mode":"waiting"|"capturing","session":id|null}
    on failure: {"type":"error","code":"auth"|"sources"|"protocol"|,
                 "message": str} then close 4400 (malformed) / 4401 (auth).

Keepalive: websockets protocol-level pings run always; capture may also
send {"type":"heartbeat"} while idle (server treats it as a no-op counter).

Teardown:
    capture -> {"type":"bye"} (graceful local stop; lane left open, session
               continues until the operator stops `serve`)
    serve   -> {"type":"closing","reason": str} + close 1000 when the engine
               is shutting down (capture EXITS instead of reconnecting).
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
from dataclasses import dataclass

import numpy as np

AGENT = "taskly-live"
PROTOCOL_VERSION = 1

RATE = 16000  # the only sample rate on this transport
DEFAULT_FRAME_MS = 20
FRAME_MS_OPTIONS = (10, 20, 40)

SOURCE_IDS = ("mic", "system")

CLOSE_PROTOCOL = 4400  # malformed handshake / bad frame
CLOSE_AUTH = 4401      # token mismatch

MAX_FRAME_BYTES = 64 * 1024  # generous WS receive cap per message
HELLO_TIMEOUT_S = 10.0


class ProtocolError(Exception):
    """Handshake/frame violation the server should reject with `code`."""

    def __init__(self, code: int, reply: dict, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reply = reply


@dataclass(frozen=True)
class SourceSpec:
    """One declared lane in the hello (id + framing)."""

    id: str
    sample_rate: int = RATE
    frame_ms: int = DEFAULT_FRAME_MS

    @property
    def frame_size(self) -> int:
        return self.sample_rate * self.frame_ms // 1000

    def to_api(self) -> dict:
        return {
            "id": self.id,
            "sample_rate": self.sample_rate,
            "frame_ms": self.frame_ms,
        }


# ---------------------------------------------------------------------------
# auth (constant-time compare)
# ---------------------------------------------------------------------------
def check_token(expected: str, provided: str) -> bool:
    """Constant-time token comparison; empty expectations never match."""
    if not expected:
        return False
    if not isinstance(provided, str):
        return False
    return hmac.compare_digest(
        expected.encode("utf-8"), provided.encode("utf-8")
    )


# ---------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------
def build_hello(sources: list[SourceSpec], token: str) -> str:
    return json.dumps(
        {
            "type": "hello",
            "agent": AGENT,
            "version": PROTOCOL_VERSION,
            "token": token,
            "sources": [s.to_api() for s in sources],
        },
        separators=(",", ":"),
    )


def build_welcome(session_mode: str, session_id: str | None) -> str:
    return json.dumps(
        {
            "type": "welcome",
            "ok": True,
            "version": PROTOCOL_VERSION,
            "session_mode": session_mode,  # "waiting" (defer) | "capturing"
            "session": session_id,
        },
        separators=(",", ":"),
    )


def build_error(code: str, message: str) -> str:
    return json.dumps(
        {"type": "error", "code": code, "message": message[:300]},
        separators=(",", ":"),
    )


def build_frame(source: str, seq: int, pcm_int16: "np.ndarray") -> bytes:
    """Encode one frame: JSON document (with base64 int16 PCM) as bytes."""
    pcm = np.ascontiguousarray(pcm_int16, dtype="<i2").tobytes()
    return json.dumps(
        {"type": "frame", "source": source, "seq": int(seq),
         "pcm": base64.b64encode(pcm).decode("ascii")},
        separators=(",", ":"),
    ).encode("utf-8")


def build_bye() -> str:
    return json.dumps({"type": "bye"}, separators=(",", ":"))


def build_heartbeat() -> str:
    return json.dumps({"type": "heartbeat"}, separators=(",", ":"))


def build_closing(reason: str) -> str:
    return json.dumps(
        {"type": "closing", "reason": reason[:200]}, separators=(",", ":")
    )


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------
def parse_message(raw: "str | bytes") -> dict:
    """Parse any inbound WS payload into a JSON object."""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ProtocolError(
                CLOSE_PROTOCOL, build_error("protocol", f"not utf-8: {exc}"),
                "binary payload is not utf-8 JSON",
            ) from exc
    try:
        obj = json.loads(raw)
    except ValueError as exc:
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", f"bad json: {exc}"),
            "message is not JSON",
        ) from exc
    if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", "message lacks 'type'"),
            "message is not a protocol object",
        )
    return obj


def decode_hello(obj: dict, *, allowed_sources: set[str]) -> list[SourceSpec]:
    """Validate a hello; returns the declared lanes or raises ProtocolError.

    `allowed_sources` lets serve enforce its own --no-* style gates (default:
    both mic and system allowed).
    """
    if obj.get("agent") != AGENT:
        raise ProtocolError(
            CLOSE_PROTOCOL,
            build_error("protocol", f"unknown agent {obj.get('agent')!r}"),
            "unknown agent",
        )
    version = obj.get("version")
    if not isinstance(version, int) or version <= 0 or version > PROTOCOL_VERSION:
        raise ProtocolError(
            CLOSE_PROTOCOL,
            build_error("protocol", f"unsupported version {version!r}"),
            "unsupported protocol version",
        )
    raw_sources = obj.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("sources", "hello carries no sources"),
            "hello must declare at least one source",
        )
    specs: list[SourceSpec] = []
    seen: set[str] = set()
    for raw in raw_sources:
        if not isinstance(raw, dict):
            raise ProtocolError(
                CLOSE_PROTOCOL, build_error("sources", "source must be an object"),
                "malformed source declaration",
            )
        sid = raw.get("id")
        if sid not in SOURCE_IDS:
            raise ProtocolError(
                CLOSE_PROTOCOL,
                build_error("sources", f"unknown source id {sid!r}"),
                "unknown source id",
            )
        if sid in seen:
            raise ProtocolError(
                CLOSE_PROTOCOL,
                build_error("sources", f"duplicate source id {sid!r}"),
                "duplicate source id",
            )
        if sid not in allowed_sources:
            raise ProtocolError(
                CLOSE_PROTOCOL,
                build_error("sources", f"source {sid!r} is not allowed here"),
                "disallowed source",
            )
        rate = raw.get("sample_rate", RATE)
        if rate != RATE:
            raise ProtocolError(
                CLOSE_PROTOCOL,
                build_error("sources", f"source {sid!r}: sample_rate must be {RATE}"),
                "unsupported sample rate",
            )
        frame_ms = raw.get("frame_ms", DEFAULT_FRAME_MS)
        if frame_ms not in FRAME_MS_OPTIONS:
            raise ProtocolError(
                CLOSE_PROTOCOL,
                build_error(
                    "sources",
                    f"source {sid!r}: frame_ms must be one of {FRAME_MS_OPTIONS}",
                ),
                "unsupported frame size",
            )
        specs.append(SourceSpec(id=sid, sample_rate=RATE, frame_ms=int(frame_ms)))
        seen.add(sid)
    return specs


def decode_frame(
    obj: dict, frames: "dict[str, SourceSpec]"
) -> tuple[str, int, "np.ndarray"]:
    """Decode one frame object -> (source, seq, float32 mono @16 kHz).

    Raises ProtocolError on any shape/size violation (frame length must be
    EXACTLY the declared frame size — the transport only carries
    frame-aligned audio; capturing-side buffering guarantees that).
    """
    if obj.get("type") != "frame":
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", "not a frame"),
            "not a frame",
        )
    sid = obj.get("source")
    spec = frames.get(sid)
    if spec is None:
        raise ProtocolError(
            CLOSE_PROTOCOL,
            build_error("protocol", f"frame for undeclared source {sid!r}"),
            "frame for undeclared source",
        )
    seq = obj.get("seq")
    if not isinstance(seq, int) or seq < 0:
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", "frame lacks integer seq"),
            "frame lacks integer seq",
        )
    b64 = obj.get("pcm")
    if not isinstance(b64, str):
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", "frame lacks pcm payload"),
            "frame lacks pcm payload",
        )
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProtocolError(
            CLOSE_PROTOCOL, build_error("protocol", f"bad base64: {exc}"),
            "bad base64 PCM",
        ) from exc
    expected = spec.frame_size * 2
    if len(raw) != expected:
        raise ProtocolError(
            CLOSE_PROTOCOL,
            build_error(
                "protocol",
                f"frame size {len(raw)}B != declared {expected}B "
                f"({spec.frame_size} samples @ {spec.frame_ms}ms)",
            ),
            "unexpected frame size",
        )
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return sid, seq, pcm


def as_ws_payload(text: str) -> "str | bytes":
    """Control JSON goes out as TEXT; frame JSON (protocol.py only) as bytes."""
    return text
