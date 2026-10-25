"""The PC's model server over real HTTP on 127.0.0.1, with fake models: auth,
size limits, the transcribe/complete contracts, GPU slot back-pressure, and the
server key file."""

from __future__ import annotations

import http.client
import threading
from types import SimpleNamespace

import numpy as np
import pytest
import requests

from taskly_live import server as server_module
from taskly_live.server import MAX_PCM_BYTES, ModelServer, load_or_create_key
from taskly_live.stt import Transcript
from taskly_live.summarize import SummaryError

KEY = "test-server-key"


# ---- fakes --------------------------------------------------------------------------


class FakeStt:
    model_name = "fake-whisper"
    device = "cpu"
    translator = SimpleNamespace(name="ollama:fake")

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.result: Transcript | None = Transcript(
            text="hi", lang="en", text_en="hi", transcribe_s=0.5, translate_s=0.25,
        )
        self.error: Exception | None = None
        self.received: list[np.ndarray] = []
        self.entered = threading.Event()  # set once a decode is running
        self.gate: threading.Event | None = None  # when set, decode blocks on it

    def transcribe(self, pcm):
        self.received.append(pcm)
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(5)
        if self.error is not None:
            raise self.error
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


class ReleasingTranslator:
    """An Ollama-hosted translator: the server unloads it before a summary."""

    name = "ollama:hymt"

    def __init__(self, model="hymt"):
        self.model = model
        self.released = 0

    def release(self):
        self.released += 1


@pytest.fixture()
def serve():
    """Factory for running ModelServers; every one is stopped at teardown."""
    servers: list[ModelServer] = []

    def make(stt=None, summarizer=None, **kwargs) -> ModelServer:
        s = ModelServer(
            FakeStt() if stt is None else stt,
            FakeSummarizer() if summarizer is None else summarizer,
            KEY, host="127.0.0.1", port=0, **kwargs,
        ).start()
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.stop()


@pytest.fixture(scope="module")
def shared_server():
    # One listener for the module: stopping a ModelServer costs ~0.5 s (the
    # serve_forever poll), so the per-test fakes are reset instead.
    server = ModelServer(FakeStt(), FakeSummarizer(), KEY, host="127.0.0.1", port=0).start()
    yield server
    server.stop()


@pytest.fixture()
def running(shared_server):
    shared_server.stt.reset()
    shared_server.summarizer.reset()
    return shared_server


def auth(key: str = KEY) -> dict:
    return {"Authorization": f"Bearer {key}"}


def pcm_bytes(samples=(16384, -16384, 0)) -> bytes:
    return np.array(samples, dtype="<i2").tobytes()


def post_pcm(url: str, body: bytes, headers: dict | None = None) -> requests.Response:
    h = {"Content-Type": "application/octet-stream", **(headers or {})}
    return requests.post(f"{url}/v1/transcribe", data=body, headers=h, timeout=10)


# ---- GET /v1/health -------------------------------------------------------------------


def test_health_without_a_key_says_only_ok(running):
    reply = requests.get(f"{running.url}/v1/health", timeout=5)
    assert reply.status_code == 200
    assert reply.json() == {"ok": True}


def test_health_with_a_wrong_key_is_401_and_names_no_models(running):
    # A laptop's startup probe sends its key: a wrong one must fail there.
    reply = requests.get(f"{running.url}/v1/health", headers=auth("nope"), timeout=5)
    assert reply.status_code == 401
    assert "stt" not in reply.json()


def test_health_with_the_key_describes_the_models(running):
    reply = requests.get(f"{running.url}/v1/health", headers=auth(), timeout=5)
    assert reply.status_code == 200
    assert reply.json() == {
        "ok": True,
        "stt": "fake-whisper",
        "device": "cpu",
        "translator": "ollama:fake",
        "summarizer": "fake-ollama",
    }


def test_unknown_get_route_is_404(running):
    assert requests.get(f"{running.url}/v1/nope", timeout=5).status_code == 404


# ---- POST /v1/transcribe --------------------------------------------------------------


def test_transcribe_without_a_key_is_401_and_never_decodes(running):
    reply = requests.post(f"{running.url}/v1/transcribe", data=b"",
                          headers={"Content-Type": "application/octet-stream"}, timeout=5)
    assert reply.status_code == 401
    assert running.stt.received == []


@pytest.mark.parametrize("header", [
    {"Authorization": "Bearer wrong-key"},
    {"Authorization": f"Basic {KEY}"},
    {"Authorization": KEY},
])
def test_transcribe_with_a_wrong_or_malformed_key_is_401(running, header):
    reply = requests.post(f"{running.url}/v1/transcribe", data=b"", headers=header, timeout=5)
    assert reply.status_code == 401
    assert running.stt.received == []


def test_odd_byte_length_is_400(running):
    reply = post_pcm(running.url, b"\x00\x00\x00", auth())
    assert reply.status_code == 400
    assert running.stt.received == []


def test_oversize_body_is_413_without_reading_it(running):
    # Only the headers are sent: the server must refuse on Content-Length alone.
    # (Sending the whole oversize body makes Windows reset the socket before the
    # client reads the 413, which made this test flaky.)
    conn = http.client.HTTPConnection("127.0.0.1", running.port, timeout=10)
    try:
        conn.putrequest("POST", "/v1/transcribe")
        conn.putheader("Authorization", f"Bearer {KEY}")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(MAX_PCM_BYTES + 2))
        conn.endheaders()
        reply = conn.getresponse()
        assert reply.status == 413
    finally:
        conn.close()
    assert running.stt.received == []


def test_the_size_limit_is_35_seconds_of_16k_int16():
    assert MAX_PCM_BYTES == 35 * 16_000 * 2


def test_valid_audio_returns_the_transcript_fields(running):
    reply = post_pcm(running.url, pcm_bytes(), auth())
    assert reply.status_code == 200
    assert reply.json() == {
        "text": "hi",
        "lang": "en",
        "text_en": "hi",
        "text_ar": None,
        "transcribe_s": 0.5,
        "translate_s": 0.25,
    }


def test_the_model_receives_float32_samples_in_range(running):
    post_pcm(running.url, pcm_bytes((16384, -16384, 0, -32768, 32767)), auth())
    (samples,) = running.stt.received
    assert samples.dtype == np.float32
    assert len(samples) == 5
    np.testing.assert_allclose(samples[:3], [0.5, -0.5, 0.0])
    assert samples[3] == pytest.approx(-1.0)
    assert np.all(np.abs(samples) <= 1.0)


def test_both_languages_and_null_translate_time_are_passed_through(running):
    running.stt.result = Transcript(
        text="مرحبا", lang="ar", text_en="Hello", transcribe_s=0.1234,
        translate_s=None, text_ar="مرحبا",
    )
    body = post_pcm(running.url, pcm_bytes(), auth()).json()
    assert body["text"] == "مرحبا"
    assert body["lang"] == "ar"
    assert body["text_en"] == "Hello"
    assert body["text_ar"] == "مرحبا"
    assert body["transcribe_s"] == 0.123
    assert body["translate_s"] is None


def test_silence_is_text_null(running):
    running.stt.result = None
    reply = post_pcm(running.url, pcm_bytes(), auth())
    assert reply.status_code == 200
    assert reply.json() == {"text": None}


def test_an_empty_body_is_silence_and_skips_the_model(running):
    reply = post_pcm(running.url, b"", auth())
    assert reply.status_code == 200
    assert reply.json() == {"text": None}
    assert running.stt.received == []


def test_a_failing_model_is_500_without_its_message(running):
    running.stt.error = RuntimeError("CUDA out of memory at 0xdeadbeef")
    reply = post_pcm(running.url, pcm_bytes(), auth())
    assert reply.status_code == 500
    assert reply.json() == {"error": "transcription failed"}
    assert "CUDA" not in reply.text


# ---- GPU slots: back-pressure ----------------------------------------------------------


def test_a_second_decode_waits_for_the_slot_then_gets_503(serve):
    stt = FakeStt()
    stt.gate = threading.Event()
    running = serve(stt=stt, stt_slots=1, slot_wait_s=0.2)

    first: dict[str, requests.Response] = {}
    worker = threading.Thread(
        target=lambda: first.update(r=post_pcm(running.url, pcm_bytes(), auth())))
    worker.start()
    try:
        assert stt.entered.wait(5), "the first decode never started"

        second = post_pcm(running.url, pcm_bytes(), auth())  # the slot is held
        assert second.status_code == 503
        assert second.json() == {"error": "busy"}
        assert second.headers["Retry-After"] == "2"
        assert len(stt.received) == 1  # the busy request never reached the model
    finally:
        stt.gate.set()
        worker.join(5)

    assert first["r"].status_code == 200
    assert post_pcm(running.url, pcm_bytes(), auth()).status_code == 200


# ---- POST /v1/complete -------------------------------------------------------------------


def test_complete_returns_the_summary_content(running):
    reply = requests.post(f"{running.url}/v1/complete",
                          json={"system": "be brief", "user": "the transcript"},
                          headers=auth(), timeout=5)
    assert reply.status_code == 200
    assert reply.json() == {"content": "## Summary\nAll good."}
    assert running.summarizer.calls == [("be brief", "the transcript")]


def test_complete_without_a_key_is_401(running):
    reply = requests.post(f"{running.url}/v1/complete",
                          json={"system": "a", "user": "b"}, timeout=5)
    assert reply.status_code == 401
    assert running.summarizer.calls == []


@pytest.mark.parametrize("body", [
    {"system": "only a system prompt"},
    {"user": "only a user prompt"},
    {"system": "  ", "user": "text"},
    {"system": 3, "user": "text"},
    ["not", "an", "object"],
])
def test_complete_with_missing_or_bad_keys_is_400(running, body):
    reply = requests.post(f"{running.url}/v1/complete", json=body, headers=auth(), timeout=5)
    assert reply.status_code == 400
    assert running.summarizer.calls == []


def test_complete_with_a_non_json_body_is_400(running):
    reply = requests.post(f"{running.url}/v1/complete", data=b"not json",
                          headers=auth(), timeout=5)
    assert reply.status_code == 400


def test_a_summary_error_is_502_with_its_message(running):
    running.summarizer.error = SummaryError("ollama is not running")
    reply = requests.post(f"{running.url}/v1/complete",
                          json={"system": "a", "user": "b"}, headers=auth(), timeout=5)
    assert reply.status_code == 502
    assert reply.json() == {"error": "ollama is not running"}


def test_any_other_summarizer_failure_is_500(running):
    running.summarizer.error = RuntimeError("secret internals")
    reply = requests.post(f"{running.url}/v1/complete",
                          json={"system": "a", "user": "b"}, headers=auth(), timeout=5)
    assert reply.status_code == 500
    assert "secret" not in reply.text


# ---- the server key file ---------------------------------------------------------------


def test_the_key_is_made_once_and_then_reused(tmp_path):
    data_dir = tmp_path / "data"  # does not exist yet: load_or_create_key makes it
    first, made_now = load_or_create_key(data_dir)
    assert made_now is True
    assert (data_dir / server_module.KEY_FILENAME).read_text(encoding="utf-8").strip() == first
    assert len(first) >= 32

    again, made_now = load_or_create_key(data_dir)
    assert again == first
    assert made_now is False


def test_rotate_replaces_the_key(tmp_path):
    first, _ = load_or_create_key(tmp_path)
    rotated, made_now = load_or_create_key(tmp_path, rotate=True)
    assert made_now is True
    assert rotated != first
    assert load_or_create_key(tmp_path) == (rotated, False)


def test_an_empty_key_file_is_replaced(tmp_path):
    (tmp_path / server_module.KEY_FILENAME).write_text("   \n", encoding="utf-8")
    key, made_now = load_or_create_key(tmp_path)
    assert made_now is True and key.strip()


# ---- VRAM: the translator steps aside for the summary ----------------------------


def test_a_summary_first_unloads_an_ollama_translator(serve):
    stt = FakeStt()
    stt.translator = ReleasingTranslator("hymt")
    summarizer = FakeSummarizer()
    summarizer.model = "qwen"
    server = serve(stt=stt, summarizer=summarizer)
    reply = requests.post(f"{server.url}/v1/complete", json={"system": "s", "user": "u"},
                          headers=auth(), timeout=5)
    assert reply.status_code == 200
    assert stt.translator.released == 1


def test_the_summary_model_itself_is_not_unloaded(serve):
    stt = FakeStt()
    stt.translator = ReleasingTranslator("qwen")
    summarizer = FakeSummarizer()
    summarizer.model = "qwen"  # same model translates and summarizes
    server = serve(stt=stt, summarizer=summarizer)
    reply = requests.post(f"{server.url}/v1/complete", json={"system": "s", "user": "u"},
                          headers=auth(), timeout=5)
    assert reply.status_code == 200
    assert stt.translator.released == 0
