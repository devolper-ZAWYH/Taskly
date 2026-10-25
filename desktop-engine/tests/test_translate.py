"""Translation: the bilingual slots, the cleanup of a chat model's answer, the
Ollama request (monkeypatched, no network), and the translator factory."""

from __future__ import annotations

import pytest

from taskly_live import translate
from taskly_live.translate import (
    OllamaTranslator,
    TranslationError,
    _clean,
    bilingual,
    build_translator,
)


class FakeTranslator:
    """Records every call; answers with a fixed, recognisable translation."""

    name = "fake"

    def __init__(self, answer: str | None = None, error: Exception | None = None):
        self.calls: list[tuple[str, str, str]] = []
        self.answer = answer
        self.error = error

    def translate(self, text: str, src: str, dst: str) -> str:
        self.calls.append((text, src, dst))
        if self.error is not None:
            raise self.error
        return self.answer if self.answer is not None else f"<{dst}:{text}>"


# ---- bilingual(): the spoken slot and the translated slot ---------------------------

def test_arabic_line_keeps_arabic_and_translates_to_english():
    tr = FakeTranslator(answer="Good morning")
    en, ar, seconds = bilingual("صباح الخير", "ar", tr)
    assert en == "Good morning"
    assert ar == "صباح الخير"
    assert tr.calls == [("صباح الخير", "ar", "en")]
    assert seconds is not None and seconds >= 0


def test_english_line_keeps_english_and_translates_to_arabic():
    tr = FakeTranslator(answer="صباح الخير")
    en, ar, _ = bilingual("Good morning", "en", tr)
    assert en == "Good morning"
    assert ar == "صباح الخير"
    assert tr.calls == [("Good morning", "en", "ar")]


def test_unknown_language_translates_arabic_from_the_english_pivot():
    tr = FakeTranslator(answer="مرحبا")
    en, ar, _ = bilingual("Hello", None, tr, text_en="Hello")
    assert en == "Hello"
    assert ar == "مرحبا"
    assert tr.calls == [("Hello", "en", "ar")]


def test_unknown_language_without_a_pivot_calls_nothing():
    tr = FakeTranslator()
    assert bilingual("???", None, tr) == (None, None, None)
    assert tr.calls == []


def test_translator_failure_drops_only_its_slot():
    tr = FakeTranslator(error=RuntimeError("model fell over"))
    en, ar, seconds = bilingual("صباح الخير", "ar", tr)  # must not raise
    assert en is None
    assert ar == "صباح الخير"
    assert seconds is not None


def test_empty_translation_counts_as_missing():
    tr = FakeTranslator(answer="   ")
    en, ar, _ = bilingual("Good morning", "en", tr)
    assert en == "Good morning"
    assert ar is None


def test_no_translator_fills_only_the_spoken_slot():
    assert bilingual("صباح الخير", "ar", None) == (None, "صباح الخير", None)
    assert bilingual("Good morning", "en", None) == ("Good morning", None, None)


# ---- _clean(): the bare translation out of a chat answer -----------------------------

@pytest.mark.parametrize("reply, expected", [
    ("<think>let me see</think>\nGood morning", "Good morning"),
    ("<THINK>x</THINK>Good morning", "Good morning"),
    ('"Good morning"', "Good morning"),
    ("'Good morning'", "Good morning"),
    ("Translation: Good morning", "Good morning"),
    ("English: Good morning", "Good morning"),
    ("الترجمة: صباح الخير", "صباح الخير"),
    ("  Good morning  ", "Good morning"),
])
def test_clean_strips_wrappers(reply, expected):
    assert _clean(reply, "source line") == expected


@pytest.mark.parametrize("reply, expected", [
    ("“Good morning”", "Good morning"),   # curly double quotes (in the module's set)
    ("«صباح الخير»", "صباح الخير"),        # guillemets (in the module's set)
])
def test_clean_strips_curly_and_guillemet_quotes(reply, expected):
    assert _clean(reply, "source line") == expected


@pytest.mark.parametrize("reply", ["", "   ", "<think>only reasoning</think>"])
def test_clean_rejects_empty_output(reply):
    with pytest.raises(TranslationError, match="empty"):
        _clean(reply, "source line")


def test_clean_rejects_a_rambling_answer():
    with pytest.raises(TranslationError, match="longer"):
        _clean("x" * 300, "hi")  # cap is 4 * len(source) + 200 = 208


def test_clean_accepts_a_long_answer_within_the_cap():
    assert _clean("x" * 200, "hi") == "x" * 200


# ---- OllamaTranslator.translate with requests.post monkeypatched ---------------------

class FakeReply:
    def __init__(self, status: int = 200, payload: dict | None = None, text: str = ""):
        self.status_code = status
        self._payload = payload
        self.text = text or ("" if payload is None else str(payload))

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _ok(content: str) -> FakeReply:
    return FakeReply(200, {"message": {"role": "assistant", "content": content}})


@pytest.fixture()
def posts(monkeypatch):
    """Replace requests.post in translate.py; `posts.replies` queues answers."""

    class Recorder:
        def __init__(self):
            self.replies: list[FakeReply] = []
            self.calls: list[dict] = []

        def __call__(self, url, json=None, timeout=None, **_):
            self.calls.append({"url": url, "json": json, "timeout": timeout})
            if not self.replies:
                raise AssertionError("unexpected extra request to Ollama")
            return self.replies.pop(0)

    rec = Recorder()
    monkeypatch.setattr(translate.requests, "post", rec)
    return rec


def test_ollama_request_disables_thinking_and_names_both_languages(posts):
    posts.replies.append(_ok("Good morning"))
    out = OllamaTranslator("http://ollama.test:11434", "qwen-test").translate(
        "صباح الخير", "ar", "en")
    assert out == "Good morning"

    (call,) = posts.calls
    assert call["url"] == "http://ollama.test:11434/api/chat"
    body = call["json"]
    assert body["model"] == "qwen-test"
    assert body["think"] is False
    assert body["stream"] is False
    system, user = body["messages"][0], body["messages"][1]
    assert system["role"] == "system"
    assert "Arabic" in system["content"] and "English" in system["content"]
    assert user == {"role": "user", "content": "صباح الخير"}


def test_ollama_answer_is_cleaned(posts):
    posts.replies.append(_ok("<think>hmm</think>Translation: Good morning"))
    assert OllamaTranslator().translate("صباح الخير", "ar", "en") == "Good morning"


def test_ollama_retries_without_think_when_the_model_rejects_it(posts):
    posts.replies.append(FakeReply(400, text='{"error": "think is not supported"}'))
    posts.replies.append(_ok("Good morning"))
    assert OllamaTranslator().translate("صباح الخير", "ar", "en") == "Good morning"
    assert len(posts.calls) == 2
    assert "think" not in posts.calls[1]["json"]


def test_ollama_http_500_is_a_translation_error(posts):
    posts.replies.append(FakeReply(500, text="boom"))
    with pytest.raises(TranslationError, match="HTTP 500"):
        OllamaTranslator().translate("Good morning", "en", "ar")


def test_ollama_reply_without_a_message_is_a_translation_error(posts):
    posts.replies.append(FakeReply(200, {"unexpected": True}))
    with pytest.raises(TranslationError, match="no message"):
        OllamaTranslator().translate("Good morning", "en", "ar")


@pytest.mark.parametrize("src, dst", [("fr", "en"), ("en", "fr"), ("en", "en")])
def test_unsupported_pair_is_refused_before_any_request(posts, src, dst):
    with pytest.raises(TranslationError, match="unsupported pair"):
        OllamaTranslator().translate("bonjour", src, dst)
    assert posts.calls == []


def test_a_failing_ollama_inside_bilingual_keeps_the_spoken_line(posts):
    posts.replies.append(FakeReply(500, text="boom"))
    en, ar, _ = bilingual("صباح الخير", "ar", OllamaTranslator())
    assert en is None and ar == "صباح الخير"


# ---- build_translator ----------------------------------------------------------------

@pytest.mark.parametrize("kind", ["off", "OFF", "  off ", None, ""])
def test_off_builds_no_translator(kind):
    assert build_translator(kind) is None


def test_ollama_kind_builds_an_ollama_translator():
    tr = build_translator("ollama", ollama_url="http://127.0.0.1:1", ollama_model="m1")
    assert isinstance(tr, OllamaTranslator)
    assert tr.name == "ollama:m1"
    assert tr.url == "http://127.0.0.1:1"


def test_unknown_kind_is_a_value_error():
    with pytest.raises(ValueError, match="unknown translator"):
        build_translator("deepl")


class _NoMarian:
    """Stands in for MarianTranslator when its models can't load."""

    def __init__(self, *args, **kwargs):
        raise TranslationError("no models here")


class _FakeMarian:
    name = "marian:fake"

    def __init__(self, models_dir=None, **kwargs):
        self.models_dir = models_dir


def _pulled(*models):
    """`OllamaTranslator.available` (inherited by Hy-MT2) for these models only."""
    return lambda self: self.model in models


def test_auto_prefers_the_ollama_chat_model(monkeypatch):
    monkeypatch.setattr(OllamaTranslator, "available",
                        _pulled(translate.DEFAULT_OLLAMA_TRANSLATE_MODEL, translate.DEFAULT_HYMT_MODEL))
    monkeypatch.setattr(translate, "MarianTranslator", _NoMarian)  # never reached
    tr = build_translator("auto", ollama_url="http://ollama.test:1")
    assert type(tr) is OllamaTranslator
    assert tr.url == "http://ollama.test:1"


def test_auto_takes_hymt_when_the_chat_model_is_not_pulled(monkeypatch):
    monkeypatch.setattr(OllamaTranslator, "available", _pulled(translate.DEFAULT_HYMT_MODEL))
    monkeypatch.setattr(translate, "MarianTranslator", _NoMarian)
    assert isinstance(build_translator("auto"), translate.HyMtTranslator)


def test_hymt_kind_builds_hymt():
    assert isinstance(build_translator("hymt"), translate.HyMtTranslator)


def test_auto_takes_marian_when_ollama_has_neither(monkeypatch, tmp_path):
    monkeypatch.setattr(OllamaTranslator, "available", _pulled())
    monkeypatch.setattr(translate, "MarianTranslator", _FakeMarian)
    tr = build_translator("auto", models_dir=tmp_path)
    assert isinstance(tr, _FakeMarian)
    assert tr.models_dir == tmp_path


def test_marian_kind_builds_marian(monkeypatch):
    monkeypatch.setattr(translate, "MarianTranslator", _FakeMarian)
    assert isinstance(build_translator("marian"), _FakeMarian)


def test_auto_settles_for_none_when_nothing_works(monkeypatch):
    monkeypatch.setattr(translate, "MarianTranslator", _NoMarian)
    monkeypatch.setattr(OllamaTranslator, "available", _pulled())
    assert build_translator("auto") is None


# ---- failing fast inside the GPU slot -------------------------------------


def test_a_failure_starts_a_cool_off_that_fails_at_once(posts, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(translate.time, "monotonic", lambda: now[0])
    tr = OllamaTranslator("http://ollama.test:11434", "qwen-test")
    posts.replies.append(FakeReply(500, {"error": "busy"}))
    with pytest.raises(TranslationError):
        tr.translate("hello", "en", "ar")
    # Within the cool-off: no request at all (posts would raise on an extra one).
    now[0] += translate.COOL_OFF_S - 1
    with pytest.raises(TranslationError, match="cooling off"):
        tr.translate("hello", "en", "ar")
    assert len(posts.calls) == 1
    # Afterwards it tries again.
    now[0] += 2
    posts.replies.append(_ok("مرحبا"))
    assert tr.translate("hello", "en", "ar") == "مرحبا"


def test_the_chat_translator_shares_the_summarizers_context_size(posts):
    from taskly_live.summarize import OllamaSummarizer

    posts.replies.append(_ok("hi"))
    OllamaTranslator("http://ollama.test:11434", "qwen-test").translate("مرحبا", "ar", "en")
    # Same model + same num_ctx = no reload between a summary and the next line.
    assert posts.calls[0]["json"]["options"]["num_ctx"] == OllamaSummarizer._context_for("", "")


def test_translator_timeout_is_short():
    assert OllamaTranslator().timeout <= 10.0


def test_ollama_defaults_to_ipv4_loopback():
    # localhost costs ~2 s a request on Windows (IPv6 first, Ollama is IPv4).
    assert translate.DEFAULT_OLLAMA_URL == "http://127.0.0.1:11434"


# ---- Hy-MT2 through Ollama's raw generate --------------------------------


def test_hymt_sends_its_own_prompt_raw_with_the_stop_token(posts):
    posts.replies.append(FakeReply(200, {"response": "We will send the report on Friday."}))
    out = translate.HyMtTranslator("http://ollama.test:11434").translate(
        "سنرسل التقرير يوم الجمعة", "ar", "en")
    assert out == "We will send the report on Friday."
    (call,) = posts.calls
    assert call["url"] == "http://ollama.test:11434/api/generate"
    body = call["json"]
    assert body["raw"] is True and body["stream"] is False
    assert body["model"] == translate.DEFAULT_HYMT_MODEL
    assert body["prompt"].startswith("<｜hy_begin▁of▁sentence｜><｜hy_User｜>")
    assert ("into English. Note that you should only output the translated result without "
            "any additional explanation:\n\nسنرسل التقرير يوم الجمعة") in body["prompt"]
    assert body["prompt"].endswith("<｜hy_Assistant｜>")
    assert "<｜hy_place▁holder▁no▁2｜>" in body["options"]["stop"]
    assert body["options"]["num_ctx"] == 2048  # fixed: a change reloads the model


def test_hymt_names_arabic_as_the_target_for_english_lines(posts):
    posts.replies.append(FakeReply(200, {"response": "مرحبا"}))
    translate.HyMtTranslator("http://ollama.test:11434").translate("hello", "en", "ar")
    assert "into Arabic. Note" in posts.calls[0]["json"]["prompt"]


def test_hymt_failures_are_translation_errors(posts):
    # A fresh translator per case: a failure starts a cool-off.
    def hymt():
        return translate.HyMtTranslator("http://ollama.test:11434")

    posts.replies.append(FakeReply(500, {"error": "boom"}))
    with pytest.raises(TranslationError, match="HTTP 500"):
        hymt().translate("hello", "en", "ar")
    posts.replies.append(FakeReply(200, {"message": "wrong shape"}))
    with pytest.raises(TranslationError, match="no response"):
        hymt().translate("hello", "en", "ar")
    with pytest.raises(TranslationError, match="unsupported"):
        hymt().translate("hello", "en", "fr")
    assert len(posts.calls) == 2


def test_release_asks_ollama_to_unload_the_model(posts):
    posts.replies.append(FakeReply(200, {}))
    translate.HyMtTranslator("http://ollama.test:11434").release()
    (call,) = posts.calls
    assert call["url"].endswith("/api/generate")
    assert call["json"] == {"model": translate.DEFAULT_HYMT_MODEL, "keep_alive": 0}


# ---- Marian: tokens in and out (fake CTranslate2 + sentencepiece) ---------


class _FakeSp:
    def encode(self, text, out_type=str):
        return text.split()

    def decode(self, pieces):
        return " ".join(pieces)


class _FakeCt2:
    def __init__(self, answer):
        self.answer = answer
        self.batches = []

    def translate_batch(self, batch, **kwargs):
        self.batches.append(batch)

        class _Hyp:
            hypotheses = [self.answer]

        return [_Hyp()]


def _pair(lang_token, answer):
    pair = translate._MarianPair.__new__(translate._MarianPair)
    pair.model = _FakeCt2(answer)
    pair.source = _FakeSp()
    pair.target = _FakeSp()
    pair.lang_token = lang_token
    return pair


def test_marian_en_ar_prefixes_the_target_language_token_and_strips_it():
    pair = _pair(">>ara<<", [">>ara<<", "مرحبا", "بكم"])
    assert pair.translate("hello all") == "مرحبا بكم"
    assert pair.model.batches == [[[">>ara<<", "hello", "all", "</s>"]]]


def test_marian_ar_en_sends_no_language_token():
    pair = _pair(None, ["hello"])
    assert pair.translate("مرحبا") == "hello"
    assert pair.model.batches == [[["مرحبا", "</s>"]]]


def test_marian_translator_refuses_pairs_it_has_no_model_for():
    tr = translate.MarianTranslator.__new__(translate.MarianTranslator)
    tr._pairs = {("ar", "en"): _pair(None, ["x"])}
    with pytest.raises(TranslationError):
        tr.translate("hi", "en", "fr")
    with pytest.raises(TranslationError):
        tr._pairs[("ar", "en")] = _pair(None, [])
        tr.translate("مرحبا", "ar", "en")


def test_warm_up_waits_for_a_cold_load_then_restores_the_short_timeout(posts):
    tr = OllamaTranslator("http://ollama.test:11434", "qwen-test", keep_alive=-1)
    posts.replies.append(_ok("حسنا"))
    assert tr.warm_up() >= 0
    (call,) = posts.calls
    assert call["timeout"][1] >= 120.0  # a cold load may take ~10 s or more
    assert call["json"]["keep_alive"] == -1
    assert tr.timeout == translate.DEFAULT_TIMEOUT_S
