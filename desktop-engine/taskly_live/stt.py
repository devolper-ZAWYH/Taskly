"""faster-whisper STT pipeline: transcribe (auto-language) + translate both ways.

Per final utterance, as planned (plan §3, engine STT box):
  1. task=transcribe with language auto-detect -> (lang, text);
  2. the other app language: with a `Translator` (translate.py) the line is
     translated Arabic -> English or English -> Arabic and Whisper's own
     translate pass is skipped; without one, task=translate -> text_en
     (skipped when the utterance is already English) and `text_ar` is only
     the spoken text of an Arabic line. A failed translation leaves its slot
     empty; the line itself always goes through.

Decode parameters favour conversational latency: beam_size=1, no
conditioning on previous text. The model is shared across a thread pool;
CTranslate2 supports concurrent generation, so per-source pipelines overlap
(translate of utterance N runs beside transcribe of utterance N+1).

Backend selection: CUDA is used only when it actually works — CTranslate2
counts CUDA devices even when the cuBLAS/cuDNN runtime DLLs are missing,
so the GPU choice is validated with a tiny warm-up decode and falls back
to CPU + int8. The CUDA runtime comes from pip wheels in the venv
(gpu.py); without them the fallback fires.

Model cache: weights download once into `<data_dir>/models` (`download_root`,
gitignored, offline afterwards). HuggingFace is contacted for that one-time
fetch only; meeting audio never leaves the machine.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .translate import Translator, bilingual

log = logging.getLogger(__name__)

# Whisper occasionally hallucinates stock phrases on (near-)silent tails.
_HALLUCINATIONS = {
    "",
    ".",
    "you",
    "thank you.",
    "thanks.",
    "thank you very much.",
    "thanks for watching!",
    "thank you for watching!",
    "bye.",
    "-",
    "...",
    "so",
    "foreign",
    "[applause]",
}
_MIN_AUDIBLE_S = 0.20

# 0.5 s of true silence: enough to force a full encoder/decoder pass.
_WARMUP_PCM = np.zeros(8000, dtype=np.float32)


@dataclass(frozen=True)
class Transcript:
    """Result of one utterance decode pair."""

    text: str
    lang: str | None
    text_en: str | None
    transcribe_s: float
    translate_s: float | None = None
    text_ar: str | None = None

    @property
    def total_s(self) -> float:
        return self.transcribe_s + (self.translate_s or 0.0)


def _warmup_decode(model) -> None:
    """Force one decode so backend problems surface at load time."""
    for _ in model.transcribe(_WARMUP_PCM, task="transcribe", language=None,
                              beam_size=1, condition_on_previous_text=False):
        break  # silent audio yields nothing; the pass itself is the test


class SttPipeline:
    """Wraps one faster-whisper model; thread-safe for concurrent decodes."""

    def __init__(
        self,
        model: str = "small",
        *,
        download_root: Path | None = None,
        language: str | None = None,
        device: str | None = None,
        compute_type: str | None = None,
        translator: "Translator | None" = None,
    ) -> None:
        self._language = language
        self.translator = translator
        self.model_name = model
        self._model, self.device, self.compute_type = self._load_model(
            model, device, compute_type, download_root, language
        )
        log.info(
            "SttPipeline: ready (lang=%s, translator=%s)",
            self._language if self._language else "auto",
            translator.name if translator else "whisper",
        )

    # ---- model loading ------------------------------------------------------
    @staticmethod
    def _load_model(
        model: str,
        device: str | None,
        compute_type: str | None,
        download_root: Path | None,
        language: str | None,
    ):
        """Build and validate WhisperModel; falls back CPU on a dead GPU.

        CTranslate2 reports CUDA devices even when the cuBLAS/cuDNN runtime
        is absent, so an auto-picked "cuda" is validated with a warm-up
        decode; any failure retries with CPU + int8.
        """
        from .gpu import add_nvidia_dll_dirs

        add_nvidia_dll_dirs()  # the venv's cuBLAS/cuDNN wheels (Windows)
        import ctranslate2
        from faster_whisper import WhisperModel

        auto = device is None or str(device).strip().lower() in ("", "auto")
        attempts: list[tuple[str, str]] = []
        if auto and ctranslate2.get_cuda_device_count() > 0:
            attempts.append(("cuda", compute_type or "int8_float16"))
        attempts.append((device or "cpu", compute_type or "int8"))

        download_kwargs: dict[str, Any] = {}
        if download_root is not None:
            Path(download_root).mkdir(parents=True, exist_ok=True)
            download_kwargs["download_root"] = str(download_root)

        last_exc: Exception | None = None
        for dev, ct in attempts:
            tag = f"model={model!r} device={dev} compute_type={ct}"
            try:
                model_obj = WhisperModel(model, device=dev, compute_type=ct,
                                         **download_kwargs)
                _warmup_decode(model_obj)
                log.info("SttPipeline: using %s (lang=%s)", tag,
                         language or "auto")
                return model_obj, dev, ct
            except Exception as exc:  # noqa: BLE001 - fallback ladder
                last_exc = exc
                log.warning("SttPipeline: %s unusable (%s); trying next option",
                            tag, str(exc).splitlines()[0][:160])
        raise RuntimeError(
            f"could not initialise WhisperModel({model!r}): {last_exc}"
        )

    # ---- decode one utterance ---------------------------------------------
    def transcribe(self, pcm: np.ndarray) -> Transcript | None:
        """Full transcribe(+translate) pass for one utterance.

        Returns None when nothing usable was recognised (silence or a known
        stock phrase hallucination) — the caller should NOT journal those.
        """
        t0 = time.perf_counter()
        text, lang = self._decode(pcm, task="transcribe")
        transcribe_s = time.perf_counter() - t0
        text = text.strip()
        if self._is_noise(text, pcm):
            return None
        # Contract: lang must be "ar" | "en" | null. Whisper can detect other
        # languages (misfires happen on clean TTS/synthetic audio); clamp to
        # null so segments always satisfy the wire format.
        if lang is not None and lang not in ("ar", "en"):
            log.warning("detected lang %r not in contract (ar|en); sending null", lang)
            lang = None
        if self.translator is not None:
            return self._with_translator(pcm, text, lang, transcribe_s)
        text_en = text
        translate_s = None
        if self._language is None and lang != "en":
            t1 = time.perf_counter()
            text_en_raw, _ = self._decode(pcm, task="translate")
            text_en_raw = text_en_raw.strip()
            translate_s = time.perf_counter() - t1
            # Prefer the translate output when it produced usable text.
            if text_en_raw and not self._is_noise(text_en_raw, pcm, quiet=True):
                text_en = text_en_raw
        else:
            text_en = text  # already English (or forced en): no second decode
        return Transcript(
            text=text, lang=lang, text_en=text_en or None,
            transcribe_s=transcribe_s, translate_s=translate_s,
            text_ar=text if lang == "ar" else None,
        )

    def _with_translator(self, pcm: np.ndarray, text: str, lang: str | None,
                         transcribe_s: float) -> Transcript:
        """The other language from the translator, never from Whisper —
        except a line of unknown language, which still needs an English
        pivot from Whisper's translate pass to reach Arabic."""
        assert self.translator is not None
        pivot_s = 0.0
        pivot = None
        if lang is None:
            t1 = time.perf_counter()
            raw, _ = self._decode(pcm, task="translate")
            raw = raw.strip()
            pivot_s = time.perf_counter() - t1
            if raw and not self._is_noise(raw, pcm, quiet=True):
                pivot = raw
        text_en, text_ar, translate_s = bilingual(text, lang, self.translator,
                                                  text_en=pivot)
        return Transcript(
            text=text, lang=lang, text_en=text_en, text_ar=text_ar,
            transcribe_s=transcribe_s,
            translate_s=(translate_s or 0.0) + pivot_s if (translate_s or pivot_s) else None,
        )

    # ---- helpers ------------------------------------------------------------
    def _decode(self, pcm: np.ndarray, *, task: str) -> tuple[str, str | None]:
        segments, info = self._model.transcribe(
            pcm,
            task=task,
            language=self._language,
            beam_size=1,
            condition_on_previous_text=False,
            vad_filter=False,  # our Segmenter already did the slicing
        )
        parts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
        return " ".join(parts), info.language

    @staticmethod
    def _is_noise(text: str, pcm: np.ndarray, *, quiet: bool = False) -> bool:
        """Empty output, or a stock hallucination on a short/near-empty clip."""
        if not text:
            return True
        norm = text.strip().lower().rstrip(".!?").strip()
        known = {h.strip().lower().rstrip(".!?").strip() for h in _HALLUCINATIONS}
        duration = len(pcm) / 16000.0
        if norm in known and (quiet or duration < 1.5):
            return True
        # Rows of dots/dashes produced by mid-word decodes.
        if len(set(norm)) <= 1 and norm[:1] in (".", "-", "…"):
            return True
        return False

    @property
    def language(self) -> str | None:
        return self._language
