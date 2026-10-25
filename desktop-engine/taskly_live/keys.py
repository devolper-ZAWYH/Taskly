"""API keys for the shared model server: one key per platform, revocable alone.

The PC serves several platforms at once (Taskly laptops, other apps, scripts).
A single shared secret means rotating it for one of them breaks all of them and
says nothing about who is using the GPU. So each platform gets its own key with
a name, and the store keeps what the operator needs to manage them:

    - only the SHA-256 digest of a key is ever written down, so the key file
      leaking (backup, screenshot, a cloud-synced data dir) does not leak keys;
      the raw key is shown once, by `add`, and is unrecoverable afterwards;
    - revoking a key stops it at once without touching the others, and the
      entry stays (revoked) so the usage history survives and the name can be
      issued again later;
    - a per-key concurrency override and usage counters (requests, audio
      seconds, tokens) so one chatty platform can be limited and seen.

The key file is JSON, `{"version": 1, "keys": [{name, hash, created, last_used,
revoked, concurrency, usage}]}`, replaced atomically on every change so a crash
never leaves half a file. Key creation and revocation reach the disk
immediately; `last_used` and usage change on every request, so those are only
flushed at most every `flush_interval_s` (and on `flush()` / `close()`) instead
of rewriting the file per request. A crash loses at most that window of
counters, never a key.

A file that exists but can't be parsed raises `KeyStoreError` rather than being
treated as empty: silently starting from nothing would drop every platform's
key on the next write. Nothing here logs a raw key or a hash, only names and
counts.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

KEY_PREFIX = "tsk_"
FILE_VERSION = 1
DEFAULT_FLUSH_INTERVAL_S = 10.0
# Lowercase and filename-safe: names go into logs, URLs and CLI arguments.
NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9\-_.]{0,63}")


class KeyStoreError(RuntimeError):
    """The key file is unreadable or malformed (and was left untouched)."""


@dataclass(frozen=True)
class Usage:
    requests: int = 0
    audio_seconds: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass(frozen=True)
class KeyInfo:
    """A snapshot of one key's record. Never holds the raw key or its hash."""

    name: str
    created: str
    last_used: str | None
    revoked: str | None
    concurrency: int | None
    usage: Usage

    @property
    def active(self) -> bool:
        return self.revoked is None


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _check_name(name: object) -> str:
    if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
        raise ValueError(
            "key name must be 1-64 characters: lowercase letters, digits, '-', '_' or '.', "
            "starting with a letter or digit"
        )
    return name


def _check_concurrency(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("concurrency must be a positive integer or None")
    return value


class _Entry:
    """The mutable record behind a KeyInfo; only touched under the store's lock."""

    __slots__ = ("name", "hash", "created", "last_used", "revoked", "concurrency",
                 "requests", "audio_seconds", "prompt_tokens", "completion_tokens")

    def __init__(self, name: str, hash_: str, created: str, *, last_used: str | None = None,
                 revoked: str | None = None, concurrency: int | None = None,
                 requests: int = 0, audio_seconds: float = 0.0, prompt_tokens: int = 0,
                 completion_tokens: int = 0) -> None:
        self.name = name
        self.hash = hash_
        self.created = created
        self.last_used = last_used
        self.revoked = revoked
        self.concurrency = concurrency
        self.requests = requests
        self.audio_seconds = audio_seconds
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens

    def info(self) -> KeyInfo:
        return KeyInfo(
            name=self.name, created=self.created, last_used=self.last_used,
            revoked=self.revoked, concurrency=self.concurrency,
            usage=Usage(self.requests, self.audio_seconds, self.prompt_tokens,
                        self.completion_tokens),
        )

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "hash": self.hash,
            "created": self.created,
            "last_used": self.last_used,
            "revoked": self.revoked,
            "concurrency": self.concurrency,
            "usage": {
                "requests": self.requests,
                "audio_seconds": self.audio_seconds,
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
            },
        }

    @classmethod
    def from_json(cls, data: object) -> "_Entry":
        if not isinstance(data, dict):
            raise ValueError("key entry is not an object")
        usage = data.get("usage") or {}
        if not isinstance(usage, dict):
            raise ValueError("usage is not an object")
        hash_ = data.get("hash")
        if not isinstance(hash_, str) or not hash_:
            raise ValueError("key entry has no hash")
        created = data.get("created")
        if not isinstance(created, str):
            raise ValueError("key entry has no created time")
        for field in ("last_used", "revoked"):
            if data.get(field) is not None and not isinstance(data[field], str):
                raise ValueError(f"{field} is not a timestamp")
        return cls(
            _check_name(data.get("name")), hash_, created,
            last_used=data.get("last_used"), revoked=data.get("revoked"),
            concurrency=_check_concurrency(data.get("concurrency")),
            requests=int(usage.get("requests", 0)),
            audio_seconds=float(usage.get("audio_seconds", 0.0)),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
        )


class KeyStore:
    """Thread-safe named API keys, persisted as JSON (or held in memory).

    `clock` (monotonic seconds) paces the throttled flush and `utcnow` stamps
    created / last_used / revoked; both are injectable for tests.
    """

    def __init__(self, path: Path | str | None, *,
                 flush_interval_s: float = DEFAULT_FLUSH_INTERVAL_S,
                 clock: Callable[[], float] = time.monotonic,
                 utcnow: Callable[[], datetime] | None = None) -> None:
        self.path = Path(path) if path is not None else None
        self.flush_interval_s = float(flush_interval_s)
        self._clock = clock
        self._utcnow = utcnow or (lambda: datetime.now(timezone.utc))
        self._lock = threading.RLock()
        self._entries: list[_Entry] = []
        self._dirty = False
        self._last_flush = self._clock()
        self._seen_mtime: tuple[int, int] | None = None  # the file as we last read or wrote it
        self._next_refresh = 0.0
        self._load()

    @classmethod
    def in_memory(cls, raw_key: str, name: str = "default") -> "KeyStore":
        """A fileless store holding one key, for tests and single-key setups."""
        store = cls(None)
        store.import_legacy(raw_key, name)
        return store

    # ---- persistence ------------------------------------------------------------
    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("keys"), list):
                raise ValueError("expected an object with a 'keys' list")
            if data.get("version", FILE_VERSION) != FILE_VERSION:
                raise ValueError(f"unsupported version {data.get('version')!r}")
            entries = [_Entry.from_json(item) for item in data["keys"]]
            active = [e.name for e in entries if e.revoked is None]
            if len(active) != len(set(active)):
                raise ValueError("two active keys share a name")
        except (OSError, ValueError, TypeError) as exc:
            # Don't fall back to an empty store: the next write would wipe the keys.
            raise KeyStoreError(
                f"can't read the key file {self.path} ({exc}); fix or move it aside"
            ) from exc
        self._entries = entries
        self._seen_mtime = self._mtime()
        log.info("loaded %d API key(s), %d active", len(entries),
                 sum(1 for e in entries if e.revoked is None))

    # Two processes share the file: the running server (which flushes usage
    # counters) and `serve keys add|revoke`. Every write merges what's on disk
    # first, and the server re-reads the file when it changes, so a key added
    # or revoked from the CLI takes effect within seconds and is never lost.
    def _mtime(self) -> tuple[int, int] | None:
        """The file's identity for change checks: (mtime in ns, size). Two
        writes inside one timestamp tick still differ in size (a revoke stamp,
        a new entry)."""
        try:
            st = self.path.stat() if self.path is not None else None
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size) if st is not None else None

    def _merge_from_disk(self) -> None:
        """Fold the file's entries into ours (caller holds the lock).

        New keys are added; a revoke on either side wins; counters and
        last_used take the larger value (only the server counts, so the
        larger is the newer).
        """
        if self.path is None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            theirs = [_Entry.from_json(item) for item in data["keys"]]
        except (OSError, ValueError, TypeError, KeyError) as exc:
            log.warning("key file unreadable while merging (%s); keeping ours", type(exc).__name__)
            return
        mine = {e.hash: e for e in self._entries}
        for other in theirs:
            entry = mine.get(other.hash)
            if entry is None:
                self._entries.append(other)
                continue
            entry.revoked = entry.revoked or other.revoked
            if (other.last_used or "") > (entry.last_used or ""):
                entry.last_used = other.last_used
            entry.requests = max(entry.requests, other.requests)
            entry.audio_seconds = max(entry.audio_seconds, other.audio_seconds)
            entry.prompt_tokens = max(entry.prompt_tokens, other.prompt_tokens)
            entry.completion_tokens = max(entry.completion_tokens, other.completion_tokens)
        self._seen_mtime = self._mtime()

    def refresh(self, *, every_s: float = 2.0) -> None:
        """Pick up keys added or revoked by another process (cheap: one stat
        at most every `every_s`)."""
        if self.path is None:
            return
        with self._lock:
            now = self._clock()
            if now < self._next_refresh:
                return
            self._next_refresh = now + every_s
            if self._mtime() != self._seen_mtime:
                self._merge_from_disk()

    def _write(self) -> None:
        """Replace the file atomically (caller holds the lock)."""
        self._dirty = False
        self._last_flush = self._clock()
        if self.path is None:
            return
        self._merge_from_disk()  # never overwrite another process's add/revoke
        payload = {"version": FILE_VERSION, "keys": [e.to_json() for e in self._entries]}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        if os.name == "posix":
            os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
        self._seen_mtime = self._mtime()

    def flush(self) -> None:
        """Write pending counters now."""
        with self._lock:
            if self._dirty:
                self._write()

    def close(self) -> None:
        self.flush()

    def __enter__(self) -> "KeyStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _touch(self) -> None:
        """Note an in-memory change; write it if the last write is old enough."""
        self._dirty = True
        if self._clock() - self._last_flush >= self.flush_interval_s:
            self._write()

    def _stamp(self) -> str:
        return self._utcnow().astimezone(timezone.utc).isoformat(timespec="seconds")

    # ---- managing keys ----------------------------------------------------------
    def _active(self, name: str) -> _Entry | None:
        return next((e for e in self._entries if e.name == name and e.revoked is None), None)

    def _insert(self, name: str, raw: str, concurrency: int | None) -> None:
        self._entries.append(_Entry(name, _digest(raw), self._stamp(), concurrency=concurrency))
        self._write()  # a new key must be on disk before anyone is handed it
        log.info("API key %r added", name)

    def add(self, name: str, *, concurrency: int | None = None) -> str:
        """Make a key for `name` and return it; this is the only time it is visible."""
        _check_name(name)
        concurrency = _check_concurrency(concurrency)
        raw = KEY_PREFIX + secrets.token_urlsafe(32)
        with self._lock:
            if self._active(name) is not None:
                raise ValueError(f"an active key named {name!r} already exists")
            self._insert(name, raw, concurrency)
        return raw

    def revoke(self, name: str) -> bool:
        with self._lock:
            entry = self._active(name)
            if entry is None:
                return False
            entry.revoked = self._stamp()
            self._write()
        log.info("API key %r revoked", name)
        return True

    def list(self) -> list[KeyInfo]:
        with self._lock:
            return [e.info() for e in self._entries]

    def import_legacy(self, raw_key: str, name: str = "taskly-laptops") -> bool:
        """Adopt an existing raw key (the old `model-server.key`) under `name`.

        Idempotent: if that key's hash is already in the store (active or
        revoked, so a revoked legacy key stays revoked) nothing is added and the
        result is False. A different active key already using `name` raises.
        """
        raw_key = raw_key.strip()
        if not raw_key:
            raise ValueError("legacy key is empty")
        _check_name(name)
        digest = _digest(raw_key)
        with self._lock:
            if any(hmac.compare_digest(e.hash, digest) for e in self._entries):
                return False
            if self._active(name) is not None:
                raise ValueError(f"an active key named {name!r} already exists")
            self._insert(name, raw_key, None)
        return True

    # ---- using keys -------------------------------------------------------------
    def verify(self, raw: str) -> KeyInfo | None:
        """The key's record if `raw` is an active key, else None."""
        if not raw:
            return None
        self.refresh()
        digest = _digest(raw)
        found: _Entry | None = None
        with self._lock:
            for entry in self._entries:
                # Compare every active entry (no early exit) so timing doesn't
                # reveal how far down the list a near miss got.
                if entry.revoked is None and hmac.compare_digest(entry.hash, digest):
                    found = entry
            if found is None:
                return None
            found.last_used = self._stamp()
            self._touch()
            return found.info()

    def record(self, name: str, *, requests: int = 1, audio_seconds: float = 0.0,
               prompt_tokens: int = 0, completion_tokens: int = 0) -> None:
        """Add to the usage counters of the active key `name` (unknown names are ignored)."""
        with self._lock:
            entry = self._active(name)
            if entry is None:
                return
            entry.requests += requests
            entry.audio_seconds += audio_seconds
            entry.prompt_tokens += prompt_tokens
            entry.completion_tokens += completion_tokens
            self._touch()
