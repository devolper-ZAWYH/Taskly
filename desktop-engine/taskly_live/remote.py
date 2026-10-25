"""Laptop side of the model server: STT + translation + summary over HTTP.

A laptop that joins meetings keeps the whole pipeline (capture -> VAD ->
journal -> push to Taskly with its own token) and only sends each
utterance's audio to the PC's model server (`python -m taskly_live serve`,
server.py) for the words. These classes stand in for the local ones:

  * `RemoteStt.transcribe(pcm) -> Transcript | None`, like `SttPipeline`;
  * `RemoteSummarizer.complete(system, user) -> str`, like `OllamaSummarizer`.

The PC never sees a Taskly token or a session id: it gets audio (or a
prompt) and returns text.

Outages: a laptop on a train, a PC that reboots. `RemoteStt` retries each
utterance with backoff for up to `retry_window_s` (5 minutes) before giving
up on it, and advertises `result_timeout_s` so the recorder waits that long
for the answer instead of its usual 30 s. Only a wrong key or audio the
server refuses fails at once — retrying those would never help.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable
from urllib.parse import urlsplit, urlunsplit

import numpy as np
import requests

from .stt import Transcript
from .summarize import DEFAULT_TIMEOUT_S as SUMMARY_TIMEOUT_S, SummaryError

log = logging.getLogger(__name__)

DEFAULT_SERVER_PORT = 8765
SAMPLE_RATE = 16_000
MAX_UTTERANCE_S = 35.0  # the server refuses longer bodies (vad caps at 30 s)
RETRY_WINDOW_S = 300.0
REQUEST_TIMEOUT_S = 60.0
# Seconds between attempts; the last step repeats until the window closes.
BACKOFF_S = (0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0)


class ModelServerError(RuntimeError):
    """The model server can't (or won't) answer this request."""


def server_url(raw: str) -> str:
    """`pc-name`, `100.64.0.7:8765` or `http://…` -> a base URL."""
    raw = raw.strip()
    if "://" not in raw:
        raw = f"http://{raw}"
    parts = urlsplit(raw)
    if not parts.hostname:
        raise ValueError(f"model server address {raw!r} has no host")
    netloc = parts.netloc if parts.port is not None else f"{parts.netloc}:{DEFAULT_SERVER_PORT}"
    return urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))


def pcm_to_wire(pcm: np.ndarray) -> bytes:
    """float32 [-1, 1] mono 16 kHz -> int16 little-endian bytes."""
    clipped = np.clip(np.asarray(pcm, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def _clamp_lang(value: object) -> str | None:
    return value if value in ("ar", "en") else None


def _opt_text(value: object) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


class RemoteStt:
    """`SttPipeline` look-alike that decodes on the model server."""

    def __init__(
        self,
        url: str,
        key: str,
        *,
        retry_window_s: float = RETRY_WINDOW_S,
        request_timeout_s: float = REQUEST_TIMEOUT_S,
        backoff_s: tuple[float, ...] = BACKOFF_S,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not key:
            raise ValueError("a model server needs its key (--server-key or "
                             "TASKLY_MODEL_SERVER_KEY; `serve` prints it)")
        self.url = server_url(url)
        self._key = key
        self.retry_window_s = float(retry_window_s)
        self.request_timeout_s = float(request_timeout_s)
        # The recorder waits this long for one utterance (recorder._Assigner):
        # the whole retry window, one last request, and a margin.
        self.result_timeout_s = self.retry_window_s + self.request_timeout_s + 30.0
        self._backoff = backoff_s or (1.0,)
        self._sleep = sleep
        self._clock = clock
        self._local = threading.local()  # one requests.Session per decode thread
        self.model_name = f"remote:{urlsplit(self.url).hostname}"
        self.language = None

    def _session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers["Authorization"] = f"Bearer {self._key}"
            self._local.session = session
        return session

    # ---- startup check ------------------------------------------------------
    def probe(self) -> dict | None:
        """The server's health with our key; None when it isn't reachable.

        A wrong key raises: every utterance would fail the same way, so the
        recording shouldn't start. An unreachable server only warns — the
        retries cover a PC that's still booting.
        """
        try:
            reply = self._session().get(f"{self.url}/v1/health", timeout=(5.0, 10.0))
        except requests.RequestException as exc:
            log.warning("model server %s not reachable yet (%s); lines will wait "
                        "for it up to %.0fs each", self.url, type(exc).__name__,
                        self.retry_window_s)
            return None
        if reply.status_code in (401, 403):
            raise ModelServerError(f"the model server at {self.url} rejected the key")
        if reply.status_code != 200:
            log.warning("model server %s health answered HTTP %d", self.url,
                        reply.status_code)
            return None
        try:
            return reply.json()
        except ValueError:
            return {}

    # ---- one utterance ------------------------------------------------------
    def transcribe(self, pcm: np.ndarray) -> Transcript | None:
        """POST the utterance; retry until the window closes; parse the line."""
        limit = int(MAX_UTTERANCE_S * SAMPLE_RATE)
        if len(pcm) > limit:
            log.warning("utterance of %.1fs trimmed to %.0fs for the model server",
                        len(pcm) / SAMPLE_RATE, MAX_UTTERANCE_S)
            pcm = pcm[:limit]
        body = pcm_to_wire(pcm)
        deadline = self._clock() + self.retry_window_s
        attempt = 0
        while True:
            t0 = time.perf_counter()
            try:
                reply = self._session().post(
                    f"{self.url}/v1/transcribe", data=body,
                    headers={"Content-Type": "application/octet-stream"},
                    timeout=(min(10.0, self.request_timeout_s), self.request_timeout_s),
                )
            except requests.RequestException as exc:
                reason = type(exc).__name__
            else:
                if reply.status_code == 200:
                    return self._parse(reply, time.perf_counter() - t0)
                if reply.status_code in (401, 403):
                    raise ModelServerError("the model server rejected the key")
                if reply.status_code in (400, 413):
                    raise ModelServerError(
                        f"the model server refused the audio (HTTP {reply.status_code})")
                reason = f"HTTP {reply.status_code}"  # 429/503 busy, 5xx, proxies
            delay = self._backoff[min(attempt, len(self._backoff) - 1)]
            if self._clock() + delay > deadline:
                raise ModelServerError(
                    f"model server unavailable for {self.retry_window_s:.0f}s ({reason})")
            attempt += 1
            log.warning("model server: %s; retry %d in %.1fs", reason, attempt, delay)
            self._sleep(delay)

    @staticmethod
    def _parse(reply: requests.Response, round_trip_s: float) -> Transcript | None:
        try:
            data = reply.json()
        except ValueError as exc:
            raise ModelServerError("the model server's reply wasn't JSON") from exc
        if not isinstance(data, dict):
            raise ModelServerError("the model server's reply wasn't an object")
        text = _opt_text(data.get("text"))
        if text is None:
            return None  # silence or a filtered hallucination
        translate_s = data.get("translate_s")
        translate_s = float(translate_s) if isinstance(translate_s, (int, float)) else None
        # What the laptop waited, network included: total_s == round trip.
        return Transcript(
            text=text,
            lang=_clamp_lang(data.get("lang")),
            text_en=_opt_text(data.get("text_en")),
            text_ar=_opt_text(data.get("text_ar")),
            transcribe_s=max(0.0, round_trip_s - (translate_s or 0.0)),
            translate_s=translate_s,
        )


class RemoteSummarizer:
    """`OllamaSummarizer` look-alike: the review draft from the PC's Ollama."""

    def __init__(self, url: str, key: str, *, timeout: float = SUMMARY_TIMEOUT_S,
                 attempts: int = 3, sleep: Callable[[float], None] = time.sleep) -> None:
        self.url = server_url(url)
        self._key = key
        self.timeout = float(timeout)
        self.attempts = max(1, int(attempts))
        self._sleep = sleep
        self.name = f"model-server:{urlsplit(self.url).hostname}"

    def complete(self, system: str, user: str) -> str:
        last = "no attempt"
        for attempt in range(self.attempts):
            if attempt:
                self._sleep(min(30.0, 5.0 * attempt))
            try:
                reply = requests.post(
                    f"{self.url}/v1/complete", json={"system": system, "user": user},
                    headers={"Authorization": f"Bearer {self._key}"},
                    timeout=(10.0, self.timeout),
                )
            except requests.Timeout as exc:
                raise SummaryError(f"the model server took longer than {self.timeout:.0f}s") from exc
            except requests.RequestException as exc:
                last = f"not reachable at {self.url} ({type(exc).__name__})"
                continue
            if reply.status_code in (401, 403):
                raise SummaryError("the model server rejected the key")
            if reply.status_code in (429, 502, 503, 504):
                last = f"HTTP {reply.status_code}: {_error_of(reply)}"
                continue
            if reply.status_code != 200:
                raise SummaryError(f"the model server answered HTTP {reply.status_code}: "
                                   f"{_error_of(reply)}")
            try:
                content = reply.json()["content"]
            except (ValueError, KeyError, TypeError) as exc:
                raise SummaryError("the model server's reply had no content") from exc
            if not isinstance(content, str) or not content.strip():
                raise SummaryError("the model server's reply was empty")
            return content
        raise SummaryError(f"the model server is {last}" if last.startswith("not")
                           else f"the model server failed: {last}")


def _error_of(reply: requests.Response) -> str:
    try:
        return str(reply.json().get("error") or "")[:200]
    except (ValueError, AttributeError):
        return ""
