"""Engine configuration: environment variables with CLI overrides.

Configurable inputs (per spec):
  TASKLY_URL     base URL of the Taskly app (default http://localhost:3100)
  TASKLY_TOKEN   device token (raw; the server stores only its SHA-256)
  TASKLY_MODEL   Whisper model name (default "small")
  TASKLY_DEVICE  microphone device (index or name substring, default system default)
  TASKLY_OLLAMA_URL      local Ollama for on-device summaries (default http://127.0.0.1:11434)
  TASKLY_SUMMARY_MODEL   Ollama model that writes the review draft (default qwen3.5:4b)
  TASKLY_SUMMARY=0       don't summarize after a recording ends
  TASKLY_MODEL_SERVER       the PC's model server (`serve`): transcribe,
                            translate and summarize there instead of here
  TASKLY_MODEL_SERVER_KEY   that server's key (`serve` prints it)
  TASKLY_SYSTEM_DEVICE      "system" capture device (index or name substring;
                            default: the OS's loopback/monitor, see audio.py)
  TASKLY_TRANSLATOR      off | hymt | marian | ollama | auto (Arabic <-> English per line;
                         `serve` defaults to auto, local capture to off)
  TASKLY_TRANSLATE_MODEL Ollama model for the ollama translator

Anything the CLI passes overrides the environment. Every knob has a safe
default so `python -m taskly_live test` works with zero configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .summarize import DEFAULT_OLLAMA_URL, DEFAULT_SUMMARY_MODEL
from .translate import DEFAULT_OLLAMA_TRANSLATE_MODEL, TRANSLATOR_KINDS

PKG_DIR = Path(__file__).resolve().parent  # .../desktop-engine/taskly_live
DEFAULT_DATA_DIR = PKG_DIR.parent  # .../desktop-engine

DEFAULT_URL = "http://localhost:3100"
DEFAULT_MODEL = "small"
# What `serve` loads on the GPU PC when --model/TASKLY_MODEL isn't given.
DEFAULT_SERVE_MODEL = "large-v3-turbo"
# Segmentation timing (see vad.py)
DEFAULT_GAP_MS = 700
HANGOVER_MS = 600
LOOKBEHIND_MS = 200
MAX_UTTERANCE_MS = 30_000
# Pusher behaviour
DEFAULT_COALESCE_S = 3.0
MAX_BATCH = 200  # API contract: <=200 segments per push call
# Files kept next to the engine (relative to data dir)
JOURNAL_FILENAME = "journal.sqlite3"
STATE_FILENAME = "engine-state.json"
STOP_FLAG_FILENAME = "engine.stop.flag"

LANG_AR = "ar"
LANG_EN = "en"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


@dataclass
class Config:
    """Resolved engine configuration."""

    url: str = DEFAULT_URL
    token: str = ""
    model: str = DEFAULT_MODEL
    device: str | None = None  # mic device index or name substring
    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    gap_ms: int = DEFAULT_GAP_MS
    language: str | None = None  # force transcription language; None = auto
    mic: bool = True
    system: bool = True
    auto_gain: bool = True
    coalesce_s: float = DEFAULT_COALESCE_S
    batch_limit: int = MAX_BATCH
    verbose: bool = False
    # On-device summary after the session ends (summarize.py)
    summary: bool = True
    ollama_url: str = DEFAULT_OLLAMA_URL
    summary_model: str = DEFAULT_SUMMARY_MODEL
    # Laptop -> PC model server (remote.py); empty = everything on this machine
    server: str = ""
    server_key: str = ""
    system_device: str | None = None  # "system" capture override (audio.py)
    # Per-line Arabic <-> English (translate.py); None = the command's default
    translator: str | None = None
    translate_model: str = DEFAULT_OLLAMA_TRANSLATE_MODEL
    model_from_user: bool = False  # --model/TASKLY_MODEL given (serve keeps it)

    # ---- derived paths ------------------------------------------------
    @property
    def journal_path(self) -> Path:
        return self.data_dir / JOURNAL_FILENAME

    @property
    def state_file(self) -> Path:
        return self.data_dir / STATE_FILENAME

    @property
    def stop_flag(self) -> Path:
        return self.data_dir / STOP_FLAG_FILENAME

    @property
    def models_dir(self) -> Path:
        """Local Whisper model cache (HuggingFace hub download target)."""
        return self.data_dir / "models"

    # ---- constructors -------------------------------------------------
    @classmethod
    def from_env(cls) -> "Config":
        """Base config from environment variables only."""
        env = os.environ.get
        return cls(
            server=env("TASKLY_MODEL_SERVER", "").strip(),
            server_key=env("TASKLY_MODEL_SERVER_KEY", "").strip(),
            system_device=env("TASKLY_SYSTEM_DEVICE", "").strip() or None,
            translator=env("TASKLY_TRANSLATOR", "").strip().lower() or None,
            translate_model=env("TASKLY_TRANSLATE_MODEL", "").strip()
            or DEFAULT_OLLAMA_TRANSLATE_MODEL,
            model_from_user=bool(env("TASKLY_MODEL", "").strip()),
            url=os.environ.get("TASKLY_URL", DEFAULT_URL).strip() or DEFAULT_URL,
            token=os.environ.get("TASKLY_TOKEN", "").strip(),
            model=os.environ.get("TASKLY_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            device=(os.environ.get("TASKLY_DEVICE", "").strip() or None),
            data_dir=Path(
                os.environ.get("TASKLY_DATA_DIR", "").strip() or DEFAULT_DATA_DIR
            ).resolve(),
            gap_ms=_env_int("TASKLY_GAP_MS", DEFAULT_GAP_MS),
            language=(os.environ.get("TASKLY_LANGUAGE", "").strip().lower() or None),
            summary=os.environ.get("TASKLY_SUMMARY", "1").strip().lower()
            not in ("0", "false", "no", "off"),
            ollama_url=os.environ.get("TASKLY_OLLAMA_URL", "").strip() or DEFAULT_OLLAMA_URL,
            summary_model=os.environ.get("TASKLY_SUMMARY_MODEL", "").strip()
            or DEFAULT_SUMMARY_MODEL,
        )

    @classmethod
    def build(
        cls,
        args: object,
        *,
        default_token: str = "",
        require_token: bool = True,
    ) -> "Config":
        """Env defaults, then CLI overrides from an argparse namespace."""
        cfg = cls.from_env()
        get = getattr
        url = get(args, "url", None)
        token = get(args, "token", None)
        model = get(args, "model", None)
        device = get(args, "device", None)
        data_dir = get(args, "data_dir", None)
        gap_ms = get(args, "gap_ms", None)
        if url:
            cfg.url = url.strip() or cfg.url
        if token:
            cfg.token = token.strip()
        if model:
            cfg.model = model.strip() or cfg.model
            cfg.model_from_user = True
        if device is not None:
            cfg.device = device
        if data_dir:
            cfg.data_dir = Path(os.path.expandvars(str(data_dir))).expanduser().resolve()
        if gap_ms is not None:
            cfg.gap_ms = int(gap_ms)
        language = get(args, "language", None)
        if language:
            cfg.language = str(language).lower()
        if get(args, "no_mic", False):
            cfg.mic = False
        if get(args, "no_system", False):
            cfg.system = False
        if get(args, "no_auto_gain", False):
            cfg.auto_gain = False
        if get(args, "no_summary", False):
            cfg.summary = False
        ollama_url = get(args, "ollama_url", None)
        if ollama_url:
            cfg.ollama_url = ollama_url.strip().rstrip("/") or cfg.ollama_url
        summary_model = get(args, "summary_model", None)
        if summary_model:
            cfg.summary_model = summary_model.strip() or cfg.summary_model
        server = get(args, "server", None)
        if server:
            cfg.server = server.strip()
        server_key = get(args, "server_key", None)
        if server_key:
            cfg.server_key = server_key.strip()
        system_device = get(args, "system_device", None)
        if system_device:
            cfg.system_device = system_device.strip()
        translator = get(args, "translator", None)
        if translator:
            cfg.translator = translator.strip().lower()
        translate_model = get(args, "translate_model", None)
        if translate_model:
            cfg.translate_model = translate_model.strip() or cfg.translate_model
        cfg.verbose = bool(get(args, "verbose", False))
        cfg.validate(default_token=default_token, require_token=require_token)
        return cfg

    def validate(self, *, default_token: str = "", require_token: bool = True) -> None:
        """Normalise/validate values, raising ValueError on bad input."""
        self.url = self.url.rstrip("/")
        if not self.token:
            self.token = default_token
        if require_token and not self.token:
            raise ValueError(
                "No device token. Set TASKLY_TOKEN or pass --token "
                "(Settings -> Live capture in Taskly shows it once)."
            )
        self.gap_ms = max(150, min(int(self.gap_ms), 5000))
        if self.batch_limit < 1 or self.batch_limit > MAX_BATCH:
            self.batch_limit = MAX_BATCH
        self.coalesce_s = max(0.0, min(float(self.coalesce_s), 30.0))
        if self.language is not None and self.language not in (LANG_AR, LANG_EN):
            raise ValueError("--language must be 'ar' or 'en' (or omitted for auto).")
        if self.server and not self.server_key:
            raise ValueError(
                "--server needs --server-key (or TASKLY_MODEL_SERVER_KEY); "
                "`python -m taskly_live serve` prints it on the PC."
            )
        if self.translator is not None and self.translator not in TRANSLATOR_KINDS:
            raise ValueError(f"--translator must be one of {', '.join(TRANSLATOR_KINDS)}.")
        if not self.mic and not self.system:
            raise ValueError("Both --no-mic and --no-system given: nothing to capture.")
