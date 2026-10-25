"""TEST-ONLY stand-in for the Taskly server implementing the /api/live contract.

Built on the stdlib ``http.server`` against in-memory state (optionally
persisted to a JSON file so a mock can be restarted without losing segments).
Clearly marked test-only:

  * accepts ANY non-empty bearer token (no hashing/unlinkability),
  * no rate limits, quotas or durability guarantees,
  * never use this for real meetings.

Wire behavior mirrors the real contract so the engine is exercised against
exactly the shapes it will meet in production:

    POST /api/live/sessions          -> 200 {"session": {..., "status": "capturing"}}
    POST /api/live/push              -> 200 {"accepted": n, "last_seq": k}
                                        404 unknown session, 400 bad batch,
                                        401 bad auth; duplicates by
                                        (session_id, seq) are IGNORED.
    POST /api/live/sessions/{id}/end -> 200 {"session": {..., "status": "reviewing"}}
    POST /api/live/sessions/{id}/draft -> 200 {"draft": {...}} while 'reviewing'
                                        (replaces the last one), else 404
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BATCH_LIMIT = 200
_SESSION_END_PATH = re.compile(r"^/api/live/sessions/(?P<sid>[^/]+)/end$")
_SESSION_DRAFT_PATH = re.compile(r"^/api/live/sessions/(?P<sid>[^/]+)/draft$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class MockState:
    """In-memory store of sessions and delivered segments."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: dict[str, dict] = {}
        # Delivery trace for tests: sequence of (method, session_id, seqs)
        self.arrival: list[tuple[str, str, int]] = []
        # Fault injection: list of (status, remaining_count) consumed by pushes.
        self.fail_next: list[tuple[int, int]] = []

    def save(self, path: Path | None) -> None:
        if path is None:
            return
        payload = {
            "sessions": self.sessions,
            "arrival": [list(item) for item in self.arrival],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path | None) -> "MockState":
        state = cls()
        if path is not None and path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            state.sessions = {sid: sess for sid, sess in data.get("sessions", {}).items()}
            state.arrival = [tuple(item) for item in data.get("arrival", [])]  # type: ignore[misc]
        return state

    def new_session(self, title: str, date: str) -> dict:
        sid = "mock-" + uuid.uuid4().hex[:16]
        session = {
            "id": sid,
            "meeting_title": title,
            "meeting_date": date,
            "status": "capturing",
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ended_at": None,
            "segments": {},
            "last_seq": 0,
        }
        self.sessions[sid] = session
        return session

    def push(self, sid: str, segments: list[dict]) -> tuple[int, int]:
        """Insert non-duplicate segments; returns (accepted, last_seq)."""
        session = self.sessions[sid]
        accepted = 0
        for seg in segments:
            seq = int(seg["seq"])
            self.arrival.append(("push", sid, seq))  # every receipt, for audits
            if seq in session["segments"]:
                continue  # duplicate by (session_id, seq): ignored
            session["segments"][seq] = seg
            accepted += 1
        session["last_seq"] = max(session["segments"].keys(), default=0)
        return accepted, session["last_seq"]

    def pop_failure(self) -> int | None:
        for i, (status, remaining) in enumerate(self.fail_next):
            if remaining <= 1:
                del self.fail_next[i]
            else:
                self.fail_next[i] = (status, remaining - 1)
            return status
        return None


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Per-instance bound below (two mocks may share a process).
    state: MockState
    store_path: Path | None

    # ---- plumbing -------------------------------------------------------
    def log_message(self, fmt: str, *args: object) -> None:  # quiet by default
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return header.startswith("Bearer ") and len(header) > len("Bearer ")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _HttpError(400, f"bad JSON body: {exc}") from exc
        if not isinstance(data, dict):
            raise _HttpError(400, "body must be a JSON object")
        return data

    # ---- routes ---------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        if self.path.rstrip("/") in ("/health", "/api/live/health"):
            self._send(200, {"ok": True, "sessions": len(self.state.sessions)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._authorized():
                raise _HttpError(401, "missing or malformed bearer token")
            path = self.path.split("?", 1)[0].rstrip("/") or self.path
            if path == "/api/live/sessions":
                self._handle_create()
            elif path == "/api/live/push":
                self._handle_push()
            elif match := _SESSION_END_PATH.match(path):
                self._handle_end(match.group("sid"))
            elif match := _SESSION_DRAFT_PATH.match(path):
                self._handle_draft(match.group("sid"))
            else:
                raise _HttpError(404, f"no route for {path}")
        except _HttpError as exc:
            self._send(exc.status, {"error": exc.message})
        except Exception as exc:  # surface mock bugs loudly
            self._send(500, {"error": f"mock error: {exc!r}"})
        self.state.save(self.store_path)

    def _handle_create(self) -> None:
        body = self._body()
        title = body.get("meeting_title")
        date = body.get("meeting_date")
        if not isinstance(title, str) or not title.strip():
            raise _HttpError(400, "meeting_title must be a non-empty string")
        if not isinstance(date, str) or not _DATE_RE.match(date):
            raise _HttpError(400, "meeting_date must look like YYYY-MM-DD")
        session = self.state.new_session(title.strip(), date)
        # The claim is only remembered (the mock has no meetings to check it against).
        meeting_id = body.get("meeting_id")
        if meeting_id is not None and (not isinstance(meeting_id, str) or not meeting_id):
            raise _HttpError(400, "meeting_id must be a non-empty string")
        session["meetingId"] = meeting_id
        self._send(200, {"session": session})

    def _handle_push(self) -> None:
        body = self._body()
        sid = body.get("session_id")
        segments = body.get("segments")
        with self.state.lock:
            injection = self.state.pop_failure()
        if injection is not None:
            raise _HttpError(injection, "injected failure (fault injection)")
        if not isinstance(sid, str) or not sid:
            raise _HttpError(400, "session_id must be a string")
        with self.state.lock:
            session = self.state.sessions.get(sid)
            if session is None:
                raise _HttpError(404, f"unknown session_id {sid!r}")
        if not isinstance(segments, list) or not segments:
            raise _HttpError(400, "segments must be a non-empty list")
        if len(segments) > BATCH_LIMIT:
            raise _HttpError(400, f"too many segments ({len(segments)} > {BATCH_LIMIT})")
        cleaned: list[dict] = []
        for seg in segments:
            cleaned.append(self._validate_segment(seg))
        with self.state.lock:
            accepted, last_seq = self.state.push(sid, cleaned)
        self._send(200, {"accepted": accepted, "last_seq": last_seq})

    @staticmethod
    def _validate_segment(seg: object) -> dict:
        if not isinstance(seg, dict):
            raise _HttpError(400, "each segment must be an object")
        seq = seg.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
            raise _HttpError(400, f"segment seq must be an int >= 1, got {seq!r}")
        source = seg.get("source")
        if source not in ("mic", "system"):
            raise _HttpError(400, f"segment source must be mic|system, got {source!r}")
        text = seg.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _HttpError(400, "segment text must be a non-empty string")
        lang = seg.get("lang")
        if lang is not None and lang not in ("ar", "en"):
            raise _HttpError(400, f"segment lang must be ar|en|null, got {lang!r}")
        text_en = seg.get("text_en")
        if text_en is not None and not isinstance(text_en, str):
            raise _HttpError(400, "segment text_en must be a string or null")
        text_ar = seg.get("text_ar")
        if text_ar is not None and (not isinstance(text_ar, str) or len(text_ar) > 4000):
            raise _HttpError(400, "segment text_ar must be a string of at most 4000 chars or null")
        for key in ("started_at", "ended_at"):
            value = seg.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
                raise _HttpError(400, f"segment {key} must be a non-negative int or null")
        return {key: seg.get(key) for key in
                ("seq", "source", "lang", "text", "text_en", "text_ar", "started_at",
                 "ended_at")}

    def _handle_end(self, sid: str) -> None:
        # Read the (empty) body even though it's unused: on a kept-alive
        # connection, unread bytes would be taken for the next request line.
        self._body()
        with self.state.lock:
            session = self.state.sessions.get(sid)
            if session is None:
                raise _HttpError(404, f"unknown session_id {sid!r}")
            session["status"] = "reviewing"
            session["ended_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._send(200, {"session": session})

    def _handle_draft(self, sid: str) -> None:
        body = self._body()
        sections = body.get("sections")
        items = body.get("action_items")
        if not isinstance(sections, dict) or not isinstance(sections.get("summary"), str):
            raise _HttpError(400, "sections.summary must be a string")
        if not isinstance(items, list) or len(items) > 30:
            raise _HttpError(400, "action_items must be a list of at most 30")
        for key in ("decisions", "follow_ups"):
            lines = sections.get(key, [])
            if not isinstance(lines, list) or len(lines) > 25 or any(
                not isinstance(line, str) or not line.strip() or len(line) > 500 for line in lines
            ):
                raise _HttpError(400, f"sections.{key} must be up to 25 non-blank lines")
        with self.state.lock:
            session = self.state.sessions.get(sid)
            # Like the real server: only an ended, not yet reviewed session takes one.
            if session is None or session.get("status") != "reviewing":
                raise _HttpError(404, f"no session in review {sid!r}")
            draft = {
                "id": f"ldraft-{uuid.uuid4()}",
                "sessionId": sid,
                "sections": {
                    "summary": sections["summary"],
                    "decisions": sections.get("decisions", []),
                    "followUps": sections.get("follow_ups", []),
                },
                "actionItems": items,
            }
            session["draft"] = draft
        self._send(200, {"draft": draft})


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        """Swallow routine client disconnects (keep unexpected ones visible)."""
        import sys
        exc = sys.exception()
        from http.server import HTTPServer
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return
        HTTPServer.handle_error(self, request, client_address)


class _HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class MockServer:
    """Context-managed wrapper; ``port=0`` binds an ephemeral port."""

    def __init__(
        self,
        port: int = 3199,
        *,
        state_path: Path | None = None,
    ) -> None:
        self.state = MockState.load(state_path)
        handler_cls = type(
            "_BoundHandler", (_Handler,),
            {"state": self.state, "store_path": state_path},
        )
        self.httpd = _QuietServer(("127.0.0.1", port), handler_cls)
        self.port = self.httpd.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "MockServer":
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, name="mock-taskly", daemon=True
        )
        self.thread.start()
        return self

    @classmethod
    def with_ephemeral(cls, state_path: Path | None = None) -> "MockServer":
        server = cls(port=0, state_path=state_path).start()
        return server

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self) -> "MockServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()
