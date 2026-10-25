"""The PC's model server: `python -m taskly_live serve`.

One machine with the GPU (Whisper + translator + local Ollama) serves the
laptops that join meetings. Each laptop keeps its own pipeline and Taskly
token (remote.py) and sends only utterance audio or a summary prompt here:

    GET  /v1/health      -> 200 {"ok": true}            (no key needed;
                            with the key: also models and device;
                            with a wrong key: 401)
    POST /v1/transcribe  <- int16 LE mono 16 kHz PCM (application/octet-stream,
                            at most 35 s)
                         -> 200 {"text", "lang", "text_en", "text_ar",
                                 "transcribe_s", "translate_s"}
                            or {"text": null} for silence
    POST /v1/complete    <- {"system": "...", "user": "..."}
                         -> 200 {"content": "..."} from the local Ollama

Every route but health needs `Authorization: Bearer <server key>`. The key
is made on first run, kept in `<data_dir>/model-server.key` and printed
with the setup lines; `serve --new-key` replaces it.

The server holds no meeting state: no sessions, tokens or transcripts are
kept, and nothing logs the words — only routes, statuses, sizes and timings.
GPU work goes through semaphores (one decode at a time by default, one
summary at a time beside it) so a burst from several laptops queues instead
of exhausting VRAM; a request that can't get a slot in time gets 503 and
the laptop's retry ladder brings it back.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
KEY_FILENAME = "model-server.key"
SAMPLE_RATE = 16_000
MAX_AUDIO_S = 35.0
MAX_PCM_BYTES = int(MAX_AUDIO_S * SAMPLE_RATE) * 2
MAX_PROMPT_BYTES = 4_000_000  # a long meeting's transcript plus the instructions
# How long a request waits for a GPU slot before answering 503 (the laptop
# retries); kept under the laptop's 60 s request timeout.
SLOT_WAIT_S = 40.0


# ---- the key ------------------------------------------------------------------------


def load_or_create_key(data_dir: Path, *, rotate: bool = False) -> tuple[str, bool]:
    """`(key, made_now)`: the stored server key, or a fresh one saved."""
    path = Path(data_dir) / KEY_FILENAME
    if not rotate and path.exists():
        key = path.read_text(encoding="utf-8").strip()
        if key:
            return key, False
    key = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(key + "\n", encoding="utf-8")
    if os.name == "posix":
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return key, True


# ---- HTTP ---------------------------------------------------------------------------


class _Refusal(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TasklyModelServer/1"
    app: "ModelServer"  # bound per server instance

    def log_message(self, fmt: str, *args: object) -> None:
        log.debug("%s %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if status == 503:
            self.send_header("Retry-After", "2")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[len("Bearer "):].strip().encode(),
                                   self.app.key.encode())

    def _read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            self.close_connection = True
            raise _Refusal(411, "Content-Length required") from None
        if length < 0 or length > limit:
            self.close_connection = True  # the unread body would poison keep-alive
            raise _Refusal(413, f"body over {limit} bytes")
        return self.rfile.read(length) if length else b""

    def _discard_body(self) -> None:
        """Read and drop the body of a request about to be refused.

        Closing on an unread upload makes Windows reset the connection, so the
        laptop would see a network error (and keep retrying) instead of the
        refusal. Anything over the size caps is not worth reading: just close.
        """
        self.close_connection = True
        try:
            remaining = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if remaining < 0 or remaining > max(MAX_PCM_BYTES, MAX_PROMPT_BYTES):
            return
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                return
            remaining -= len(chunk)

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        if self.path.split("?")[0].rstrip("/") != "/v1/health":
            self._send(404, {"error": "not found"})
            return
        payload: dict = {"ok": True}
        if self._authorized():
            payload.update(self.app.describe())
        elif self.headers.get("Authorization"):
            # A laptop checking its key at startup learns it's wrong now,
            # not on its first utterance.
            self._send(401, {"error": "unauthorized"})
            return
        self._send(200, payload)

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0].rstrip("/")
        t0 = time.perf_counter()
        try:
            if route not in ("/v1/transcribe", "/v1/complete"):
                self._discard_body()
                raise _Refusal(404, "not found")
            if not self._authorized():
                self._discard_body()
                raise _Refusal(401, "unauthorized")
            if route == "/v1/transcribe":
                status, payload = 200, self.app.transcribe(self._read_body(MAX_PCM_BYTES))
            else:
                status, payload = 200, self.app.complete(self._read_body(MAX_PROMPT_BYTES))
        except _Refusal as refusal:
            status, payload = refusal.status, {"error": refusal.message}
        self._send(status, payload)
        log.info("%s %d %.2fs", route, status, time.perf_counter() - t0)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # two `serve`s on one port should fail loudly

    def handle_error(self, request, client_address) -> None:
        exc = sys.exception()
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return  # a laptop that went away mid-request
        super().handle_error(request, client_address)


class ModelServer:
    """Owns the models, the key and the HTTP listener."""

    def __init__(self, stt, summarizer, key: str, *, host: str = DEFAULT_HOST,
                 port: int = DEFAULT_PORT, stt_slots: int = 1, complete_slots: int = 1,
                 slot_wait_s: float = SLOT_WAIT_S) -> None:
        self.stt = stt
        self.summarizer = summarizer
        self.key = key
        self.slot_wait_s = float(slot_wait_s)
        self._stt_slots = threading.BoundedSemaphore(max(1, int(stt_slots)))
        self._complete_slots = threading.BoundedSemaphore(max(1, int(complete_slots)))
        handler = type("_BoundHandler", (_Handler,), {"app": self})
        self.httpd = _Server((host, port), handler)
        self.host = host
        self.port = self.httpd.server_address[1]
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "") else self.host
        return f"http://{host}:{self.port}"

    def start(self) -> "ModelServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever,
                                        name="model-server", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def describe(self) -> dict:
        translator = getattr(self.stt, "translator", None)
        return {
            "stt": getattr(self.stt, "model_name", None),
            "device": getattr(self.stt, "device", None),
            "translator": translator.name if translator else None,
            "summarizer": getattr(self.summarizer, "name", None),
        }

    # ---- work -----------------------------------------------------------------
    def transcribe(self, body: bytes) -> dict:
        if len(body) % 2:
            raise _Refusal(400, "PCM must be whole int16 samples")
        pcm = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
        if not self._stt_slots.acquire(timeout=self.slot_wait_s):
            raise _Refusal(503, "busy")
        try:
            transcript = self.stt.transcribe(pcm) if len(pcm) else None
        except Exception as exc:  # noqa: BLE001 - the laptop retries a 500
            log.error("transcribe failed (%s)", type(exc).__name__)
            raise _Refusal(500, "transcription failed") from exc
        finally:
            self._stt_slots.release()
        if transcript is None:
            return {"text": None}
        return {
            "text": transcript.text,
            "lang": transcript.lang,
            "text_en": transcript.text_en,
            "text_ar": getattr(transcript, "text_ar", None),
            "transcribe_s": round(transcript.transcribe_s, 3),
            "translate_s": None if transcript.translate_s is None
            else round(transcript.translate_s, 3),
        }

    def complete(self, body: bytes) -> dict:
        from .summarize import SummaryError

        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _Refusal(400, "body must be JSON") from None
        if not isinstance(data, dict) or not all(
            isinstance(data.get(k), str) and data[k].strip() for k in ("system", "user")
        ):
            raise _Refusal(400, "body needs non-empty 'system' and 'user' strings")
        if self.summarizer is None:
            raise _Refusal(503, "no summarizer on this server")
        if not self._complete_slots.acquire(timeout=self.slot_wait_s):
            raise _Refusal(503, "busy")
        try:
            self._make_room_for_summary()
            content = self.summarizer.complete(data["system"], data["user"])
        except SummaryError as exc:
            raise _Refusal(502, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            log.error("complete failed (%s)", type(exc).__name__)
            raise _Refusal(500, "summary failed") from exc
        finally:
            self._complete_slots.release()
        return {"content": content}

    def _make_room_for_summary(self) -> None:
        """Unload an Ollama-hosted translator before the summary model loads.

        Whisper + Hy-MT2 + qwen3.5:4b don't fit an 8 GB card beside Windows'
        own share; a full card spills into system RAM and crawls instead of
        failing. The translator reloads by itself (a second or two, once)
        on the next line.
        """
        translator = getattr(self.stt, "translator", None)
        release = getattr(translator, "release", None)
        if callable(release) and getattr(translator, "model", None) != getattr(
                self.summarizer, "model", None):
            release()


# ---- setup lines --------------------------------------------------------------------


def reachable_addresses() -> list[str]:
    """Addresses laptops might use: Tailscale's first, then LAN, then name."""
    import socket
    import subprocess

    found: list[str] = []
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True,
                             timeout=3.0, check=False).stdout.split()
        found += [ip for ip in out if ip.count(".") == 3]
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # no packet sent: picks the LAN interface
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    found.append(socket.gethostname())
    return list(dict.fromkeys(a for a in found if a and not a.startswith("127.")))


def setup_lines(port: int, key: str, made_now: bool, key_path: Path) -> list[str]:
    hosts = reachable_addresses()
    lines = [
        "",
        f"Server key ({'new' if made_now else 'saved'}; {key_path}):",
        f"    {key}",
        "Keep it like a password: anyone with it can use this PC's models.",
        "Rotate it with `serve --new-key` (every laptop then needs the new one).",
        "",
        "On each laptop (same network or anywhere on your tailnet):",
    ]
    for host in hosts[:3]:
        lines.append(f"    --server http://{host}:{port} --server-key <key>")
    lines += [
        "or set TASKLY_MODEL_SERVER=http://<host>:%d and TASKLY_MODEL_SERVER_KEY=<key>." % port,
        "Tailscale (recommended): install it on this PC and every laptop, sign in to "
        "one tailnet, and use this PC's 100.x address above.",
        f"Windows firewall: allow inbound TCP {port} (Private network / Tailscale) once.",
        "",
    ]
    return lines
