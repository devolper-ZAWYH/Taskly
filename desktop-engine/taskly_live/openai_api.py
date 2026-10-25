"""The model server's OpenAI-compatible routes (server.py dispatches here).

So any platform can use a stock OpenAI SDK — `base_url=<server>/v1`,
`api_key=<its key>` — with no Taskly code:

  GET  /v1/models                 the allowlisted Ollama models + Whisper
  POST /v1/chat/completions       proxied to Ollama's own OpenAI endpoint;
                                  `stream: true` relays its server-sent
                                  events as they come; thinking is off unless
                                  the request sets `reasoning_effort`
  POST /v1/audio/transcriptions   multipart `file` (mp3/m4a/wav/ogg/webm...),
                                  `model` (any; it's Whisper large-v3-turbo),
                                  `language`, `response_format` (json, text,
                                  verbose_json, srt, vtt)
  POST /v1/audio/translations     the same, answered in English. Whisper
                                  turbo can't translate, so it's transcribe
                                  + the server's translator per segment
  POST /v1/translate              not OpenAI: {text, source?, target} for
                                  Arabic <-> English text

Errors use OpenAI's shape, `{"error": {"message", "type", "param", "code"}}`;
a full queue is 429 with Retry-After. Long audio is cut into utterances
(the recorder's own Segmenter) and each takes its own turn at the GPU, so a
one-hour upload interleaves with other platforms' requests instead of
holding the card for minutes.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from typing import TYPE_CHECKING

from .openai_io import OpenAIError, decode_audio, detect_language, parse_multipart, \
    transcription_response
from .scheduler import Busy

if TYPE_CHECKING:
    from .keys import KeyInfo
    from .server import ModelServer, _Handler

log = logging.getLogger(__name__)

MAX_CHAT_BYTES = 4_000_000
MAX_TRANSLATE_CHARS = 20_000
MAX_AUDIO_FILE_S = 2 * 3600.0
CHAT_TIMEOUT_S = 600.0
AUDIO_MODEL_IDS = ("whisper-1",)  # what SDKs send; any value is accepted


def handle(h: "_Handler", method: str, route: str) -> None:
    """Authenticate, run one OpenAI-style route, answer — errors included."""
    from .server import _Refusal

    app = h.app
    t0 = time.perf_counter()
    key = None
    usage: dict = {}
    try:
        routes = {
            ("GET", "/v1/models"): _models,
            ("POST", "/v1/chat/completions"): _chat,
            ("POST", "/v1/audio/transcriptions"): lambda *a: _audio(*a, task="transcribe"),
            ("POST", "/v1/audio/translations"): lambda *a: _audio(*a, task="translate"),
            ("POST", "/v1/translate"): _translate,
        }
        run = routes.get((method, route))
        if run is None:
            h.discard_body()
            raise OpenAIError(404, f"unknown route {method} {route}", code="not_found")
        key = app.keys.verify(h.bearer())
        if key is None:
            h.discard_body()
            raise OpenAIError(401, "invalid or missing API key")
        try:
            usage = run(h, app, key) or {}
        except _Refusal as refusal:  # body too big / no length
            raise OpenAIError(refusal.status, refusal.message) from None
        status = 200
    except Busy as busy:
        status = 429
        h.send_json(429, OpenAIError(429, str(busy)).body(), retry_after=busy.retry_after)
    except OpenAIError as err:
        status = err.status
        h.send_json(err.status, err.body())
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        status = 499  # the caller went away (mid-stream, usually)
        h.close_connection = True
    except Exception as exc:  # noqa: BLE001 - never a bare traceback to a client
        log.exception("%s failed (%s)", route, type(exc).__name__)
        status = 500
        try:
            h.send_json(500, OpenAIError(500, "internal error").body())
        except OSError:
            pass
    app.note(route, key, status, t0, **usage)


# ---- models ---------------------------------------------------------------------------


def _models(h: "_Handler", app: "ModelServer", key: "KeyInfo") -> dict:
    data = [{"id": m, "object": "model", "created": 0, "owned_by": "ollama"}
            for m in app.chat_models()]
    stt_name = getattr(app.stt, "model_name", None)
    for audio_id in (*AUDIO_MODEL_IDS, *([stt_name] if stt_name else [])):
        data.append({"id": audio_id, "object": "model", "created": 0, "owned_by": "whisper"})
    h.send_json(200, {"object": "list", "data": data})
    return {}


# ---- chat -----------------------------------------------------------------------------


def _json_body(h: "_Handler", limit: int) -> dict:
    raw = h.read_body(limit)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise OpenAIError(400, "the body must be JSON") from None
    if not isinstance(data, dict):
        raise OpenAIError(400, "the body must be a JSON object")
    return data


def _chat(h: "_Handler", app: "ModelServer", key: "KeyInfo") -> dict:
    import requests

    data = _json_body(h, MAX_CHAT_BYTES)
    model = data.get("model")
    if not isinstance(model, str) or not model:
        raise OpenAIError(400, "'model' is required", param="model")
    if model not in app.chat_models():
        if not app.ollama_up and model in app.chat_allowlist:
            # Offered, but the runtime is down: a retryable outage, not a typo.
            raise OpenAIError(503, "the language models are unavailable right now; retry shortly",
                              type="server_error")
        raise OpenAIError(404, f"the model '{model}' does not exist or is not offered here",
                          param="model", code="model_not_found")
    if not isinstance(data.get("messages"), list) or not data["messages"]:
        raise OpenAIError(400, "'messages' must be a non-empty list", param="messages")
    if "reasoning_effort" not in data and "reasoning" not in data:
        # Thinking models (qwen3.5) otherwise spend the whole max_tokens on a
        # hidden reasoning pass and answer with empty content; a caller that
        # wants the reasoning asks for it.
        data["reasoning_effort"] = "none"
    stream = bool(data.get("stream"))
    with app.llm.turn(key.name, limit=key.concurrency):
        try:
            reply = requests.post(f"{app.ollama_url}/v1/chat/completions", json=data,
                                  stream=stream, timeout=(5.0, CHAT_TIMEOUT_S))
        except requests.RequestException as exc:
            raise OpenAIError(503, f"the language model isn't reachable ({type(exc).__name__})",
                              type="server_error") from None
        with reply:
            if reply.status_code >= 400:
                raise OpenAIError(reply.status_code if reply.status_code < 500 else 502,
                                  _ollama_error(reply))
            if not stream:
                payload = reply.json()
                h.send_json(200, payload)
                return _tokens(payload.get("usage"))
            return _relay_stream(h, reply)


def _relay_stream(h: "_Handler", reply) -> dict:
    """Server-sent events straight through; the body ends when we close."""
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream; charset=utf-8")
    h.send_header("Cache-Control", "no-cache")
    h.send_header("Connection", "close")
    h.end_headers()
    h.close_connection = True
    usage: dict = {}
    for line in reply.iter_lines(decode_unicode=False):
        h.wfile.write(line + b"\n")
        if not line:
            h.wfile.flush()
            continue
        if line.startswith(b"data: {") and b'"usage"' in line:
            try:
                usage = _tokens(json.loads(line[6:]).get("usage")) or usage
            except ValueError:
                pass
    h.wfile.flush()
    return usage


def _tokens(usage: object) -> dict:
    if not isinstance(usage, dict):
        return {}
    return {"prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0)}


def _ollama_error(reply) -> str:
    try:
        body = reply.json()
        err = body.get("error")
        return str(err.get("message") if isinstance(err, dict) else err)[:300]
    except (ValueError, AttributeError):
        return f"the language model answered HTTP {reply.status_code}"


# ---- audio ----------------------------------------------------------------------------


def _audio(h: "_Handler", app: "ModelServer", key: "KeyInfo", *, task: str) -> dict:
    from .server import MAX_UPLOAD_BYTES
    from .vad import Segmenter

    fields, files = parse_multipart(h.headers.get("Content-Type", ""), h.read_body(MAX_UPLOAD_BYTES))
    upload = files.get("file")
    if upload is None or not upload.data:
        raise OpenAIError(400, "'file' is required", param="file")
    response_format = fields.get("response_format") or "json"
    language = (fields.get("language") or "").strip().lower() or None
    if language is not None and (len(language) > 8 or not language.isalpha()):
        raise OpenAIError(400, "'language' must be an ISO-639-1 code like 'ar' or 'en'",
                          param="language")
    transcription_response("", language=None, duration=0.0, segments=[],
                           response_format=response_format)  # validates the format early
    if task == "translate" and app.translator is None:
        raise OpenAIError(503, "no translator is configured on this server", type="server_error")
    pcm, duration = decode_audio(upload.data, upload.filename, max_seconds=MAX_AUDIO_FILE_S)

    segmenter = Segmenter()
    pieces = segmenter.feed(pcm) + segmenter.flush()
    segments: list[tuple[float, float, str]] = []
    langs: Counter[str] = Counter()
    for piece in pieces:
        # One turn per utterance: other platforms get the GPU in between.
        with app.speech.turn(key.name, limit=key.concurrency):
            found = app.stt.recognize(piece.pcm, language=language)
        if found is None:
            continue
        text, lang = found
        lang = lang or detect_language(text)
        langs[lang] += 1
        if task == "translate" and lang != "en":
            text = _to_english(app, key, text, lang)
        segments.append((piece.start_ms / 1000.0, piece.end_ms / 1000.0, text))
    spoken = language or (langs.most_common(1)[0][0] if langs else None)
    content_type, body = transcription_response(
        " ".join(t for _, _, t in segments), language="en" if task == "translate" else spoken,
        duration=duration, segments=segments, response_format=response_format, task=task)
    h.send_body(200, content_type, body)
    return {"audio_seconds": duration}


def _to_english(app: "ModelServer", key: "KeyInfo", text: str, lang: str) -> str:
    from .translate import TranslationError

    src = lang if lang in ("ar", "en") else detect_language(text)
    if src == "en":
        return text
    with app.llm.turn(key.name, limit=key.concurrency):
        try:
            return app.translator.translate(text, src, "en")
        except TranslationError as exc:
            raise OpenAIError(503, f"translation failed ({exc})", type="server_error") from None


# ---- text translation (not an OpenAI route) -------------------------------------------


def _translate(h: "_Handler", app: "ModelServer", key: "KeyInfo") -> dict:
    from .translate import TranslationError

    data = _json_body(h, 4 * MAX_TRANSLATE_CHARS + 1024)
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        raise OpenAIError(400, "'text' is required", param="text")
    if len(text) > MAX_TRANSLATE_CHARS:
        raise OpenAIError(413, f"'text' is over {MAX_TRANSLATE_CHARS} characters", param="text")
    target = data.get("target")
    if target not in ("ar", "en"):
        raise OpenAIError(400, "'target' must be 'ar' or 'en'", param="target")
    source = data.get("source") or detect_language(text)
    if source not in ("ar", "en"):
        raise OpenAIError(400, "'source' must be 'ar' or 'en' (or left out)", param="source")
    translator = app.translator
    if translator is None:
        raise OpenAIError(503, "no translator is configured on this server", type="server_error")
    if source == target:
        out = text
    else:
        lines = text.split("\n")
        with app.llm.turn(key.name, limit=key.concurrency):
            try:
                out = "\n".join(translator.translate(line, source, target) if line.strip()
                                else line for line in lines)
            except TranslationError as exc:
                raise OpenAIError(503, f"translation failed ({exc})", type="server_error") from None
    h.send_json(200, {"text": out, "source": source, "target": target,
                      "translator": translator.name})
    return {}
