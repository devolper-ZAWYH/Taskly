"""On-device summary: prompt parity with the server, the defensive parse and
its caps, the Ollama request, and the draft posted to the (mock) server."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from taskly_live.api import ApiError
from taskly_live.summarize import (
    MAX_TRANSCRIPT_CHARS,
    OllamaSummarizer,
    SummaryError,
    make_draft,
    parse_draft,
    render_transcript,
    summarize_session,
    summary_prompt,
)


@dataclass
class Line:
    source: str = "mic"
    lang: str | None = "en"
    text: str = "Hello there."
    text_en: str | None = None


# ---- the prompt (mirrors server/summarize/prompt.test.ts) ----------------------------

def test_transcript_renders_numbered_blocks_english_first():
    out = render_transcript([
        Line(source="system", lang="ar", text="أهلا", text_en="Hello"),
        Line(),
        Line(lang="en", text="Sure thing.", text_en="Sure thing."),
    ])
    blocks = out.split("\n\n")
    assert blocks[0].split("\n") == ["(1) [Them]", "EN: Hello", "AR: أهلا"]
    assert blocks[1].split("\n") == ["(2) [Me]", "EN: Hello there."]
    assert blocks[2].split("\n") == ["(3) [Me]", "EN: Sure thing."]


def test_no_english_line_renders_the_original_only():
    assert render_transcript([Line(lang="ar", text="مرحبا")]).split("\n") == ["(1) [Me]", "AR: مرحبا"]


def test_render_stops_at_the_character_cap():
    out = render_transcript([Line(text=f"x{i}" * 5_000) for i in range(10)])
    assert len(out) <= MAX_TRANSCRIPT_CHARS
    assert "(5) [Me]" in out and "(6) [Me]" not in out


def test_prompt_asks_for_strict_json():
    system, user = summary_prompt([Line()])
    assert "STRICT JSON" in system and '"action_items"' in system and "YYYY-MM-DD" in system
    assert user.startswith("Transcript of the meeting:\n\n(1) [Me]")


# ---- the reply -> the draft contract -------------------------------------------------

def test_clean_reply_becomes_the_wire_draft():
    draft = parse_draft(json.dumps({
        "summary": " Kicked off the review. ",
        "decisions": ["Ship on the 26th."],
        "follow_ups": [],
        "action_items": [
            {"title": "Draft the announcement", "assignee": " Sara ", "due": "2026-10-24"},
            {"title": "Book the demo", "assignee": "", "due": ""},
        ],
    }))
    assert draft == {
        "sections": {"summary": "Kicked off the review.", "decisions": ["Ship on the 26th."],
                     "follow_ups": []},
        "action_items": [
            {"title": "Draft the announcement", "assignee": "Sara", "due": "2026-10-24"},
            {"title": "Book the demo"},
        ],
    }


def test_fenced_padded_and_thinking_replies_are_unwrapped():
    body = json.dumps({"summary": "Done.", "decisions": [], "follow_ups": [], "action_items": []})
    for raw in (f"```json\n{body}\n```", f"Here it is:\n{body}\nThanks", f"<think>hmm {{}}</think>\n{body}"):
        assert parse_draft(raw)["sections"]["summary"] == "Done."


def test_long_or_messy_lists_are_capped_not_rejected():
    draft = parse_draft(json.dumps({
        "summary": "Busy.",
        "decisions": [""] + [f"D{i}" for i in range(30)],
        "follow_ups": "Call back",  # a lone string is one line
        "action_items": [{"title": f"T{i}", "due": "next Thursday"} for i in range(31)]
        + [{"title": "late"}],
    }))
    assert len(draft["sections"]["decisions"]) == 25 and draft["sections"]["decisions"][0] == "D0"
    assert draft["sections"]["follow_ups"] == ["Call back"]
    assert len(draft["action_items"]) == 30
    assert all("due" not in item for item in draft["action_items"])  # not a date: left out


def test_over_long_strings_are_trimmed_to_the_contract():
    draft = parse_draft(json.dumps({
        "summary": "s" * 25_000,
        "decisions": ["d" * 600],
        "follow_ups": [],
        "action_items": [{"title": "t" * 300, "assignee": "n" * 101, "due": "2026-02-30"}],
    }))
    assert len(draft["sections"]["summary"]) == 20_000
    assert len(draft["sections"]["decisions"][0]) == 500
    item = draft["action_items"][0]
    assert len(item["title"]) == 200 and item["title"].endswith("…")
    assert "assignee" not in item and "due" not in item  # too long a name; no such day


@pytest.mark.parametrize("raw", ["", "   ", "no braces", "[1, 2]", json.dumps({"summary": "  "})])
def test_unusable_replies_fail_without_quoting_anything(raw):
    with pytest.raises(SummaryError) as err:
        parse_draft(raw)
    assert "summary reply unusable" in str(err.value)


def test_an_empty_session_is_not_summarized():
    with pytest.raises(SummaryError):
        make_draft([], FakeSummarizer("{}"))


# ---- Ollama ------------------------------------------------------------------------------

class _FakeOllama(BaseHTTPRequestHandler):
    calls: list[dict] = []
    replies: list[tuple[int, dict]] = []

    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append({"path": self.path, "body": body})
        status, payload = type(self).replies.pop(0)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture()
def ollama():
    _FakeOllama.calls = []
    _FakeOllama.replies = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOllama)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", _FakeOllama
    server.shutdown()


REPLY = {"summary": "Weekly review.", "decisions": ["Ship it."], "follow_ups": [],
         "action_items": [{"title": "Draft the note", "assignee": "Sara"}]}


def test_ollama_is_asked_for_schema_bound_json_without_thinking(ollama):
    url, fake = ollama
    fake.replies.append((200, {"message": {"role": "assistant", "content": json.dumps(REPLY)}}))
    raw = OllamaSummarizer(url, "qwen3.5:4b").complete("SYSTEM", "USER")
    assert json.loads(raw) == REPLY
    call = fake.calls[0]
    assert call["path"] == "/api/chat"
    body = call["body"]
    assert body["model"] == "qwen3.5:4b" and body["stream"] is False and body["think"] is False
    assert body["format"]["required"] == ["summary", "decisions", "follow_ups", "action_items"]
    assert body["options"]["num_ctx"] >= 8_192
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_keep_alive_is_ollamas_own_unless_the_server_pins_the_model(ollama):
    url, fake = ollama
    fake.replies += [(200, {"message": {"content": json.dumps(REPLY)}})] * 2
    OllamaSummarizer(url, "m").complete("S", "U")
    OllamaSummarizer(url, "m", keep_alive=-1).complete("S", "U")
    assert "keep_alive" not in fake.calls[0]["body"]
    assert fake.calls[1]["body"]["keep_alive"] == -1


def test_ollama_without_a_thinking_switch_is_asked_again_plainly(ollama):
    url, fake = ollama
    fake.replies.append((400, {"error": "model does not support think"}))
    fake.replies.append((200, {"message": {"content": json.dumps(REPLY)}}))
    OllamaSummarizer(url, "plain-model").complete("S", "U")
    assert "think" in fake.calls[0]["body"] and "think" not in fake.calls[1]["body"]


def test_ollama_errors_say_what_ollama_said(ollama):
    url, fake = ollama
    fake.replies.append((404, {"error": "model 'nope' not found"}))
    with pytest.raises(SummaryError, match="model 'nope' not found"):
        OllamaSummarizer(url, "nope").complete("S", "U")


def test_ollama_not_running_is_a_plain_error():
    with pytest.raises(SummaryError, match="isn't reachable"):
        OllamaSummarizer("http://127.0.0.1:9", "m", timeout=2).complete("S", "U")


# ---- the whole step against the mock server -----------------------------------------------

class FakeSummarizer:
    name = "fake"

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.prompts: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.prompts.append((system, user))
        return self.reply


def _recorded(client, journal) -> str:
    sid = client.create_session("Weekly", "2026-10-25")["id"]
    journal.ensure_session(sid, "Weekly", "2026-10-25", 0)
    journal.append(sid, source="mic", lang="ar", text="مرحبا", text_en="Hello",
                   started_ms=0, ended_ms=900)
    journal.append(sid, source="system", lang="en", text="Ship it.", text_en="Ship it.",
                   started_ms=1000, ended_ms=1800)
    return sid


def test_an_ended_session_gets_its_draft_posted(client, journal, mock):
    sid = _recorded(client, journal)
    client.end_session(sid)
    fake = FakeSummarizer(json.dumps(REPLY))
    outcome = summarize_session(journal, client, sid, fake)
    assert (outcome.decisions, outcome.action_items, outcome.posted) == (1, 1, True)
    # The prompt is built from the journal, both lines, English first.
    assert "(1) [Me]\nEN: Hello\nAR: مرحبا" in fake.prompts[0][1]
    assert "(2) [Them]\nEN: Ship it." in fake.prompts[0][1]
    posted = mock.state.sessions[sid]["draft"]
    assert posted["sections"]["summary"] == "Weekly review."
    assert posted["actionItems"] == [{"title": "Draft the note", "assignee": "Sara"}]


def test_a_draft_before_the_end_is_refused(client, journal):
    sid = _recorded(client, journal)
    with pytest.raises(ApiError) as err:
        summarize_session(journal, client, sid, FakeSummarizer(json.dumps(REPLY)))
    assert err.value.status == 404


def test_dry_run_posts_nothing(client, journal, mock):
    sid = _recorded(client, journal)
    client.end_session(sid)
    outcome = summarize_session(journal, client, sid, FakeSummarizer(json.dumps(REPLY)), post=False)
    assert outcome.posted is False and "draft" not in mock.state.sessions[sid]
