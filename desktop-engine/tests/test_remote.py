"""Laptop side of the model server: URL normalisation, the wire format, the
transcribe/summary clients against a real ModelServer on 127.0.0.1 and against
a scripted stdlib server, with retries driven by an injected fake clock."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
import requests

from taskly_live import remote
from taskly_live.remote import (
    ModelServerError,
    RemoteStt,
    RemoteSummarizer,
    pcm_to_wire,
    server_url,
)
from taskly_live.server import ModelServer
from taskly_live.stt import Transcript
from taskly_live.summarize import SummaryError

KEY = "test-server-key"


# ---- fakes --------------------------------------------------------------------------


class FakeStt:
    model_name = "fake-whisper"
    device = "cpu"
    translator = None

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.result: Transcript | None = None
        self.received: list[np.ndarray] = []

    def transcribe(self, pcm):
        self.received.append(np.asarray(pcm))
        return self.result


class FakeSummarizer:
    name = "fake-ollama"

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.content = "## Summary\nAll good."
        self.error: Exception | None = None
        self.calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        if self.error is not None:
            raise self.error
        return self.content


class Clock:
    """Fake time: `sleep` records the delay and advances `clock`, no real waiting."""

    def __init__(self):
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class Scripted:
    """A stdlib server that answers each request from a queue of (status, payload)."""

    def __init__(self):
        self.replies: list[tuple[int, dict]] = []
        self.seen: list[tuple[str, str, str | None]] = []
        self.url = ""


@pytest.fixture()
def scripted(scripted_server):
    scripted_server.replies.clear()
    scripted_server.seen.clear()
    return scripted_server


@pytest.fixture(scope="module")
def scripted_server():
    state = Scripted()

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            state.seen.append((self.command, self.path, self.headers.get("Authorization")))
            status, payload = (state.replies.pop(0) if state.replies
                               else (500, {"error": "no scripted reply left"}))
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = _answer
        do_POST = _answer

        def log_message(self, *args):  # keep pytest output quiet
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state.url = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield state
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope="module")
def shared_server():
    # One listener per module (stopping one costs ~0.5 s); fakes reset per test.
    server = ModelServer(FakeStt(), FakeSummarizer(), KEY, host="127.0.0.1", port=0).start()
    yield server
    server.stop()


@pytest.fixture()
def served(shared_server):
    shared_server.stt.reset()
    shared_server.summarizer.reset()
    return shared_server


def closed_port_url() -> str:
    """A 127.0.0.1 URL where nothing is listening (connection refused)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


@pytest.fixture()
def refused(monkeypatch):
    """Every request fails as a refused connection, at once. A real refused
    connection takes ~2 s on this Windows machine, which would blow the budget
    across the retry tests; the real path is still covered by the probe test."""

    def refuse(*args, **kwargs):
        raise requests.ConnectionError("connection refused (simulated)")

    monkeypatch.setattr(requests.Session, "post", refuse)
    monkeypatch.setattr(requests, "post", refuse)


def speech(seconds: float = 0.1) -> np.ndarray:
    return np.full(int(16_000 * seconds), 0.25, dtype=np.float32)


TRANSCRIPT_OK = {
    "text": "مرحبا", "lang": "ar", "text_en": "Hello", "text_ar": "مرحبا",
    "transcribe_s": 0.2, "translate_s": 0.05,
}


# ---- server_url -----------------------------------------------------------------------


@pytest.mark.parametrize("raw, expected", [
    ("pc", "http://pc:8765"),
    ("  pc  ", "http://pc:8765"),
    ("100.64.0.7", "http://100.64.0.7:8765"),
    ("100.64.0.7:9000", "http://100.64.0.7:9000"),
    ("http://x/", "http://x:8765"),
    ("http://x", "http://x:8765"),
    ("https://x:443/", "https://x:443"),
])
def test_server_url_fills_scheme_and_port(raw, expected):
    assert server_url(raw) == expected


@pytest.mark.parametrize("raw", ["tp", "http", "ttp:9000"])
def test_server_url_port_goes_after_the_host_even_when_it_matches_the_scheme(raw):
    # Known failing: the port is inserted with str.replace, which hits the first
    # occurrence of the host text, i.e. inside "http://" (tp -> "http:8765://tp").
    host, _, port = raw.partition(":")
    expected = f"http://{host}:{port or 8765}"
    assert server_url(raw) == expected


@pytest.mark.parametrize("raw", ["", "   "])
def test_server_url_without_a_host_is_refused(raw):
    with pytest.raises(ValueError):
        server_url(raw)


def test_server_url_scheme_only_is_refused():
    # Known failing: "http://" is stripped to "http:", no "://" is found, and it
    # becomes "http://http:" -> returned as garbage instead of raising ValueError.
    with pytest.raises(ValueError):
        server_url("http://")


# ---- pcm_to_wire ----------------------------------------------------------------------


def test_wire_format_is_int16_little_endian():
    assert pcm_to_wire(np.array([1.0], dtype=np.float32)) == b"\xff\x7f"   # 32767
    assert pcm_to_wire(np.array([-1.0], dtype=np.float32)) == b"\x01\x80"  # -32767
    assert pcm_to_wire(np.array([0.0], dtype=np.float32)) == b"\x00\x00"


def test_wire_format_clips_out_of_range_samples():
    wire = pcm_to_wire(np.array([2.0, -3.0, 0.5], dtype=np.float32))
    assert np.frombuffer(wire, dtype="<i2").tolist() == [32767, -32767, 16383]


def test_wire_format_is_two_bytes_per_sample():
    assert len(pcm_to_wire(np.zeros(1600, dtype=np.float32))) == 3200


def test_wire_accepts_float64_input():
    wire = pcm_to_wire(np.array([0.5, -0.5]))  # float64 in, same int16 out
    assert np.frombuffer(wire, dtype="<i2").tolist() == [16383, -16383]


# ---- RemoteStt construction -------------------------------------------------------------


def test_a_key_is_required():
    with pytest.raises(ValueError, match="key"):
        RemoteStt("pc", "")


def test_result_timeout_outlasts_the_retry_window():
    stt = RemoteStt("pc", KEY, retry_window_s=300.0, request_timeout_s=60.0)
    assert stt.result_timeout_s > stt.retry_window_s
    assert stt.url == "http://pc:8765"
    assert stt.model_name == "remote:pc"


# ---- RemoteStt against a real ModelServer (127.0.0.1) -----------------------------------


def test_transcribe_round_trip_returns_both_languages(served):
    served.stt.result = Transcript(
        text="مرحبا", lang="ar", text_en="Hello", transcribe_s=0.2,
        translate_s=0.05, text_ar="مرحبا",
    )
    stt = RemoteStt(served.url, KEY)
    line = stt.transcribe(speech(0.1))

    assert isinstance(line, Transcript)
    assert line.text == "مرحبا"
    assert line.lang == "ar"
    assert line.text_en == "Hello"
    assert line.text_ar == "مرحبا"
    assert line.translate_s == pytest.approx(0.05)
    assert line.transcribe_s >= 0.0


def test_the_server_decodes_the_same_samples_it_was_sent(served):
    served.stt.result = None
    RemoteStt(served.url, KEY).transcribe(speech(0.1))
    (received,) = served.stt.received
    assert len(received) == 1600
    assert np.allclose(received, 0.25, atol=1e-4)


def test_silence_comes_back_as_none(served):
    served.stt.result = None  # the fake hears nothing
    assert RemoteStt(served.url, KEY).transcribe(speech(0.1)) is None


def test_wrong_key_fails_at_once_without_retrying(served):
    sleeps: list[float] = []
    stt = RemoteStt(served.url, "not-the-key", sleep=sleeps.append)
    with pytest.raises(ModelServerError, match="rejected the key"):
        stt.transcribe(speech())
    assert sleeps == []
    assert served.stt.received == []


def test_probe_with_the_right_key_reports_the_models(served):
    health = RemoteStt(served.url, KEY).probe()
    assert health is not None
    assert health["ok"] is True
    assert health["stt"] == "fake-whisper"


def test_probe_with_a_wrong_key_raises(served):
    # Known failing: the server answers /v1/health 200 {"ok": true} to any key
    # (health is open by design), so probe() never sees the rejection. See report.
    with pytest.raises(ModelServerError):
        RemoteStt(served.url, "not-the-key").probe()


def test_probe_raises_on_a_401_reply(scripted):
    scripted.replies.append((401, {"error": "unauthorized"}))
    with pytest.raises(ModelServerError, match="rejected the key"):
        RemoteStt(scripted.url, KEY).probe()


def test_probe_is_none_when_the_server_is_unreachable():
    assert RemoteStt(closed_port_url(), KEY).probe() is None


# ---- retries ----------------------------------------------------------------------------


def test_busy_twice_then_success_retries_with_backoff(scripted):
    scripted.replies += [
        (503, {"error": "busy"}),
        (503, {"error": "busy"}),
        (200, TRANSCRIPT_OK),
    ]
    clock = Clock()
    stt = RemoteStt(scripted.url, KEY, sleep=clock.sleep, clock=clock.clock)

    line = stt.transcribe(speech())

    assert line is not None and line.text == "مرحبا"
    assert len(scripted.seen) == 3
    assert clock.sleeps == [0.5, 1.0]  # BACKOFF_S: the first two steps


def test_every_request_carries_the_bearer_key(scripted):
    scripted.replies.append((200, TRANSCRIPT_OK))
    RemoteStt(scripted.url, KEY).transcribe(speech())
    method, path, auth = scripted.seen[0]
    assert (method, path) == ("POST", "/v1/transcribe")
    assert auth == f"Bearer {KEY}"


def test_connection_refused_until_the_window_closes(refused):
    clock = Clock()
    stt = RemoteStt("pc", KEY, retry_window_s=3.0,
                    backoff_s=(0.5, 1.0, 2.0), sleep=clock.sleep, clock=clock.clock)

    with pytest.raises(ModelServerError, match="unavailable for 3s"):
        stt.transcribe(speech())

    assert sum(clock.sleeps) <= 3.0
    assert clock.sleeps == [0.5, 1.0]  # the 2.0 s step would overrun the window


def test_a_server_that_stays_busy_gives_up_inside_the_window(scripted):
    scripted.replies = [(503, {"error": "busy"})] * 50
    clock = Clock()
    stt = RemoteStt(scripted.url, KEY, retry_window_s=3.0, backoff_s=(0.5, 1.0, 2.0),
                    sleep=clock.sleep, clock=clock.clock)

    with pytest.raises(ModelServerError, match="HTTP 503"):
        stt.transcribe(speech())

    assert sum(clock.sleeps) <= 3.0


@pytest.mark.parametrize("status", [400, 413])
def test_refused_audio_fails_at_once(scripted, status):
    scripted.replies.append((status, {"error": "no"}))
    sleeps: list[float] = []
    stt = RemoteStt(scripted.url, KEY, sleep=sleeps.append)
    with pytest.raises(ModelServerError, match=f"HTTP {status}"):
        stt.transcribe(speech())
    assert sleeps == []
    assert len(scripted.seen) == 1


def test_401_fails_at_once_without_retrying(scripted):
    scripted.replies.append((401, {"error": "unauthorized"}))
    sleeps: list[float] = []
    stt = RemoteStt(scripted.url, KEY, sleep=sleeps.append)
    with pytest.raises(ModelServerError, match="rejected the key"):
        stt.transcribe(speech())
    assert sleeps == []
    assert len(scripted.seen) == 1


def test_a_long_utterance_is_trimmed_to_the_server_limit(scripted, monkeypatch):
    scripted.replies.append((200, TRANSCRIPT_OK))
    sent_samples: list[int] = []
    original = remote.pcm_to_wire

    def spy(pcm):
        sent_samples.append(len(pcm))
        return original(pcm)

    monkeypatch.setattr(remote, "pcm_to_wire", spy)
    RemoteStt(scripted.url, KEY).transcribe(speech(40.0))
    assert sent_samples == [int(35.0 * 16_000)]


# ---- RemoteSummarizer ---------------------------------------------------------------------


def test_complete_returns_the_server_content(served):
    served.summarizer.content = "## Summary\nShipped."
    summary = RemoteSummarizer(served.url, KEY, sleep=lambda s: None)
    assert summary.complete("be brief", "the transcript") == "## Summary\nShipped."
    assert served.summarizer.calls == [("be brief", "the transcript")]


def test_complete_with_the_wrong_key_is_a_summary_error(served):
    summary = RemoteSummarizer(served.url, "not-the-key", sleep=lambda s: None)
    with pytest.raises(SummaryError, match="rejected the key"):
        summary.complete("sys", "usr")
    assert served.summarizer.calls == []


def test_connection_refused_twice_is_a_summary_error(refused):
    sleeps: list[float] = []
    summary = RemoteSummarizer("pc", KEY, attempts=2, sleep=sleeps.append)
    with pytest.raises(SummaryError, match="not reachable"):
        summary.complete("sys", "usr")
    assert sleeps == [5.0]  # one pause between the two attempts


def test_a_failing_ollama_behind_the_server_is_retried_then_reported(served):
    served.summarizer.error = SummaryError("ollama is out of memory")
    sleeps: list[float] = []
    summary = RemoteSummarizer(served.url, KEY, attempts=2, sleep=sleeps.append)
    with pytest.raises(SummaryError, match="out of memory"):
        summary.complete("sys", "usr")
    assert len(served.summarizer.calls) == 2  # each attempt reached Ollama once
    assert sleeps == [5.0]


def test_an_empty_reply_is_a_summary_error(scripted):
    scripted.replies.append((200, {"content": "   "}))
    with pytest.raises(SummaryError, match="empty"):
        RemoteSummarizer(scripted.url, KEY, sleep=lambda s: None).complete("sys", "usr")


def test_a_reply_without_content_is_a_summary_error(scripted):
    scripted.replies.append((200, {"something": "else"}))
    with pytest.raises(SummaryError, match="no content"):
        RemoteSummarizer(scripted.url, KEY, sleep=lambda s: None).complete("sys", "usr")
