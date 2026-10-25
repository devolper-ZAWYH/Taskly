"""API-contract round-trip: every rule the engine depends on the server for."""

from __future__ import annotations

import json

import pytest
import requests

from taskly_live.api import Segment
from tests.conftest import TEST_TOKEN, make_segments


def _seg(seq: int) -> Segment:
    return Segment(seq=seq, source="mic", lang="en", text="x", text_en=None,
                   started_ms=None, ended_ms=None)


def _raw_post(mock_url: str, path: str, body: dict, auth: str | None = None):
    headers = {"Content-Type": "application/json"}
    if auth is not None:
        headers["Authorization"] = auth
    return requests.post(mock_url + path, data=json.dumps(body), headers=headers,
                         timeout=5.0)


class TestAuth:
    def test_missing_token_is_401(self, mock):
        r = _raw_post(mock.url, "/api/live/sessions",
                      {"meeting_title": "X", "meeting_date": "2026-10-22"},
                      auth=None)
        assert r.status_code == 401

    def test_malformed_token_is_401(self, mock):
        r = _raw_post(mock.url, "/api/live/sessions",
                      {"meeting_title": "X", "meeting_date": "2026-10-22"},
                      auth="Token abc")
        assert r.status_code == 401

    def test_any_bearer_is_accepted_by_mock(self, mock):
        r = _raw_post(mock.url, "/api/live/sessions",
                      {"meeting_title": "X", "meeting_date": "2026-10-22"},
                      auth="Bearer whatever")
        assert r.status_code == 200
        assert r.json()["session"]["status"] == "capturing"


class TestSessionLifecycle:
    def test_create_end_shapes(self, client):
        session = client.create_session("Standup", "2026-10-22")
        assert session["status"] == "capturing" and session["id"]
        ended = client.end_session(session["id"])
        assert ended["session"]["status"] == "reviewing"

    def test_meeting_claim_is_sent_only_when_given(self, client, mock):
        claimed = client.create_session("Weekly", "2026-10-25", "m-11")
        rehearsal = client.create_session("Rehearsal", "2026-10-25")
        assert mock.state.sessions[claimed["id"]]["meetingId"] == "m-11"
        assert mock.state.sessions[rehearsal["id"]]["meetingId"] is None

    def test_bad_meeting_date_is_400(self, mock):
        r = _raw_post(mock.url, "/api/live/sessions",
                      {"meeting_title": "X", "meeting_date": "tomorrow"},
                      auth=f"Bearer {TEST_TOKEN}")
        assert r.status_code == 400


class TestPushRules:
    def test_push_accepts_and_counts(self, client, mock):
        s = client.create_session("Moves", "2026-10-22")
        outcome = client.push(s["id"], [
            Segment(seq=i + 1, source="mic", lang="en", text=f"m{i}", text_en=f"m{i}",
                    started_ms=i * 100, ended_ms=i * 100 + 50)
            for i in range(3)
        ])
        mock_sess = mock.state.sessions[s["id"]]
        assert outcome.accepted == 3
        assert outcome.last_seq == 3
        assert set(mock_sess["segments"]) == {1, 2, 3}

    def test_duplicates_are_ignored(self, client, mock):
        from taskly_live.api import Segment

        s = client.create_session("Dup", "2026-10-22")
        segs = [Segment(seq=1, source="mic", lang="en", text="a", text_en="a",
                        started_ms=0, ended_ms=10)]
        one = client.push(s["id"], segs)
        two = client.push(s["id"], segs)
        assert (one.accepted, two.accepted) == (1, 0)
        assert (one.last_seq, two.last_seq) == (1, 1)
        assert len(mock.state.sessions[s["id"]]["segments"]) == 1

    def test_over_200_is_rejected_server_side(self, client, mock):
        s = client.create_session("TooBig", "2026-10-22")
        raw = [dict(seg, seq=i) for i, seg in enumerate(make_segments(250), start=1)]
        r = _raw_post(mock.url, "/api/live/push",
                      {"session_id": s["id"], "segments": raw},
                      auth="Bearer x")
        assert r.status_code == 400
        assert "too many" in r.json()["error"]

    def test_client_refuses_over_200_before_network(self, client):
        s = client.create_session("Local", "2026-10-22")

        segs = [
            Segment(seq=i, source="mic", lang="en", text="x", text_en=None,
                    started_ms=None, ended_ms=None)
            for i in range(201)
        ]
        with pytest.raises(ValueError):
            client.push(s["id"], segs)

    def test_unknown_session_is_404(self, client):
        from taskly_live.api import ApiError

        with pytest.raises(ApiError) as err:
            client.push("no-such-session", [_seg(1)])
        assert err.value.status == 404
        assert not err.value.retryable and err.value.fatal

    def test_bad_segment_shape_is_400(self, client, mock):
        s = client.create_session("Bad", "2026-10-22")
        r = _raw_post(mock.url, "/api/live/push",
                      {"session_id": s["id"],
                       "segments": [{"seq": 0, "source": "mic", "text": ""}]},
                      auth="Bearer x")
        assert r.status_code == 400

    def test_429_is_retryable_semantics(self, client, mock):
        from taskly_live.api import ApiError

        s = client.create_session("Ratelimited", "2026-10-22")
        mock.state.fail_next.append((429, 1))
        with pytest.raises(ApiError) as err:
            client.push(s["id"], [_seg(1)])
        assert err.value.retryable and not err.value.fatal

    def test_text_ar_over_4000_chars_is_400(self, client, mock):
        s = client.create_session("LongAr", "2026-10-22")
        base = {"seq": 1, "source": "mic", "lang": "ar", "text": "x"}
        r = _raw_post(mock.url, "/api/live/push",
                      {"session_id": s["id"],
                       "segments": [{**base, "text_ar": "ع" * 4001}]},
                      auth="Bearer x")
        assert r.status_code == 400
        r = _raw_post(mock.url, "/api/live/push",
                      {"session_id": s["id"],
                       "segments": [{**base, "text_ar": 5}]},
                      auth="Bearer x")
        assert r.status_code == 400
        r = _raw_post(mock.url, "/api/live/push",
                      {"session_id": s["id"],
                       "segments": [{**base, "text_ar": "ع" * 4000}]},
                      auth="Bearer x")
        assert r.status_code == 200
        assert mock.state.sessions[s["id"]]["segments"][1]["text_ar"] == "ع" * 4000
