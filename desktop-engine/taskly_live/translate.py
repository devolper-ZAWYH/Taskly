"""Line translation, Arabic <-> English, for the bilingual transcript.

Every recognised line reaches Taskly in both app languages: `text_en` and
`text_ar` (docs/live-meetings.md §3). One of the two is the spoken text
itself; the other comes from a `Translator`. When one is configured the
STT pipeline skips Whisper's own translate pass (it only goes X -> English,
and turbo models can't do it at all).

A translation is a nicety, never a gate: `bilingual()` swallows every
translator failure and hands back the line without that translation, so a
dead or slow translator can never drop speech.

Translators (measured on this PC, 2026-10-25; README "Models"):
  * `OllamaTranslator`  an Ollama chat model, qwen3.5:4b by default — the
                        default: the only one that kept the meaning of
                        Gulf-dialect and Arabic/English-mixed lines, ~0.3 s a
                        line, and the same model writes the summary, so one
                        model sits in VRAM for both;
  * `HyMtTranslator`    Tencent Hy-MT2-1.8B (Apache-2.0) in Ollama: fast
                        (~0.2 s) and fine on clean MSA/English, but it
                        flipped the meaning of dialect lines in tests;
  * `MarianTranslator`  Helsinki-NLP opus-mt-tc-big (CC-BY-4.0) on
                        CTranslate2, no Ollama needed: ~0.05 s, weakest;
  * `build_translator`  picks one from config ("off", "ollama", "hymt",
                        "marian", "auto" = the first of those that works).

Ollama translators run inside the model server's GPU slot, so they fail
fast: a short timeout, then a cool-off in which lines go out untranslated
instead of queueing behind, say, a long summary that holds Ollama.

Nothing here logs the words themselves: ids, languages, sizes and timings.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Callable, Protocol

import requests

log = logging.getLogger(__name__)

LANG_NAMES = {"ar": "Arabic", "en": "English"}
# 127.0.0.1, not localhost: on Windows `requests` tries IPv6 ::1 first and
# Ollama only listens on IPv4, which costs ~2 s per request.
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_TRANSLATE_MODEL = "qwen3.5:4b"
DEFAULT_HYMT_MODEL = "hf.co/tencent/Hy-MT2-1.8B-GGUF:Q8_0"
DEFAULT_TIMEOUT_S = 10.0
# After a failed call, skip the translator this long (lines go untranslated).
COOL_OFF_S = 30.0
# A translator stays loaded through a meeting's pauses, then frees its VRAM.
TRANSLATOR_KEEP_ALIVE = "30m"
# One context size for every caller of a model: the same model at another
# num_ctx makes Ollama reload it (seconds). The summarizer's floor uses it
# too, and Ollama's OpenAI-compatible endpoint — which ignores num_ctx and
# uses OLLAMA_CONTEXT_LENGTH — must be set to match (the PC's service does).
CHAT_NUM_CTX = int(os.environ.get("TASKLY_OLLAMA_NUM_CTX", "") or 8_192)
TRANSLATOR_KINDS = ("auto", "off", "ollama", "hymt", "marian")
# (CTranslate2 weights, sentencepiece source, target-language token). The
# CT2 conversions don't carry the tokenizers; Helsinki-NLP's originals do.
# Licence: CC-BY-4.0 (attribution: Helsinki-NLP / OPUS-MT, Tiedemann et al.).
MARIAN_MODELS = {
    ("ar", "en"): ("ai-path/opus-mt-tc-big-ar-en-ct2", "Helsinki-NLP/opus-mt-tc-big-ar-en", None),
    ("en", "ar"): ("ai-path/opus-mt-tc-big-en-ar-ct2", "Helsinki-NLP/opus-mt-tc-big-en-ar", ">>ara<<"),
}

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_QUOTES = {'"': '"', "'": "'", "«": "»", "“": "”", "”": "”", "„": "“"}


class TranslationError(RuntimeError):
    """The translator couldn't produce a usable line."""


class Translator(Protocol):
    name: str

    def translate(self, text: str, src: str, dst: str) -> str: ...


def bilingual(text: str, lang: str | None, translator: Translator | None,
              *, text_en: str | None = None) -> tuple[str | None, str | None, float | None]:
    """`(text_en, text_ar, seconds)` for one spoken line; never raises.

    The spoken language fills its own slot; the translator fills the other.
    A line of unknown language can pass the English it already has
    (`text_en`, e.g. Whisper's translate output) to get the Arabic from it.
    `seconds` is the translator's time, or None when it wasn't called.
    """
    en = text if lang == "en" else text_en
    ar = text if lang == "ar" else None
    if translator is None:
        return en, ar, None
    t0 = time.perf_counter()
    if lang == "ar":
        en = _safe(translator, text, "ar", "en")
    elif lang == "en":
        ar = _safe(translator, text, "en", "ar")
    elif en:
        ar = _safe(translator, en, "en", "ar")
    else:
        return en, ar, None
    return en, ar, time.perf_counter() - t0


def _safe(translator: Translator, text: str, src: str, dst: str) -> str | None:
    try:
        out = translator.translate(text, src, dst)
    except Exception as exc:  # noqa: BLE001 - a lost translation must not lose the line
        log.warning("translate %s->%s failed (%s: %s); sending the line without it",
                    src, dst, type(exc).__name__, str(exc)[:120])
        return None
    out = (out or "").strip()
    return out or None


def _clean(reply: str, source: str) -> str:
    """The bare translation out of a chat model's answer."""
    out = _THINK.sub("", reply).strip()
    # Models like to wrap the line in quotes or label it.
    out = re.sub(r"^(translation|english|arabic|الترجمة)\s*[:：]\s*", "", out,
                 flags=re.IGNORECASE)
    if len(out) >= 2 and _QUOTES.get(out[0]) == out[-1]:
        out = out[1:-1].strip()
    if not out:
        raise TranslationError("empty translation")
    # A rambling answer (notes, alternatives) is worse than none at all.
    if len(out) > 4 * len(source) + 200:
        raise TranslationError("translation far longer than its source")
    return out


class OllamaTranslator:
    """Translate one line with a local Ollama chat model (no streaming)."""

    def __init__(self, url: str = DEFAULT_OLLAMA_URL,
                 model: str = DEFAULT_OLLAMA_TRANSLATE_MODEL,
                 *, timeout: float = DEFAULT_TIMEOUT_S,
                 keep_alive: str | int = TRANSLATOR_KEEP_ALIVE) -> None:
        self.url = url.rstrip("/")
        self.model = model
        self.timeout = float(timeout)
        self.keep_alive = keep_alive
        self.name = f"ollama:{model}"
        self._resume_at = 0.0  # monotonic time the cool-off ends

    def warm_up(self) -> float:
        """Load the model now (a cold load can take ~10 s, longer than a
        line may wait); the seconds it took. Raises TranslationError."""
        t0 = time.perf_counter()
        saved, self.timeout = self.timeout, max(self.timeout, 120.0)
        try:
            self._translate("ok", "en", "ar")
        finally:
            self.timeout = saved
        return time.perf_counter() - t0

    def translate(self, text: str, src: str, dst: str) -> str:
        """One line; during a cool-off it fails at once instead of waiting."""
        if src not in LANG_NAMES or dst not in LANG_NAMES or src == dst:
            raise TranslationError(f"unsupported pair {src}->{dst}")
        if time.monotonic() < self._resume_at:
            raise TranslationError("cooling off after a failure")
        try:
            return self._translate(text, src, dst)
        except TranslationError:
            self._resume_at = time.monotonic() + COOL_OFF_S
            raise

    @staticmethod
    def _system(src: str, dst: str) -> str:
        return (
            f"You translate lines from a business meeting transcript from "
            f"{LANG_NAMES[src]} to {LANG_NAMES[dst]}. Reply with the "
            f"{LANG_NAMES[dst]} translation only: no quotes, notes, "
            "transliteration or alternatives. Keep names, numbers, product "
            "names and technical terms accurate. The line is speech-to-text "
            "output and may be incomplete; translate what is there."
        )

    def _translate(self, text: str, src: str, dst: str) -> str:
        body = {
            "model": self.model,
            "stream": False,
            "think": False,
            "keep_alive": self.keep_alive,
            # num_ctx stays fixed: a different one makes Ollama reload the model.
            "options": {"temperature": 0.0, "num_ctx": CHAT_NUM_CTX},
            "messages": [
                {"role": "system", "content": self._system(src, dst)},
                {"role": "user", "content": text},
            ],
        }
        try:
            reply = requests.post(f"{self.url}/api/chat", json=body,
                                  timeout=(min(5.0, self.timeout), self.timeout))
            if reply.status_code == 400 and "think" in (reply.text or "").lower():
                body.pop("think")
                reply = requests.post(f"{self.url}/api/chat", json=body,
                                      timeout=(min(5.0, self.timeout), self.timeout))
        except requests.RequestException as exc:
            raise TranslationError(f"Ollama unreachable ({type(exc).__name__})") from exc
        if reply.status_code >= 400:
            raise TranslationError(f"Ollama answered HTTP {reply.status_code}")
        try:
            content = reply.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as exc:
            raise TranslationError("Ollama's reply had no message") from exc
        return _clean(str(content or ""), text)

    def available(self) -> bool:
        """Ollama answers and has the model pulled."""
        try:
            tags = requests.get(f"{self.url}/api/tags", timeout=3.0).json()
        except (requests.RequestException, ValueError):
            return False
        names = {m.get("name") for m in tags.get("models", []) if isinstance(m, dict)}
        return self.model in names or f"{self.model}:latest" in names

    def release(self) -> None:
        """Ask Ollama to unload the model now (keep_alive 0), freeing its
        VRAM for something bigger — the summary. The next line reloads it."""
        try:
            requests.post(f"{self.url}/api/generate",
                          json={"model": self.model, "keep_alive": 0}, timeout=10.0)
        except requests.RequestException as exc:
            log.warning("couldn't unload %s (%s)", self.model, type(exc).__name__)


class HyMtTranslator(OllamaTranslator):
    """Tencent Hy-MT2-1.8B in Ollama, prompted the way the model was trained.

    Ollama 0.40 builds a broken chat template for this GGUF (the answer is
    garbage), so the prompt goes through `/api/generate` raw, with the
    model's own turn markers and stop token.
    """

    # Hy-MT2's own default prompt (its model card), not HY-MT1.5's wording.
    _PROMPT = ("<｜hy_begin▁of▁sentence｜><｜hy_User｜>Translate the following text into "
               "{lang}. Note that you should only output the translated result without "
               "any additional explanation:\n\n{text}<｜hy_Assistant｜>")
    _STOP = ["<｜hy_place▁holder▁no▁2｜>", "<｜hy_User｜>"]

    def __init__(self, url: str = DEFAULT_OLLAMA_URL, model: str = DEFAULT_HYMT_MODEL,
                 *, timeout: float = DEFAULT_TIMEOUT_S,
                 keep_alive: str | int = TRANSLATOR_KEEP_ALIVE) -> None:
        super().__init__(url, model, timeout=timeout, keep_alive=keep_alive)
        self.name = "ollama:Hy-MT2-1.8B"

    def _translate(self, text: str, src: str, dst: str) -> str:
        body = {
            "model": self.model,
            "raw": True,
            "stream": False,
            "keep_alive": self.keep_alive,
            "prompt": self._PROMPT.format(lang=LANG_NAMES[dst], text=text),
            "options": {"temperature": 0.0, "num_ctx": 2_048, "stop": self._STOP,
                        "num_predict": 4 * len(text) + 64},
        }
        try:
            reply = requests.post(f"{self.url}/api/generate", json=body,
                                  timeout=(min(5.0, self.timeout), self.timeout))
        except requests.RequestException as exc:
            raise TranslationError(f"Ollama unreachable ({type(exc).__name__})") from exc
        if reply.status_code >= 400:
            raise TranslationError(f"Ollama answered HTTP {reply.status_code}")
        try:
            content = reply.json()["response"]
        except (ValueError, KeyError, TypeError) as exc:
            raise TranslationError("Ollama's reply had no response") from exc
        return _clean(str(content or ""), text)


class _MarianPair:
    """One direction: a CTranslate2 translator plus its two tokenizers."""

    def __init__(self, model_dir: str, source_spm: str, target_spm: str,
                 lang_token: str | None, device: str, compute_type: str) -> None:
        import ctranslate2
        import sentencepiece

        self.model = ctranslate2.Translator(model_dir, device=device,
                                            compute_type=compute_type)
        self.source = sentencepiece.SentencePieceProcessor(model_file=source_spm)
        self.target = sentencepiece.SentencePieceProcessor(model_file=target_spm)
        self.lang_token = lang_token

    def translate(self, text: str) -> str:
        tokens = self.source.encode(text, out_type=str)
        if self.lang_token:
            tokens = [self.lang_token, *tokens]
        result = self.model.translate_batch(
            [tokens + ["</s>"]], beam_size=4, max_decoding_length=512,
            repetition_penalty=1.1,
        )
        out = [t for t in result[0].hypotheses[0]
               if not (t.startswith(">>") and t.endswith("<<"))]
        return self.target.decode(out)


class MarianTranslator:
    """opus-mt-tc-big both ways on CTranslate2 — the same runtime as Whisper.

    Weights (~480 MB a direction) download once into `models_dir` and load
    on the GPU when it works (gpu.py), else the CPU; either way a line takes
    a fraction of Whisper's own decode. Thread-safe: CTranslate2 serves
    concurrent calls.
    """

    def __init__(self, models_dir: Path | None = None, *, device: str | None = None,
                 compute_type: str | None = None) -> None:
        from huggingface_hub import hf_hub_download, snapshot_download

        from .gpu import add_nvidia_dll_dirs

        add_nvidia_dll_dirs()
        import ctranslate2

        cache = {"cache_dir": str(models_dir)} if models_dir is not None else {}
        auto = device in (None, "", "auto")
        attempts: list[tuple[str, str]] = []
        if auto and ctranslate2.get_cuda_device_count() > 0:
            attempts.append(("cuda", compute_type or "int8_float16"))
        attempts.append(("cpu" if auto else str(device), compute_type or "int8"))
        self._pairs: dict[tuple[str, str], _MarianPair] = {}
        last: Exception | None = None
        for dev, ct in attempts:
            try:
                for pair, (weights, spm_repo, token) in MARIAN_MODELS.items():
                    model_dir = snapshot_download(
                        weights, allow_patterns=["model.bin", "config.json", "*vocabulary*"],
                        **cache)
                    self._pairs[pair] = _MarianPair(
                        model_dir,
                        hf_hub_download(spm_repo, "source.spm", **cache),
                        hf_hub_download(spm_repo, "target.spm", **cache),
                        token, dev, ct,
                    )
                    self._pairs[pair].translate("ok")  # warm-up: GPU JIT happens now
                self.device, self.compute_type = dev, ct
                break
            except Exception as exc:  # noqa: BLE001 - fall back down the ladder
                last = exc
                self._pairs.clear()
                log.warning("Marian on %s/%s unusable (%s); trying next option", dev, ct,
                            (str(exc).splitlines() or [type(exc).__name__])[0][:160])
        else:
            raise TranslationError(f"could not load the Marian models: {last}")
        self.name = f"marian:opus-mt-tc-big ({self.device})"

    def translate(self, text: str, src: str, dst: str) -> str:
        pair = self._pairs.get((src, dst))
        if pair is None:
            raise TranslationError(f"unsupported pair {src}->{dst}")
        out = pair.translate(text).strip()
        if not out:
            raise TranslationError("empty translation")
        return out


class AutoTranslator:
    """`--translator auto` for a server that runs for weeks: it keeps looking.

    At boot Ollama may start after the model server; a one-time pick would
    then settle on Marian (or nothing) for the whole run. This picks the best
    translator that works now and, while that isn't the first choice (the
    Ollama chat model), re-checks every `recheck_s` in the background,
    warming a newly found Ollama model up *before* switching to it so no line
    waits on a cold load. It looks like the translator it wraps (`name`,
    `model`, `keep_alive`, `warm_up`, `release`), so the rest of the server
    doesn't care.
    """

    def __init__(self, ollama_url: str = DEFAULT_OLLAMA_URL,
                 ollama_model: str = DEFAULT_OLLAMA_TRANSLATE_MODEL,
                 models_dir: Path | None = None, *, recheck_s: float = 30.0,
                 allow_marian: bool = True,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model
        self.models_dir = models_dir
        self.recheck_s = float(recheck_s)
        self.allow_marian = allow_marian
        self._clock = clock
        self._lock = threading.Lock()
        self._current: Translator | None = None
        self._best = False
        self._marian: Translator | None = None
        self._keep_alive: str | int = TRANSLATOR_KEEP_ALIVE
        self._checking = False
        self._next_check = 0.0
        self._probe(warm=False)

    # ---- looks like the current translator ---------------------------------
    @property
    def name(self) -> str:
        cur = self._current
        return f"auto -> {cur.name}" if cur else "auto -> none yet (re-checking)"

    @property
    def model(self) -> str | None:
        return getattr(self._current, "model", None)

    @property
    def keep_alive(self) -> str | int:
        return self._keep_alive

    @keep_alive.setter
    def keep_alive(self, value: str | int) -> None:
        self._keep_alive = value
        if hasattr(self._current, "keep_alive"):
            self._current.keep_alive = value  # type: ignore[union-attr]

    def warm_up(self) -> float:
        cur = self._current
        if cur is None or not hasattr(cur, "warm_up"):
            return 0.0
        return cur.warm_up()  # type: ignore[union-attr]

    def release(self) -> None:
        cur = self._current
        if cur is not None and hasattr(cur, "release"):
            cur.release()  # type: ignore[union-attr]

    def translate(self, text: str, src: str, dst: str) -> str:
        self._maybe_recheck()
        cur = self._current
        if cur is None:
            raise TranslationError("no translator available yet")
        return cur.translate(text, src, dst)

    # ---- the search ----------------------------------------------------------
    def _maybe_recheck(self) -> None:
        with self._lock:
            if self._best or self._checking or self._clock() < self._next_check:
                return
            self._checking = True
        threading.Thread(target=self._probe_in_background, name="translator-recheck",
                         daemon=True).start()

    def _probe_in_background(self) -> None:
        try:
            self._probe(warm=True)
        finally:
            with self._lock:
                self._checking = False

    def _probe(self, *, warm: bool) -> None:
        """Take the first that works: Ollama chat model, Hy-MT2, Marian, none."""
        found: Translator | None = None
        best = False
        for candidate in (OllamaTranslator(self.ollama_url, self.ollama_model,
                                           keep_alive=self._keep_alive),
                          HyMtTranslator(self.ollama_url, keep_alive=self._keep_alive)):
            if candidate.available():
                if warm:
                    try:
                        candidate.warm_up()
                    except TranslationError:
                        continue  # listed but not answering yet: next round
                found, best = candidate, candidate.model == self.ollama_model
                break
        if found is None and self.allow_marian:
            if self._marian is None:
                try:
                    self._marian = MarianTranslator(self.models_dir)
                except Exception as exc:  # noqa: BLE001 - offline, no sentencepiece...
                    log.warning("Marian unavailable (%s)", str(exc)[:160] or type(exc).__name__)
                    self.allow_marian = False  # don't retry a load that can't work
            found = self._marian
        with self._lock:
            changed = (getattr(found, "name", None) != getattr(self._current, "name", None))
            self._current, self._best = found, best
            if best:
                self._marian = None  # free its VRAM: the first choice is here
            self._next_check = self._clock() + self.recheck_s
        if changed:
            log.info("translator: %s%s", found.name if found else "none",
                     "" if best else f" (re-checking every {self.recheck_s:.0f}s)")


def build_translator(kind: str | None, *, ollama_url: str = DEFAULT_OLLAMA_URL,
                     ollama_model: str = DEFAULT_OLLAMA_TRANSLATE_MODEL,
                     models_dir: Path | None = None) -> Translator | None:
    """The translator `kind` names, or None for "off".

    "auto" takes the best one that works on this machine — the Ollama chat
    model, then Hy-MT2 in Ollama, then Marian — and settles for none
    (Whisper's own X -> English pass) when nothing does.
    """
    kind = (kind or "off").strip().lower()
    if kind == "off":
        return None
    if kind == "hymt":
        return HyMtTranslator(ollama_url)
    if kind == "marian":
        return MarianTranslator(models_dir)
    if kind == "ollama":
        return OllamaTranslator(ollama_url, ollama_model)
    if kind == "auto":
        for candidate in (OllamaTranslator(ollama_url, ollama_model), HyMtTranslator(ollama_url)):
            if candidate.available():
                return candidate
            log.warning("%s isn't pulled into Ollama at %s", candidate.model, ollama_url)
        try:
            return MarianTranslator(models_dir)
        except Exception as exc:  # noqa: BLE001 - e.g. sentencepiece missing, offline
            log.warning("no translator available (Marian: %s); English lines come "
                        "from Whisper and Arabic lines only when spoken",
                        str(exc)[:160] or type(exc).__name__)
        return None
    raise ValueError(f"unknown translator {kind!r} (choose from {', '.join(TRANSLATOR_KINDS)})")
