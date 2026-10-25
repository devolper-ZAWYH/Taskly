"""AutoTranslator: the best translator that works now, re-checked in the background.

Ollama availability, warm-up and the Marian fallback are faked by monkeypatching
the classes; the clock is a list-backed lambda, so the re-check interval is
driven by the test. requests is patched to fail if anything reaches for the
network, so nothing here can touch a real Ollama.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
import requests

from taskly_live import translate
from taskly_live.translate import AutoTranslator, OllamaTranslator, TranslationError

CHAT = "qwen-test"
HYMT = translate.DEFAULT_HYMT_MODEL
RECHECK_S = 30.0


def _no_network(*args, **kwargs):
    raise AssertionError("the test tried to reach the network")


@pytest.fixture()
def world(monkeypatch):
    """Fake Ollama availability and Marian, with the knobs the tests turn."""
    w = SimpleNamespace(
        up=set(),  # Ollama models that are pulled and answering
        probes=[],  # every availability check, by model name
        warm_calls=[],  # every warm-up, by model name
        warm_error=None,  # raised by warm-up when set
        warm_seen=[],  # the name of the translator in use when warm-up ran
        releases=[],
        marian_built=[],
        marian_attempts=0,
        marian_error=None,
        now=[1000.0],
        auto=None,
    )
    w.clock = lambda: w.now[0]

    class FakeMarian:
        name = "marian:fake (cpu)"

        def __init__(self, models_dir=None, **_kwargs):
            w.marian_attempts += 1
            if w.marian_error is not None:
                raise w.marian_error
            w.marian_built.append(self)

        def translate(self, text, src, dst):
            return f"MARIAN({text})"

    def available(self):
        w.probes.append(self.model)
        return self.model in w.up

    def warm_up(self):
        w.warm_calls.append(self.model)
        if w.auto is not None:
            w.warm_seen.append(w.auto.name)
        if w.warm_error is not None:
            raise w.warm_error
        return 0.1

    def ollama_translate(self, text, src, dst):
        return f"OLLAMA({text})"

    def release(self):
        w.releases.append(self.model)

    monkeypatch.setattr(translate, "MarianTranslator", FakeMarian)
    monkeypatch.setattr(OllamaTranslator, "available", available)
    monkeypatch.setattr(OllamaTranslator, "warm_up", warm_up)
    monkeypatch.setattr(OllamaTranslator, "translate", ollama_translate)
    monkeypatch.setattr(OllamaTranslator, "release", release)
    monkeypatch.setattr(requests, "get", _no_network)
    monkeypatch.setattr(requests, "post", _no_network)
    yield w
    settle()  # no re-check thread outlives its test


def make_auto(w, **kwargs) -> AutoTranslator:
    auto = AutoTranslator("http://ollama.test:11434", CHAT, recheck_s=RECHECK_S,
                          clock=w.clock, **kwargs)
    w.auto = auto
    return auto


def advance(w, seconds: float) -> None:
    w.now[0] += seconds


def settle(timeout: float = 2.0) -> None:
    """Wait for every background re-check to finish (they are daemon threads)."""
    deadline = time.monotonic() + timeout
    for thread in list(threading.enumerate()):
        if thread.name == "translator-recheck":
            thread.join(max(0.0, deadline - time.monotonic()))
            assert not thread.is_alive(), "the background re-check did not finish"


# ---- the first choice -----------------------------------------------------------------


def test_the_ollama_chat_model_at_start_is_chosen_and_never_rechecked(world):
    world.up = {CHAT}
    auto = make_auto(world)

    assert auto.name.startswith("auto -> ollama:")
    assert auto.name == "auto -> ollama:qwen-test"
    assert auto.model == CHAT
    probes_at_start = len(world.probes)

    advance(world, 10 * RECHECK_S)
    assert auto.translate("مرحبا", "ar", "en") == "OLLAMA(مرحبا)"
    settle()

    assert world.probes[probes_at_start:] == []  # best found: nothing is looked for again
    assert world.marian_built == []


# ---- Ollama down at start -------------------------------------------------------------


def test_marian_serves_while_ollama_is_down_then_ollama_takes_over_on_a_recheck(world):
    auto = make_auto(world)
    assert auto.name == "auto -> marian:fake (cpu)"
    assert auto.translate("مرحبا", "ar", "en") == "MARIAN(مرحبا)"
    assert len(world.marian_built) == 1

    world.up = {CHAT}  # Ollama comes up after the server started
    advance(world, RECHECK_S + 1)
    auto.translate("مرحبا", "ar", "en")  # this call starts the background re-check
    settle()

    assert world.warm_calls == [CHAT]
    # The new model was warmed while Marian still served the lines.
    assert world.warm_seen == ["auto -> marian:fake (cpu)"]
    assert auto.model == CHAT
    assert auto.name == "auto -> ollama:qwen-test"
    assert auto._marian is None  # Marian's reference (and VRAM) is dropped


def test_a_failed_warm_up_keeps_marian_and_the_next_interval_tries_again(world):
    auto = make_auto(world)
    world.up = {CHAT}
    world.warm_error = TranslationError("cold load timed out")

    advance(world, RECHECK_S + 1)
    auto.translate("مرحبا", "ar", "en")
    settle()

    assert world.warm_calls == [CHAT]
    assert auto.model is None  # still Marian
    assert auto.name == "auto -> marian:fake (cpu)"
    assert len(world.marian_built) == 1  # not reloaded either

    world.warm_error = None
    advance(world, RECHECK_S + 1)
    auto.translate("مرحبا", "ar", "en")
    settle()

    assert world.warm_calls == [CHAT, CHAT]  # tried again on the next interval
    assert auto.model == CHAT


# ---- nothing available ----------------------------------------------------------------


def test_nothing_available_and_marian_failing_raises_no_translator_yet(world):
    world.marian_error = RuntimeError("sentencepiece is not installed")
    auto = make_auto(world)

    assert "none yet" in auto.name
    with pytest.raises(TranslationError, match="no translator available yet"):
        auto.translate("مرحبا", "ar", "en")


def test_a_failing_marian_load_is_not_retried(world):
    world.marian_error = RuntimeError("offline: no model cache")
    auto = make_auto(world)
    assert auto.allow_marian is False

    for _ in range(2):
        advance(world, RECHECK_S + 1)
        with pytest.raises(TranslationError, match="no translator available yet"):
            auto.translate("مرحبا", "ar", "en")
        settle()

    assert world.marian_attempts == 1
    assert auto.allow_marian is False


# ---- Hy-MT2 as the second choice ------------------------------------------------------


def test_hymt_is_chosen_without_the_chat_model_and_rechecks_continue(world):
    world.up = {HYMT}
    auto = make_auto(world)

    assert auto.model == HYMT
    assert auto.name == "auto -> ollama:Hy-MT2-1.8B"
    assert world.marian_built == []
    probes_at_start = len(world.probes)

    advance(world, RECHECK_S + 1)
    auto.translate("مرحبا", "ar", "en")
    settle()
    assert CHAT in world.probes[probes_at_start:]  # the first choice is looked for again
    assert auto.model == HYMT  # ...and is still not there, so Hy-MT2 stays

    world.up.add(CHAT)  # the chat model gets pulled
    advance(world, RECHECK_S + 1)
    auto.translate("مرحبا", "ar", "en")
    settle()
    assert auto.model == CHAT


# ---- forwarding to the current translator ---------------------------------------------


def test_keep_alive_is_forwarded_to_the_current_translator(world):
    world.up = {CHAT}
    auto = make_auto(world)
    assert auto.keep_alive == translate.TRANSLATOR_KEEP_ALIVE

    auto.keep_alive = "5m"

    assert auto.keep_alive == "5m"
    assert auto._current.keep_alive == "5m"


def test_keep_alive_is_accepted_when_marian_is_the_current_translator(world):
    auto = make_auto(world)  # Ollama down: Marian is current, and has no keep_alive
    auto.keep_alive = -1
    assert auto.keep_alive == -1


def test_warm_up_and_release_forward_to_the_current_translator(world):
    world.up = {CHAT}
    auto = make_auto(world)

    assert auto.warm_up() == 0.1
    assert world.warm_calls == [CHAT]

    auto.release()
    assert world.releases == [CHAT]


def test_warm_up_and_release_are_harmless_when_the_translator_has_neither(world):
    auto = make_auto(world)  # Marian: no warm_up, no release
    assert auto.warm_up() == 0.0
    auto.release()  # no error
    assert world.warm_calls == []
    assert world.releases == []
