"""HTTP client for the Taskly live-capture API contract.

Contract (plan-live-meetings §3/§5; engine scope):

    POST /api/live/sessions          {"meeting_title", "meeting_date"}
        -> 200 {"session": {"id", "status": "capturing", ...}}
    POST /api/live/push              {"session_id", "segments": [
                                        {"seq": int>=1, "source": "mic"|"system",
                                         "lang": "ar"|"en"|null, "text": str,
                                         "text_en": str|null,
                                         "text_ar": str|null,
                                         "started_at": int ms|null,
                                         "ended_at": int ms|null}]}
        -> 200 {"accepted": n, "last_seq": k}   (idempotent by (session_id, seq))
    POST /api/live/sessions/{id}/end -> 200 {"session": {..., "status": "reviewing"}}
    POST /api/live/sessions/{id}/draft {"sections": {"summary", "decisions",
                                        "follow_ups"}, "action_items": [...]}
        -> 200 {"draft": {...}}   (only while 'reviewing'; replaces the last one)

Auth on every /api/live request: ``Authorization: Bearer <raw device token>``
(the server stores only the SHA-256 of it). Idempotent pushes are safe to
retry; duplicate (session_id, seq) rows are ignored server-side.

PRIhasVITY: only text payloads are ever sent — audio bytes never leave the PC.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import requests

log = logging.getLogger(__name__)

SOURCE_MIC = "mic"
SOURCE_SYSTEM = "system"
SOURCES = (SOURCE_MIC, SOURCE_SYSTEM)

PUSH_PATH = "/api/live/push"
SESSIONS_PATH = "/api/live/sessions"


class ApiError(Exception):
    """HTTP or network failure. ``status is None`` means network-level."""

    def __init__(self, status: int | None, message: str):
        super().__init__(message)
        self.status = status
        self.message = message

    @property
    def retryable(self) -> bool:
        """True for network errors, server errors and 429 rate limits."""
        if self.status is None:  # timeout, connection reset, DNS, ...
            return True
        return self.status >= 500 or self.status == 429

    @property
    def fatal(self) -> bool:
        """True when retrying can never succeed (bad token, bad payload)."""
        if self.status is None:
            return False
        return 400 <= self.status < 500 and self.status != 429


@dataclass(frozen=True)
class Segment:
    """One utterance to deliver to Taskly (text-only)."""

    seq: int
    source: str
    lang: str | None
    text: str
    text_en: str | None
    started_ms: int | None
    ended_ms: int | None
    text_ar: str | None = None

    def to_api(self) -> dict:
        """Wire shape per contract (started_at/ended_at are int ms or null)."""
        return {
            "seq": self.seq,
            "source": self.source,
            "lang": self.lang,
            "text": self.text,
            "text_en": self.text_en,
            "text_ar": self.text_ar,
            "started_at": self.started_ms,
            "ended_at": self.ended_ms,
        }


@dataclass(frozen=True)
class PushOutcome:
    """Server-acknowledged push result."""

    accepted: int
    last_seq: int
    status: int


class LiveClient:
    """Small, dependency-light client bound to one device token."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 10.0,
        batch_limit: int = 200,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = float(timeout)
        self._batch_limit = int(batch_limit)
        self._http = requests.Session()
        self._http.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "taskly-live-engine/0.1",
            }
        )

    @property
    def base_url(self) -> str:
        return self._base

    # ---- API surface ----------------------------------------------------
    def create_session(self, meeting_title: str, meeting_date: str,
                       meeting_id: str | None = None) -> dict:
        """Start a capturing session; returns the server's session object.

        With ``meeting_id`` the recording belongs to that Taskly meeting (the
        server copies its title and date): only then does its review card
        appear in the meeting's panel. Without one it is a private rehearsal.
        """
        body = {"meeting_title": meeting_title, "meeting_date": meeting_date}
        if meeting_id:
            body["meeting_id"] = meeting_id
        data = self._post_json(SESSIONS_PATH, body)
        session = data.get("session")
        if not isinstance(session, dict) or not session.get("id"):
            raise ApiError(200, f"Malformed session response: {data!r}")
        return session

    def push(self, session_id: str, segments: list[Segment]) -> PushOutcome:
        """Push a batch (<=200 segments); server dedupes by (session_id, seq)."""
        if not 1 <= len(segments) <= self._batch_limit:
            raise ValueError(
                f"push() expects 1..{self._batch_limit} segments, got {len(segments)}"
            )
        body = {
            "session_id": session_id,
            "segments": [seg.to_api() for seg in segments],
        }
        data = self._post_json(PUSH_PATH, body)
        return PushOutcome(
            accepted=int(data.get("accepted", 0)),
            last_seq=int(data.get("last_seq", 0)),
            status=200,
        )

    def end_session(self, session_id: str) -> dict:
        """Finish capture -> server moves the session to 'reviewing'."""
        return self._post_json(f"{SESSIONS_PATH}/{session_id}/end", {})

    def post_draft(self, session_id: str, draft: dict, *, timeout: float = 30.0) -> dict:
        """The on-device summary -> the session's review draft (ended sessions only)."""
        data = self._post_json(f"{SESSIONS_PATH}/{session_id}/draft", draft, timeout=timeout)
        posted = data.get("draft")
        if not isinstance(posted, dict) or not posted.get("id"):
            raise ApiError(200, "Malformed draft response")
        return posted

    def close(self) -> None:
        self._http.close()

    # ---- internals --------------------------------------------------------
    def _post_json(self, path: str, payload: dict, *, timeout: float | None = None) -> dict:
        url = f"{self._base}{path}"
        try:
            resp = self._http.post(url, json=payload, timeout=timeout or self._timeout)
        except requests.RequestException as exc:
            raise ApiError(None, f"network error on POST {path}: {exc}") from exc
        if resp.status_code >= 400:
            body = (resp.text or "")[:300]
            raise ApiError(
                resp.status_code, f"POST {path} -> HTTP {resp.status_code}: {body}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise ApiError(resp.status_code, f"non-JSON response from {path}") from exc
