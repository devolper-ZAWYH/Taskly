"""The model server's OpenAI-compatible routes, over real HTTP on 127.0.0.1.

Fakes stand in for Whisper, the line translator, the summary model and Ollama.
The fake Ollama is a stdlib HTTP server that answers the two endpoints the
server uses (`/api/tags`, `/v1/chat/completions`), so no GPU, model, Ollama or
real network is involved. The OpenAI SDK is deliberately not used: `requests`
plays the client, so the wire format is checked directly.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import count
from pathlib import Path

import numpy as np
import pytest
import requests

from taskly_live.keys import KeyStore
from taskly_live.server import ModelServer
from taskly_live.stt import Transcript
from taskly_live.translate import TranslationError

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
CLIP_AR_BYTES = (FIXTURES / "clip-ar.mp3").read_bytes()
CLIP_AR_SECONDS = 13.13  # the fixture decodes to 13.128 s
TIMEOUT = 10
CHAT_MODEL = "qwen-test"
ARABIC_LINE = "مرحبا بكم"
USAGE = {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15}
STREAM_PIECES = ["مرحبا", " بكم"]
_fresh = count(1)


# ---- fakes --------------------------------------------------------------------------


def stream_chunks(model: str, usage: bool = True) -> list[dict]:
    """The chunks the fake Ollama streams: content, a finish, then (maybe) usage."""
    base = {"id": "chatcmpl-stream-1", "object": "chat.completion.chunk", "created": 1,
            "model": model}
    chunks = [{**base, "choices": [{"index": 0, "delta": {"content": piece},
                                    "finish_reason": None}]} for piece in STREAM_PIECES]
    chunks.append({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    if usage:
        chunks.append({**base, "choices": [], "usage": dict(USAGE)})
    return chunks


class _OllamaHandler(BaseHTTPRequestHandler):
    # The stdlib default (HTTP/1.0): each reply closes, so a stream is delimited
    # by the close, as Ollama's own stream is.

    def log_message(self, *args) -> None:  # keep test output quiet
        pass

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/tags":
            self._send_json(200, {"models": [{"name": "qwen-test"}, {"name": "other:1b"}]})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        owner = self.server.owner
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": "not found"})
            return
        owner.requests.append(body)
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk in stream_chunks(body["model"], usage=owner.stream_usage):
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self._send_json(200, {
            "id": "chatcmpl-1", "object": "chat.completion", "created": 1,
            "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": "مرحبا، كيف أساعدك؟"}}],
            "usage": dict(USAGE),
        })


class FakeOllama:
    """Ollama's two endpoints on 127.0.0.1:0; every chat body is recorded."""

    def __init__(self) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _OllamaHandler)
        self.httpd.owner = self
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.requests: list[dict] = []
        self.stream_usage = True
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05},
                         daemon=True).start()

    def reset(self) -> None:
        self.requests.clear()
        self.stream_usage = True

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeTranslator:
    name = "fake-translator"
    model = "fake-translator-model"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.error: Exception | None = None

    def translate(self, text: str, src: str, dst: str) -> str:
        self.calls.append((text, src, dst))
        if self.error is not None:
            raise self.error
        return f"EN({text})" if dst == "en" else f"AR({text})"


class FakeStt:
    model_name = "fake-whisper"
    device = "cpu"

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.result: tuple[str, str] | None = (ARABIC_LINE, "ar")
        self.error: Exception | None = None
        self.gate: threading.Event | None = None  # recognize blocks until it is set
        self.entered = threading.Event()  # set once a recognize call has started
        self.calls: list[tuple[np.ndarray, str | None]] = []
        self.transcript = Transcript(text="hi", lang="en", text_en="hi",
                                     transcribe_s=0.5, translate_s=0.25)
        self.translator: FakeTranslator | None = FakeTranslator()

    def recognize(self, pcm, language=None):
        self.calls.append((pcm, language))
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(5)
        if self.error is not None:
            raise self.error
        return self.result

    def transcribe(self, pcm):
        return self.transcript


class FakeSummarizer:
    name = "fake-ollama"
    model = CHAT_MODEL

    def __init__(self, url: str) -> None:
        self.url = url
        self.calls: list[tuple[str, str]] = []
        self.content = "## Summary"

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.content


# ---- helpers ------------------------------------------------------------------------


def auth(raw: str) -> dict:
    return {"Authorization": f"Bearer {raw}"}


def fresh_key(store: KeyStore, label: str) -> tuple[str, str]:
    """A new key with its own name, so its usage counters start at zero."""
    name = f"{label}-{next(_fresh)}"
    return name, store.add(name)


def key_info(store: KeyStore, name: str):
    return next(k for k in store.list() if k.name == name)


def wait_for_usage(store: KeyStore, name: str, *, requests: int = 1, timeout: float = 3.0):
    """The key's usage once `requests` calls are counted.

    The server writes its reply before it counts the call, so a client that
    reads the counters right after a response has to wait for them briefly.
    """
    deadline = time.monotonic() + timeout
    usage = key_info(store, name).usage
    while usage.requests < requests and time.monotonic() < deadline:
        time.sleep(0.01)
        usage = key_info(store, name).usage
    return usage


def closed_url() -> str:
    """A 127.0.0.1 address with nothing listening on it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


def assert_openai_error(body: dict, *, code: str | None, param: str | None = None) -> None:
    assert set(body) == {"error"}
    err = body["error"]
    assert set(err) == {"message", "type", "param", "code"}
    assert isinstance(err["message"], str) and err["message"]
    assert isinstance(err["type"], str)
    assert err["param"] == param
    assert err["code"] == code


def chat(app: ModelServer, raw: str, body: dict, *, stream: bool = False):
    return requests.post(f"{app.url}/v1/chat/completions", json=body, headers=auth(raw),
                         timeout=TIMEOUT, stream=stream)


def chat_body(model: str = CHAT_MODEL, **extra) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "مرحبا"}], **extra}


def post_audio(app: ModelServer, raw: str, route: str = "/v1/audio/transcriptions", *,
               fields: dict | None = None, file: bytes | None = CLIP_AR_BYTES,
               filename: str = "clip-ar.mp3"):
    """A multipart upload, built with requests' `files=` and `data=`."""
    fields = {"model": "whisper-1", **(fields or {})}
    if file is None:
        # No file part: the fields must still go as multipart parts.
        parts = {k: (None, v) for k, v in fields.items()}
        return requests.post(f"{app.url}{route}", headers=auth(raw), files=parts,
                             timeout=TIMEOUT)
    return requests.post(f"{app.url}{route}", headers=auth(raw), data=fields,
                         files={"file": (filename, file, "audio/mpeg")}, timeout=TIMEOUT)


def translate_post(app: ModelServer, raw: str, body: dict):
    return requests.post(f"{app.url}/v1/translate", json=body, headers=auth(raw),
                         timeout=TIMEOUT)


def make_server(store: KeyStore, ollama: FakeOllama, stt: FakeStt | None = None,
                **kwargs) -> ModelServer:
    kwargs.setdefault("ollama_url", ollama.url)
    kwargs.setdefault("chat_models", [CHAT_MODEL, "missing:7b"])
    return ModelServer(stt or FakeStt(), FakeSummarizer(ollama.url), store,
                       host="127.0.0.1", port=0, **kwargs).start()


# ---- fixtures -----------------------------------------------------------------------


@pytest.fixture(scope="module")
def ollama():
    fake = FakeOllama()
    yield fake
    fake.close()


@pytest.fixture(scope="module")
def store(tmp_path_factory) -> KeyStore:
    return KeyStore(tmp_path_factory.mktemp("keys") / "keys.json")


@pytest.fixture(scope="module")
def alpha(store: KeyStore) -> str:
    return store.add("alpha")


@pytest.fixture(scope="module")
def beta(store: KeyStore) -> str:
    return store.add("beta")


@pytest.fixture(scope="module")
def app(store: KeyStore, ollama: FakeOllama):
    # One listener for the module (stopping one costs ~0.5 s): the fakes are
    # reset before every test instead.
    server = make_server(store, ollama, chat_models=[CHAT_MODEL, "missing:7b"])
    yield server
    server.stop()


@pytest.fixture(autouse=True)
def _reset_fakes(app: ModelServer, ollama: FakeOllama):
    app.stt.reset()
    app.summarizer.calls.clear()
    ollama.reset()
    yield


# ---- auth and routing ---------------------------------------------------------------


def test_no_key_is_401_in_openai_shape(app):
    reply = requests.get(f"{app.url}/v1/models", timeout=TIMEOUT)
    assert reply.status_code == 401
    assert_openai_error(reply.json(), code="invalid_api_key")
    assert reply.json()["error"]["type"] == "invalid_request_error"


@pytest.mark.parametrize("method, path, kwargs", [
    ("GET", "/v1/models", {}),
    ("POST", "/v1/chat/completions", {"json": chat_body()}),
    ("POST", "/v1/audio/transcriptions", {"data": b""}),
    ("POST", "/v1/audio/translations", {"data": b""}),
    ("POST", "/v1/translate", {"json": {"text": "hi", "target": "en"}}),
])
def test_a_wrong_key_is_401_on_every_openai_route(app, method, path, kwargs):
    reply = requests.request(method, f"{app.url}{path}", headers=auth("tsk_not-a-real-key"),
                             timeout=TIMEOUT, **kwargs)
    assert reply.status_code == 401
    assert_openai_error(reply.json(), code="invalid_api_key")


def test_a_revoked_key_is_401(app, store):
    name, raw = fresh_key(store, "revoked")
    assert store.revoke(name)
    reply = requests.get(f"{app.url}/v1/models", headers=auth(raw), timeout=TIMEOUT)
    assert reply.status_code == 401
    assert_openai_error(reply.json(), code="invalid_api_key")


def test_unknown_post_route_is_404_in_openai_shape(app, alpha):
    reply = requests.post(f"{app.url}/v1/nope", json={}, headers=auth(alpha), timeout=TIMEOUT)
    assert reply.status_code == 404
    assert_openai_error(reply.json(), code="not_found")


def test_unknown_get_route_is_404_in_openai_shape(app):
    # Expected to FAIL: do_GET answers unknown paths with the legacy shape
    # {"error": "not found"} (a string), not OpenAI's {"error": {...}}.
    reply = requests.get(f"{app.url}/v1/nope", timeout=TIMEOUT)
    assert reply.status_code == 404
    assert_openai_error(reply.json(), code="not_found")


# ---- GET /v1/models -----------------------------------------------------------------


def test_models_lists_allowlisted_installed_models_and_whisper_only(app, alpha):
    reply = requests.get(f"{app.url}/v1/models", headers=auth(alpha), timeout=TIMEOUT)
    assert reply.status_code == 200
    body = reply.json()
    assert body["object"] == "list"
    ids = [m["id"] for m in body["data"]]
    assert CHAT_MODEL in ids  # allowlisted and installed
    assert "whisper-1" in ids
    assert "fake-whisper" in ids
    assert "other:1b" not in ids  # installed, not allowlisted
    assert "missing:7b" not in ids  # allowlisted, not installed
    assert all(m["object"] == "model" for m in body["data"])


# ---- POST /v1/chat/completions ------------------------------------------------------


def test_chat_body_reaches_ollama_and_the_reply_is_relayed(app, ollama, store, alpha):
    name, raw = fresh_key(store, "chat")
    before = key_info(store, "alpha").usage
    body = chat_body(temperature=0.2, max_tokens=64)

    reply = chat(app, raw, body)

    assert reply.status_code == 200
    # Thinking is off unless the caller asks for it: the only change is the default.
    assert ollama.requests == [{**body, "reasoning_effort": "none"}]
    assert reply.json()["choices"][0]["message"]["content"] == "مرحبا، كيف أساعدك؟"
    usage = wait_for_usage(store, name)
    assert usage.requests == 1
    assert usage.prompt_tokens == USAGE["prompt_tokens"]
    assert usage.completion_tokens == USAGE["completion_tokens"]
    # The other platform's token counters did not move.
    after = key_info(store, "alpha").usage
    assert (after.prompt_tokens, after.completion_tokens) == (
        before.prompt_tokens, before.completion_tokens)


def test_a_caller_chosen_reasoning_effort_is_forwarded_as_sent(app, ollama, store):
    name, raw = fresh_key(store, "reasoning")
    body = chat_body(reasoning_effort="high")

    assert chat(app, raw, body).status_code == 200

    assert ollama.requests == [body]


def test_a_caller_chosen_reasoning_object_is_not_overridden(app, ollama, store):
    name, raw = fresh_key(store, "reasoning-obj")
    body = chat_body(reasoning={"effort": "low"})

    assert chat(app, raw, body).status_code == 200

    assert ollama.requests == [body]


def test_a_stream_relays_every_event_in_order_then_done(app, ollama, store):
    name, raw = fresh_key(store, "stream")
    body = chat_body(stream=True)

    reply = chat(app, raw, body, stream=True)

    assert reply.status_code == 200
    assert reply.headers["Content-Type"].startswith("text/event-stream")
    lines = [line for line in reply.iter_lines(decode_unicode=True) if line]
    expected = [f"data: {json.dumps(c)}" for c in stream_chunks(CHAT_MODEL)] + ["data: [DONE]"]
    assert lines == expected
    assert ollama.requests == [{**body, "reasoning_effort": "none"}]
    usage = wait_for_usage(store, name)
    assert usage.requests == 1
    assert (usage.prompt_tokens, usage.completion_tokens) == (11, 4)


def test_a_stream_without_usage_still_counts_the_request(app, ollama, store):
    name, raw = fresh_key(store, "stream-nousage")
    ollama.stream_usage = False

    reply = chat(app, raw, chat_body(stream=True), stream=True)
    lines = [line for line in reply.iter_lines(decode_unicode=True) if line]

    assert lines[-1] == "data: [DONE]"
    usage = wait_for_usage(store, name)
    assert usage.requests == 1
    assert (usage.prompt_tokens, usage.completion_tokens) == (0, 0)


@pytest.mark.parametrize("model", [
    "other:1b",  # installed but not allowlisted
    "missing:7b",  # allowlisted but not installed
])
def test_a_model_not_offered_is_404_model_not_found(app, alpha, model):
    reply = chat(app, alpha, chat_body(model))
    assert reply.status_code == 404
    assert_openai_error(reply.json(), code="model_not_found", param="model")


def test_chat_without_a_model_is_400(app, alpha):
    reply = chat(app, alpha, {"messages": [{"role": "user", "content": "hi"}]})
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="model")


def test_chat_without_messages_is_400(app, alpha):
    reply = chat(app, alpha, {"model": CHAT_MODEL})
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="messages")


def test_chat_with_invalid_json_is_400(app, alpha):
    reply = requests.post(f"{app.url}/v1/chat/completions", data=b"{not json",
                          headers={**auth(alpha), "Content-Type": "application/json"},
                          timeout=TIMEOUT)
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None)


def test_ollama_down_is_503(store, ollama):
    # Expected to FAIL: with no model list read yet, chat_models() comes back
    # empty when Ollama is unreachable, so the request is answered 404
    # model_not_found instead of 503 server_error.
    srv = make_server(store, ollama, ollama_url=closed_url(), chat_models=[CHAT_MODEL])
    try:
        reply = chat(srv, store.add(f"down-{next(_fresh)}"), chat_body())
        assert reply.status_code == 503
        assert_openai_error(reply.json(), code=None)
        assert reply.json()["error"]["type"] == "server_error"
    finally:
        srv.stop()


def test_ollama_dying_after_the_model_list_was_read_is_503(store, ollama):
    srv = make_server(store, ollama, chat_models=[CHAT_MODEL])
    try:
        raw = store.add(f"dying-{next(_fresh)}")
        # Reading /v1/models caches the installed list for a minute...
        assert requests.get(f"{srv.url}/v1/models", headers=auth(raw),
                            timeout=TIMEOUT).status_code == 200
        # ...so when Ollama goes away inside that window, the chat call itself fails.
        srv.ollama_url = closed_url()
        reply = chat(srv, raw, chat_body())
        assert reply.status_code == 503
        assert reply.json()["error"]["type"] == "server_error"
    finally:
        srv.stop()


# ---- POST /v1/audio/transcriptions --------------------------------------------------


def test_json_response_joins_the_segments_text(app, alpha):
    reply = post_audio(app, alpha, fields={"response_format": "json"})
    assert reply.status_code == 200
    assert reply.headers["Content-Type"].startswith("application/json")
    n = len(app.stt.calls)
    assert n >= 1
    assert reply.json() == {"text": " ".join([ARABIC_LINE] * n)}


def test_recognize_gets_float32_samples_and_no_language_by_default(app, alpha):
    assert post_audio(app, alpha).status_code == 200
    assert app.stt.calls
    for pcm, language in app.stt.calls:
        assert isinstance(pcm, np.ndarray)
        assert pcm.dtype == np.float32
        assert language is None


def test_language_field_is_normalised_and_passed_on(app, alpha):
    assert post_audio(app, alpha, fields={"language": " AR "}).status_code == 200
    assert {language for _, language in app.stt.calls} == {"ar"}


def test_text_format_is_plain_text_with_a_trailing_newline(app, alpha):
    reply = post_audio(app, alpha, fields={"response_format": "text"})
    assert reply.status_code == 200
    assert reply.headers["Content-Type"].startswith("text/plain")
    n = len(app.stt.calls)
    assert reply.text == " ".join([ARABIC_LINE] * n) + "\n"


def test_verbose_json_has_language_duration_and_increasing_segments(app, alpha):
    reply = post_audio(app, alpha, fields={"response_format": "verbose_json"})
    assert reply.status_code == 200
    body = reply.json()
    assert body["task"] == "transcribe"
    assert body["language"] == "arabic"
    assert body["duration"] == pytest.approx(CLIP_AR_SECONDS, abs=0.05)
    segments = body["segments"]
    assert segments, "the clip should yield at least one segment"
    assert [s["id"] for s in segments] == list(range(len(segments)))
    starts = [s["start"] for s in segments]
    assert starts == sorted(starts) and len(set(starts)) == len(starts)
    assert all(s["end"] > s["start"] for s in segments)
    assert all(s["text"] == ARABIC_LINE for s in segments)


def test_srt_numbers_cues_and_uses_comma_milliseconds(app, alpha):
    reply = post_audio(app, alpha, fields={"response_format": "srt"})
    assert reply.status_code == 200
    assert reply.headers["Content-Type"].startswith("text/plain")
    assert reply.text.startswith("1\n")
    assert "-->" in reply.text
    assert reply.text.count("-->") == len(app.stt.calls)
    assert ARABIC_LINE in reply.text


def test_an_unknown_response_format_is_400(app, alpha):
    reply = post_audio(app, alpha, fields={"response_format": "docx"})
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="response_format")


def test_a_missing_file_is_400_on_file(app, alpha):
    reply = post_audio(app, alpha, file=None)
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="file")
    assert app.stt.calls == []


def test_an_empty_file_is_400_on_file(app, alpha):
    reply = post_audio(app, alpha, file=b"")
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="file")


def test_garbage_bytes_are_400_not_a_crash(app, alpha):
    reply = post_audio(app, alpha, file=b"this is plainly not audio " * 40, filename="x.mp3")
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param="file")
    assert app.stt.calls == []


def test_audio_seconds_are_recorded_on_the_key(app, store):
    name, raw = fresh_key(store, "audio")
    assert post_audio(app, raw).status_code == 200
    usage = wait_for_usage(store, name)
    assert usage.requests == 1
    assert usage.audio_seconds == pytest.approx(CLIP_AR_SECONDS, abs=0.05)


# ---- POST /v1/audio/translations ----------------------------------------------------


def test_arabic_segments_go_through_the_translator(app, alpha):
    reply = post_audio(app, alpha, route="/v1/audio/translations")
    assert reply.status_code == 200
    n = len(app.stt.calls)
    assert reply.json() == {"text": " ".join([f"EN({ARABIC_LINE})"] * n)}
    assert app.translator.calls == [(ARABIC_LINE, "ar", "en")] * n


def test_english_segments_pass_through_untranslated(app, alpha):
    app.stt.result = ("hello there", "en")
    reply = post_audio(app, alpha, route="/v1/audio/translations",
                       fields={"response_format": "verbose_json"})
    assert reply.status_code == 200
    body = reply.json()
    n = len(app.stt.calls)
    assert body["text"] == " ".join(["hello there"] * n)
    assert body["language"] == "english"
    assert body["task"] == "translate"
    assert app.translator.calls == []


def test_audio_translation_without_a_translator_is_503(app, alpha):
    app.stt.translator = None
    reply = post_audio(app, alpha, route="/v1/audio/translations")
    assert reply.status_code == 503
    assert reply.json()["error"]["type"] == "server_error"
    assert app.stt.calls == []


# ---- POST /v1/translate -------------------------------------------------------------


def test_arabic_text_is_detected_and_translated_to_english(app, alpha):
    reply = translate_post(app, alpha, {"text": "مرحبا", "target": "en"})
    assert reply.status_code == 200
    assert reply.json() == {"text": "EN(مرحبا)", "source": "ar", "target": "en",
                            "translator": "fake-translator"}


def test_english_text_is_translated_to_arabic(app, alpha):
    reply = translate_post(app, alpha, {"text": "Good morning", "target": "ar"})
    assert reply.status_code == 200
    assert reply.json()["text"] == "AR(Good morning)"
    assert reply.json()["source"] == "en"


def test_multi_line_text_is_translated_line_by_line_keeping_blank_lines(app, alpha):
    text = "مرحبا\n\n   \nكيف الحال؟"
    reply = translate_post(app, alpha, {"text": text, "target": "en"})
    assert reply.status_code == 200
    assert reply.json()["text"] == "EN(مرحبا)\n\n   \nEN(كيف الحال؟)"
    assert [t for t, _, _ in app.translator.calls] == ["مرحبا", "كيف الحال؟"]


def test_source_equal_to_target_returns_the_text_unchanged(app, alpha):
    reply = translate_post(app, alpha, {"text": "Good morning", "target": "en"})
    assert reply.status_code == 200
    assert reply.json()["text"] == "Good morning"
    assert reply.json()["source"] == reply.json()["target"] == "en"
    assert app.translator.calls == []


@pytest.mark.parametrize("body, param", [
    ({"text": "مرحبا", "target": "fr"}, "target"),
    ({"text": "مرحبا"}, "target"),
    ({"text": "مرحبا", "target": "en", "source": "fr"}, "source"),
    ({"text": "   ", "target": "en"}, "text"),
    ({"target": "en"}, "text"),
])
def test_bad_translate_input_is_400_on_the_field(app, alpha, body, param):
    reply = translate_post(app, alpha, body)
    assert reply.status_code == 400
    assert_openai_error(reply.json(), code=None, param=param)


def test_text_over_the_limit_is_413(app, alpha):
    reply = translate_post(app, alpha, {"text": "a" * 20_001, "target": "en"})
    assert reply.status_code == 413
    assert_openai_error(reply.json(), code=None, param="text")
    assert app.translator.calls == []


def test_a_translator_error_is_503(app, alpha):
    app.translator.error = TranslationError("Ollama unreachable (ConnectTimeout)")
    reply = translate_post(app, alpha, {"text": "مرحبا", "target": "en"})
    assert reply.status_code == 503
    assert reply.json()["error"]["type"] == "server_error"
    assert "translation failed" in reply.json()["error"]["message"]


def test_no_translator_configured_is_503(app, alpha):
    app.stt.translator = None
    reply = translate_post(app, alpha, {"text": "مرحبا", "target": "en"})
    assert reply.status_code == 503
    assert reply.json()["error"]["type"] == "server_error"


# ---- fairness: a full queue is 429 with Retry-After ---------------------------------


def test_a_second_platform_gets_429_with_retry_after_while_the_slot_is_held(
        store, ollama, alpha, beta):
    stt = FakeStt()
    stt.gate = threading.Event()
    srv = make_server(store, ollama, stt=stt, stt_slots=1, max_queue=0, slot_wait_s=0.5)
    first: dict[str, requests.Response] = {}
    holder = threading.Thread(
        target=lambda: first.update(r=post_audio(srv, alpha)), name="alpha-upload")
    try:
        holder.start()
        assert stt.entered.wait(5), "the first upload never reached the model"

        second = post_audio(srv, beta)  # alpha holds the only speech slot

        assert second.status_code == 429
        assert int(second.headers["Retry-After"]) >= 1
        assert_openai_error(second.json(), code="rate_limit_exceeded")
        assert len(stt.calls) == 1  # the refused upload never reached the model
    finally:
        stt.gate.set()
        holder.join(5)
        srv.stop()

    assert "r" in first and first["r"].status_code == 200
    # With the slot released, the same platform is served again.
    srv = make_server(store, ollama, stt=stt, stt_slots=1, max_queue=0, slot_wait_s=0.5)
    try:
        assert post_audio(srv, beta).status_code == 200
    finally:
        srv.stop()


# ---- legacy routes: the recorder's contract is unchanged ----------------------------


def test_legacy_transcribe_still_takes_raw_pcm_with_a_store_key(app, beta):
    pcm = np.array([16384, -16384, 0], dtype="<i2").tobytes()
    reply = requests.post(f"{app.url}/v1/transcribe", data=pcm, timeout=TIMEOUT,
                          headers={**auth(beta), "Content-Type": "application/octet-stream"})
    assert reply.status_code == 200
    assert reply.json()["text"] == "hi"
    assert reply.json()["lang"] == "en"


def test_legacy_complete_still_answers_with_a_store_key(app, alpha):
    reply = requests.post(f"{app.url}/v1/complete", json={"system": "s", "user": "u"},
                          headers=auth(alpha), timeout=TIMEOUT)
    assert reply.status_code == 200
    assert reply.json() == {"content": "## Summary"}
    assert app.summarizer.calls == [("s", "u")]


@pytest.mark.parametrize("route", ["/v1/transcribe", "/v1/complete"])
def test_legacy_routes_keep_their_own_401_shape(app, route):
    reply = requests.post(f"{app.url}{route}", data=b"", headers=auth("tsk_wrong"),
                          timeout=TIMEOUT)
    assert reply.status_code == 401
    assert reply.json() == {"error": "unauthorized"}


# ---- health -------------------------------------------------------------------------


def test_health_with_a_store_key_reports_the_speech_and_llm_queues(app, alpha):
    reply = requests.get(f"{app.url}/v1/health", headers=auth(alpha), timeout=TIMEOUT)
    assert reply.status_code == 200
    body = reply.json()
    assert body["ok"] is True
    assert body["stt"] == "fake-whisper"
    assert body["chat_models"] == [CHAT_MODEL]
    assert set(body["queues"]) == {"speech", "llm"}


def test_health_with_a_wrong_key_is_401(app):
    reply = requests.get(f"{app.url}/v1/health", headers=auth("tsk_wrong"), timeout=TIMEOUT)
    assert reply.status_code == 401
    assert reply.json() == {"error": "unauthorized"}
