"""On-device meeting summaries: the transcript -> a review draft, via Ollama.

After a recording ends, the engine asks the local Ollama model for the
meeting's minutes and posts them to Taskly as the session's review draft
(``POST /api/live/sessions/{id}/draft``, docs/live-meetings.md §3). The words
leave the PC only as that draft; the server checks it and shows it on the
recorder's review card.

The prompt is a port of server/summarize/prompt.ts (the server-side providers
use the same one), so a draft reads the same whichever side wrote it. The reply
is parsed defensively and re-capped to the contract's limits: long lists are
cut, blank lines dropped, bad dates left out — only a reply with no summary at
all is a failure.

PRIVACY: logs and errors carry ids, counts and the service's own status only —
never transcript or draft text.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import date as _date
from typing import Iterable, Protocol

import requests

log = logging.getLogger(__name__)

# 127.0.0.1, not localhost: Windows tries IPv6 first and Ollama listens on
# IPv4 only, a ~2 s stall on every request.
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_SUMMARY_MODEL = "qwen3.5:4b"
DEFAULT_TIMEOUT_S = 300.0

# The transcript caps the prompt works within (server/summarize/prompt.ts).
MAX_SUMMARY_SEGMENTS = 5_000
MAX_TRANSCRIPT_CHARS = 60_000

# The draft contract's caps (server/live/drafts.ts), in UTF-16 units like the
# server's string lengths.
MAX_SUMMARY = 20_000
MAX_SECTION_ITEMS = 25
MAX_SECTION_LINE = 500
MAX_ACTION_ITEMS = 30
MAX_TITLE = 200
MAX_ASSIGNEE = 100

_SPEAKER = {"mic": "Me", "system": "Them"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```")
_THINK_RE = re.compile(r"<[^>]*think[^>]*>[\s\S]*?<[^>]*/think[^>]*>")


class SummaryError(Exception):
    """The summary couldn't be made. The message never quotes the transcript."""


class TranscriptLine(Protocol):
    """What one prompt block needs (a journal row has all of it)."""

    source: str
    lang: str | None
    text: str
    text_en: str | None


# ---- the prompt (port of server/summarize/prompt.ts) ----------------------------


def _is_english(lang: str | None) -> bool:
    return isinstance(lang, str) and lang.lower().startswith("en")


def render_transcript(lines: Iterable[TranscriptLine]) -> str:
    """One numbered block per segment, the English line first (the device's
    ``text_en``, else the text itself when English was spoken) and the
    original under it when the two differ. Stops at the character cap."""
    blocks: list[str] = []
    chars = 0
    for index, line in enumerate(lines):
        if index >= MAX_SUMMARY_SEGMENTS:
            break
        speaker = _SPEAKER.get(line.source, line.source)
        english = line.text_en if line.text_en is not None else (
            line.text if _is_english(line.lang) else None
        )
        original = line.text if line.text and line.text != english else None
        parts = [f"({index + 1}) [{speaker}]"]
        if english:
            parts.append(f"EN: {english}")
        if original:
            parts.append(f"{(line.lang or '').upper()}: {original}")
        block = "\n".join(parts)
        # The "\n\n" between blocks counts toward the cap too.
        chars += len(block) + (2 if blocks else 0)
        if chars > MAX_TRANSCRIPT_CHARS:
            break
        blocks.append(block)
    return "\n\n".join(blocks)


def summary_prompt(lines: Iterable[TranscriptLine]) -> tuple[str, str]:
    """``(system, user)``: strict JSON with the contract's fixed sections."""
    system = " ".join([
        "You write the minutes of a meeting from its transcript, for Taskly.",
        "The transcript lines are numbered; [Me] is the microphone (the recorder), "
        "[Them] is the meeting app's own audio.",
        "Write clear, plain business language, mixing Arabic and English as they "
        "appear in the transcript.",
        "Reply with STRICT JSON and nothing else (no markdown, no code fence, no preamble):",
        '{"summary": string, "decisions": [string], "follow_ups": [string],',
        ' "action_items": [{"title": string, "assignee": string, "due": "YYYY-MM-DD"}]}',
        "- `summary`: a tight paragraph of what the meeting covered, in the "
        "transcript's own language for what it says.",
        "- `decisions`: one item per decision reached; [] when none.",
        "- `follow_ups`: things to check back on later; [] when none.",
        "- `action_items`: every task someone took on, in the transcript's own "
        "words for the title.",
        "- `assignee`: that person's name exactly as the transcript says it; \"\" "
        "when nobody took the item; omit the key when there is none.",
        "- `due`: include the key only when the transcript gives a concrete day "
        "(\"next Thursday\" is not one); its value is YYYY-MM-DD.",
        "- Never invent action items, decisions or names the transcript doesn't support.",
        "- Keep each string short: the summary under 2000 characters, one line for "
        "each list item, titles under 200.",
    ])
    user = "\n".join(["Transcript of the meeting:", "", render_transcript(lines)])
    return system, user


# Ollama's structured output: the model is held to this shape while it writes.
DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "decisions": {"type": "array", "items": {"type": "string"}},
        "follow_ups": {"type": "array", "items": {"type": "string"}},
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "assignee": {"type": "string"},
                    "due": {"type": "string"},
                },
                "required": ["title"],
            },
        },
    },
    "required": ["summary", "decisions", "follow_ups", "action_items"],
}


# ---- the reply -> the draft contract ---------------------------------------------


def _units(text: str) -> int:
    """Length as the server counts it (JavaScript string length, UTF-16)."""
    return len(text.encode("utf-16-le")) // 2


def _cap(text: str, limit: int) -> str:
    """Trim to ``limit`` UTF-16 units, ending in an ellipsis when cut."""
    if _units(text) <= limit:
        return text
    kept: list[str] = []
    used = 0
    for ch in text:
        width = 2 if ord(ch) > 0xFFFF else 1  # outside the BMP: a surrogate pair
        if used + width > limit - 1:  # room for the ellipsis
            break
        kept.append(ch)
        used += width
    return "".join(kept).rstrip() + "…"


def _lines(value: object, cap_items: int, cap_line: int) -> list[str]:
    """Strings only, trimmed, blanks dropped, capped (a lone string is one line)."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        line = item.strip()
        if line:
            out.append(_cap(line, cap_line))
        if len(out) == cap_items:
            break
    return out


def _valid_day(value: object) -> str | None:
    if not isinstance(value, str) or not _DATE_RE.match(value.strip()):
        return None
    try:
        return _date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        return None


def _json_object(raw: str) -> dict:
    """The reply's JSON object, past fences, preambles and thinking blocks."""
    fenced = _FENCE_RE.search(raw)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(_THINK_RE.sub("", raw))
    for candidate in candidates:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start < 0 or end <= start:
            continue
        try:
            parsed = json.loads(candidate[start:end + 1])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise SummaryError("summary reply unusable (no JSON object in the reply)")


def parse_draft(raw: str) -> dict:
    """The model's reply as the draft route's wire shape (snake_case)."""
    if not isinstance(raw, str) or not raw.strip():
        raise SummaryError("summary reply unusable (empty reply)")
    v = _json_object(raw)
    summary = v.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise SummaryError("summary reply unusable (no summary text)")

    items: list[dict] = []
    raw_items = v.get("action_items")
    for item in raw_items if isinstance(raw_items, list) else []:
        if len(items) == MAX_ACTION_ITEMS:
            break
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        one: dict = {"title": _cap(title.strip(), MAX_TITLE)}
        assignee = item.get("assignee")
        if isinstance(assignee, str) and assignee.strip() and _units(assignee.strip()) <= MAX_ASSIGNEE:
            one["assignee"] = assignee.strip()
        due = _valid_day(item.get("due"))
        if due:
            one["due"] = due
        items.append(one)

    return {
        "sections": {
            "summary": _cap(summary.strip(), MAX_SUMMARY),
            "decisions": _lines(v.get("decisions"), MAX_SECTION_ITEMS, MAX_SECTION_LINE),
            "follow_ups": _lines(v.get("follow_ups"), MAX_SECTION_ITEMS, MAX_SECTION_LINE),
        },
        "action_items": items,
    }


# ---- the model ---------------------------------------------------------------------


class Summarizer(Protocol):
    name: str

    def complete(self, system: str, user: str) -> str: ...


class OllamaSummarizer:
    """The local Ollama server's chat endpoint, JSON-constrained, no streaming."""

    def __init__(self, url: str = DEFAULT_OLLAMA_URL, model: str = DEFAULT_SUMMARY_MODEL,
                 *, timeout: float = DEFAULT_TIMEOUT_S, keep_alive: str | int | None = None) -> None:
        self.url = url.rstrip("/")
        self.model = model
        self.timeout = float(timeout)
        # None = Ollama's own idle timeout; the model server pins a model it
        # also translates with (-1, a number), so a summary doesn't shorten its stay.
        self.keep_alive = keep_alive
        self.name = f"ollama:{model}"

    @staticmethod
    def _context_for(system: str, user: str) -> int:
        """A context window that fits the prompt plus the answer (~3 chars/token)."""
        need = (len(system) + len(user)) // 3 + 2_048
        from .translate import CHAT_NUM_CTX  # the floor every caller shares

        return max(CHAT_NUM_CTX, min(32_768, -(-need // 1_024) * 1_024))

    def complete(self, system: str, user: str) -> str:
        body = {
            "model": self.model,
            "stream": False,
            # Thinking models answer faster without their reasoning pass; the
            # parser strips a <think> block anyway if one comes through.
            "think": False,
            **({"keep_alive": self.keep_alive} if self.keep_alive is not None else {}),
            "format": DRAFT_SCHEMA,
            "options": {"temperature": 0.2, "num_ctx": self._context_for(system, user)},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        reply = self._chat(body)
        if reply.status_code == 400 and "think" in (reply.text or "").lower():
            # Older Ollama, or a model without a thinking switch: ask plainly.
            body.pop("think")
            reply = self._chat(body)
        if reply.status_code >= 400:
            raise SummaryError(f"Ollama answered HTTP {reply.status_code}: {_ollama_error(reply)}")
        try:
            content = reply.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as exc:
            raise SummaryError("Ollama's reply had no message") from exc
        if not isinstance(content, str) or not content.strip():
            raise SummaryError("Ollama's reply was empty")
        return content

    def _chat(self, body: dict) -> requests.Response:
        try:
            # Connecting gets a short wait; the answer itself may take minutes.
            return requests.post(f"{self.url}/api/chat", json=body,
                                 timeout=(min(10.0, self.timeout), self.timeout))
        except requests.ConnectionError as exc:  # ConnectTimeout included
            raise SummaryError(
                f"Ollama isn't reachable at {self.url} (is it running?)"
            ) from exc
        except requests.Timeout as exc:
            raise SummaryError(f"Ollama took longer than {self.timeout:.0f}s") from exc
        except requests.RequestException as exc:
            raise SummaryError(f"Ollama request failed ({type(exc).__name__})") from exc


def _ollama_error(reply: requests.Response) -> str:
    """Ollama's own error line (e.g. a missing model) — never prompt content."""
    try:
        message = reply.json().get("error")
    except ValueError:
        message = None
    return str(message)[:200] if message else "no details"


# ---- the whole step ------------------------------------------------------------------


@dataclass(frozen=True)
class SummaryOutcome:
    session_id: str
    draft: dict
    seconds: float
    posted: bool

    @property
    def decisions(self) -> int:
        return len(self.draft["sections"]["decisions"])

    @property
    def follow_ups(self) -> int:
        return len(self.draft["sections"]["follow_ups"])

    @property
    def action_items(self) -> int:
        return len(self.draft["action_items"])


def make_draft(lines: list[TranscriptLine], summarizer: Summarizer) -> dict:
    """Transcript -> validated draft (raises SummaryError)."""
    if not lines:
        raise SummaryError("nothing was recorded in this session")
    system, user = summary_prompt(lines)
    return parse_draft(summarizer.complete(system, user))


def summarize_session(journal, client, session_id: str, summarizer: Summarizer,
                      *, post: bool = True) -> SummaryOutcome:
    """Summarize a journalled session and (unless ``post=False``) post the draft.

    The session must have ended on the server (status ``reviewing``); posting
    again replaces the earlier draft (the server keeps one per session).
    """
    t0 = time.monotonic()
    lines = journal.segments(session_id)
    log.info("summary: %s — %d line(s) to %s", session_id, len(lines), summarizer.name)
    draft = make_draft(lines, summarizer)
    if post:
        client.post_draft(session_id, draft)
    outcome = SummaryOutcome(session_id, draft, time.monotonic() - t0, post)
    log.info(
        "summary: %s — %d decision(s), %d follow-up(s), %d action item(s) in %.1fs%s",
        session_id, outcome.decisions, outcome.follow_ups, outcome.action_items,
        outcome.seconds, " (posted)" if post else "",
    )
    return outcome
