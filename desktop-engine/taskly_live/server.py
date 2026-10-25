"""The PC's model server: `python -m taskly_live serve`.

One machine with the GPU runs the models 24/7 for every platform the user
builds. A platform connects with a URL and its own key — that's it:

  OpenAI-compatible (stock OpenAI SDKs: base_url=<server>/v1, api_key=<key>;
  openai_api.py):
    GET  /v1/models                 what's available
    POST /v1/chat/completions       -> the local Ollama (allowlisted models),
                                       streaming or not
    POST /v1/audio/transcriptions   multipart audio file -> text (Whisper)
    POST /v1/audio/translations     multipart audio file -> English text
    POST /v1/translate              {text, source?, target} Arabic <-> English
                                       (not an OpenAI route)

  Taskly's meeting recorder (remote.py), unchanged:
    POST /v1/transcribe  <- int16 LE mono 16 kHz PCM (application/octet-stream,
                            at most 35 s)
                         -> 200 {"text", "lang", "text_en", "text_ar",
                                 "transcribe_s", "translate_s"}
                            or {"text": null} for silence
    POST /v1/complete    <- {"system": "...", "user": "..."}
                         -> 200 {"content": "..."} from the local Ollama

  GET /v1/health -> {"ok": true} without a key; models, device and queues
                    with one; 401 with a wrong one.

Keys: one per platform, `Authorization: Bearer <key>`, kept as hashes in
`<data_dir>/server-keys.json` (keys.py; `serve keys add|list|revoke`), each
with usage counters. The old single `model-server.key` is imported as
"taskly-laptops" so existing laptops keep working.

Sharing the GPU: two fair queues (scheduler.py) — "speech" for Whisper and
the line translator, "llm" for Ollama — each round-robin across keys with a
per-key limit, so no platform starves another and a long chat never blocks a
live meeting's lines. A full queue answers 429 + Retry-After (OpenAI routes)
or 503 (the recorder's routes, which its retry ladder already handles).

The server holds no meeting or conversation state, and nothing logs request
content — only routes, key names, statuses, sizes and timings.
"""

from __future__ import annotations

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

from .keys import KeyInfo, KeyStore
from .scheduler import Busy, FairScheduler

log = logging.getLogger(__name__)

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
KEY_FILENAME = "model-server.key"  # the pre-key-store single key (imported once)
KEYS_FILENAME = "server-keys.json"
LEGACY_KEY_NAME = "taskly-laptops"
SAMPLE_RATE = 16_000
MAX_AUDIO_S = 35.0
MAX_PCM_BYTES = int(MAX_AUDIO_S * SAMPLE_RATE) * 2
MAX_PROMPT_BYTES = 4_000_000  # a long meeting's transcript plus the instructions
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # OpenAI's own audio upload cap
MAX_BODY_BYTES = max(MAX_PCM_BYTES, MAX_PROMPT_BYTES, MAX_UPLOAD_BYTES)
# How long a request waits for a GPU slot before it's refused (the caller
# retries); kept under the laptop's 60 s request timeout.
SLOT_WAIT_S = 40.0
# Facing the internet (Tailscale Funnel): a client that goes quiet mid-request
# or idles on a kept-alive connection is cut off after this, and at most
# MAX_CONNECTIONS are served at once, so slow or flooding clients can't
# exhaust threads. Model work itself isn't timed by this (no socket I/O).
IDLE_TIMEOUT_S = 60.0
MAX_CONNECTIONS = 64


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


def open_key_store(data_dir: Path) -> KeyStore:
    """The server's key store, with the old single key imported (once)."""
    store = KeyStore(Path(data_dir) / KEYS_FILENAME)
    legacy = Path(data_dir) / KEY_FILENAME
    if legacy.exists():
        raw = legacy.read_text(encoding="utf-8").strip()
        if raw and store.import_legacy(raw, LEGACY_KEY_NAME):
            log.info("imported the old model-server.key as %r", LEGACY_KEY_NAME)
    return store


# ---- HTTP ---------------------------------------------------------------------------


class _Refusal(Exception):
    """An error on the recorder's routes: `{"error": "<message>"}`."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TasklyModelServer/2"
    sys_version = ""  # no Python version in the Server header
    timeout = IDLE_TIMEOUT_S  # socket timeout per read/write (StreamRequestHandler)
    app: "ModelServer"  # bound per server instance

    def log_message(self, fmt: str, *args: object) -> None:
        log.debug("%s %s", self.address_string(), fmt % args)

    # ---- responses ---------------------------------------------------------
    def send_json(self, status: int, payload: dict, *, retry_after: int | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_body(status, "application/json; charset=utf-8", body,
                       retry_after=retry_after)

    def send_body(self, status: int, content_type: str, body: bytes, *,
                  retry_after: int | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        self.wfile.write(body)

    # ---- requests ----------------------------------------------------------
    def bearer(self) -> str:
        header = self.headers.get("Authorization", "")
        return header[len("Bearer "):].strip() if header.startswith("Bearer ") else ""

    def read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            self.close_connection = True
            raise _Refusal(411, "Content-Length required") from None
        if length < 0 or length > limit:
            self.close_connection = True  # the unread body would poison keep-alive
            raise _Refusal(413, f"body over {limit} bytes")
        return self.rfile.read(length) if length else b""

    def discard_body(self) -> None:
        """Read and drop the body of a request about to be refused.

        Closing on an unread upload makes Windows reset the connection, so the
        caller would see a network error (and keep retrying) instead of the
        refusal. Anything over the size caps is not worth reading: just close.
        """
        self.close_connection = True
        try:
            remaining = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if remaining < 0 or remaining > MAX_BODY_BYTES:
            return
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                return
            remaining -= len(chunk)

    # ---- routing -------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        route = self.path.split("?")[0].rstrip("/")
        if route == "/v1/health":
            self._health()
        else:
            self._openai("GET", route)  # /v1/models, or an OpenAI-shaped 404

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0].rstrip("/")
        if route in ("/v1/transcribe", "/v1/complete"):
            self._recorder(route)
        else:
            self._openai("POST", route)

    def _health(self) -> None:
        payload: dict = {"ok": True}
        if self.bearer():
            key = self.app.keys.verify(self.bearer())
            if key is None:
                # A laptop checking its key at startup learns it's wrong now,
                # not on its first utterance.
                self.send_json(401, {"error": "unauthorized"})
                return
            payload.update(self.app.describe())
        self.send_json(200, payload)

    def _recorder(self, route: str) -> None:
        """The meeting recorder's routes: their own error shape and 503s."""
        t0 = time.perf_counter()
        key: KeyInfo | None = None
        retry = None
        try:
            key = self.app.keys.verify(self.bearer())
            if key is None:
                self.discard_body()
                raise _Refusal(401, "unauthorized")
            if route == "/v1/transcribe":
                payload = self.app.transcribe(self.read_body(MAX_PCM_BYTES), key)
            else:
                payload = self.app.complete(self.read_body(MAX_PROMPT_BYTES), key)
            status = 200
        except Busy as busy:
            status, payload, retry = 503, {"error": "busy"}, busy.retry_after
        except _Refusal as refusal:
            status, payload = refusal.status, {"error": refusal.message}
        self.send_json(status, payload, retry_after=retry)
        self.app.note(route, key, status, t0)

    def _openai(self, method: str, route: str) -> None:
        from .openai_api import handle

        handle(self, method, route)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # two `serve`s on one port should fail loudly
    max_connections = MAX_CONNECTIONS

    def server_activate(self) -> None:
        self._slots = threading.BoundedSemaphore(self.max_connections)
        super().server_activate()

    def process_request(self, request, client_address) -> None:
        if not self._slots.acquire(blocking=False):
            # Over the cap: a one-line refusal, no thread, no body read.
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n"
                                b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address) -> None:
        exc = sys.exception()
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return  # a caller that went away mid-request
        super().handle_error(request, client_address)


class ModelServer:
    """Owns the models, the keys, the fair queues and the HTTP listener."""

    def __init__(self, stt, summarizer, keys: KeyStore | str, *, host: str = DEFAULT_HOST,
                 port: int = DEFAULT_PORT, stt_slots: int = 1, llm_slots: int = 2,
                 per_key: int = 1, max_queue: int = 32,
                 slot_wait_s: float = SLOT_WAIT_S,
                 ollama_url: str | None = None,
                 chat_models: list[str] | None = None,
                 complete_slots: int | None = None) -> None:
        from .summarize import DEFAULT_OLLAMA_URL

        self.stt = stt
        self.summarizer = summarizer
        # A bare string is a single key (older callers and tests).
        self.keys = KeyStore.in_memory(keys) if isinstance(keys, str) else keys
        self.slot_wait_s = float(slot_wait_s)
        self.speech = FairScheduler("speech", slots=stt_slots, per_key=per_key,
                                    max_queue=max_queue, max_wait_s=slot_wait_s)
        self.llm = FairScheduler("llm", slots=complete_slots or llm_slots, per_key=per_key,
                                 max_queue=max_queue, max_wait_s=slot_wait_s)
        self.ollama_url = (ollama_url or getattr(summarizer, "url", None)
                           or DEFAULT_OLLAMA_URL).rstrip("/")
        # Only these Ollama models are offered (None: the summary model only).
        self.chat_allowlist = list(chat_models) if chat_models else (
            [summarizer.model] if getattr(summarizer, "model", None) else [])
        self._installed: tuple[float, set[str]] = (0.0, set())
        self.ollama_up = False  # as of the last model-list read
        handler = type("_BoundHandler", (_Handler,), {"app": self})
        self.httpd = _Server((host, port), handler)
        self.host = host
        self.port = self.httpd.server_address[1]
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "") else self.host
        return f"http://{host}:{self.port}"

    @property
    def translator(self):
        return getattr(self.stt, "translator", None)

    def start(self) -> "ModelServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever,
                                        name="model-server", daemon=True)
        self._thread.start()
        threading.Thread(target=self._flush_usage, name="key-usage", daemon=True).start()
        return self

    def stop(self) -> None:
        self._stopping.set()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.keys.flush()

    def _flush_usage(self) -> None:
        """Usage counters reach the key file even when traffic stops, so
        `serve keys list` (another process) sees them within seconds."""
        while not self._stopping.wait(10.0):
            try:
                self.keys.flush()
            except OSError as exc:
                log.warning("couldn't save key usage (%s)", type(exc).__name__)

    def describe(self) -> dict:
        translator = self.translator
        return {
            "stt": getattr(self.stt, "model_name", None),
            "device": getattr(self.stt, "device", None),
            "translator": translator.name if translator else None,
            "summarizer": getattr(self.summarizer, "name", None),
            "chat_models": self.chat_models(),
            "queues": {"speech": self.speech.snapshot(), "llm": self.llm.snapshot()},
        }

    def note(self, route: str, key: KeyInfo | None, status: int, t0: float, **usage) -> None:
        """One log line and the key's usage counters — never the content."""
        name = key.name if key else "-"
        if key is not None and status < 400:
            self.keys.record(key.name, **usage)
        log.info("%s %s %d %.2fs", route, name, status, time.perf_counter() - t0)

    def chat_models(self) -> list[str]:
        """Allowlisted models that Ollama actually has (re-read every minute)."""
        import requests

        checked, installed = self._installed
        # A good answer is kept a minute; a failure only a few seconds, so
        # Ollama coming back (at boot, after a restart) is noticed at once.
        if time.monotonic() - checked > (60.0 if self.ollama_up else 5.0):
            try:
                tags = requests.get(f"{self.ollama_url}/api/tags", timeout=3.0).json()
                installed = {m.get("name") for m in tags.get("models", []) if isinstance(m, dict)}
                self.ollama_up = True
            except (requests.RequestException, ValueError):
                installed = set()  # Ollama down: offer nothing rather than fail later
                self.ollama_up = False
            self._installed = (time.monotonic(), installed)
        return [m for m in self.chat_allowlist
                if m in installed or f"{m}:latest" in installed]

    # ---- the recorder's work ------------------------------------------------
    def transcribe(self, body: bytes, key: KeyInfo) -> dict:
        if len(body) % 2:
            raise _Refusal(400, "PCM must be whole int16 samples")
        pcm = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
        with self.speech.turn(key.name, limit=key.concurrency):
            try:
                transcript = self.stt.transcribe(pcm) if len(pcm) else None
            except Exception as exc:  # noqa: BLE001 - the laptop retries a 500
                log.error("transcribe failed (%s)", type(exc).__name__)
                raise _Refusal(500, "transcription failed") from exc
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

    def complete(self, body: bytes, key: KeyInfo) -> dict:
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
        with self.llm.turn(key.name, limit=key.concurrency):
            try:
                self._make_room_for_summary()
                content = self.summarizer.complete(data["system"], data["user"])
            except SummaryError as exc:
                raise _Refusal(502, str(exc)) from exc
            except Exception as exc:  # noqa: BLE001
                log.error("complete failed (%s)", type(exc).__name__)
                raise _Refusal(500, "summary failed") from exc
        return {"content": content}

    def _make_room_for_summary(self) -> None:
        """Unload an Ollama-hosted translator before the summary model loads.

        Whisper + Hy-MT2 + qwen3.5:4b don't fit an 8 GB card beside Windows'
        own share; a full card spills into system RAM and crawls instead of
        failing. The translator reloads by itself (a second or two, once)
        on the next line.
        """
        translator = self.translator
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


def setup_lines(port: int, keys: KeyStore) -> list[str]:
    hosts = reachable_addresses()
    active = [k for k in keys.list() if k.active]
    lines = [
        "",
        f"Keys ({len(active)} active): " + (", ".join(k.name for k in active) or "none yet"),
        "Give each platform its own: `python -m taskly_live serve keys add <name>`",
        "(prints the key once), `keys list`, `keys revoke <name>`.",
        "",
        "Connect a platform (OpenAI SDKs: base_url=<url>/v1, api_key=<key>):",
    ]
    for host in hosts[:3]:
        lines.append(f"    http://{host}:{port}/v1")
    lines += [
        "Taskly laptops: --server http://<host>:%d --server-key <key>" % port,
        "Tailscale (recommended): install it on this PC and every client, sign in to "
        "one tailnet, and use this PC's 100.x address above.",
        f"Windows firewall: allow inbound TCP {port} (Private network / Tailscale) once.",
        "",
    ]
    return lines
