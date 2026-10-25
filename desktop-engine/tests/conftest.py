"""Pytest fixtures: ephemeral TEST-ONLY mock server + client."""

from __future__ import annotations

from pathlib import Path

import pytest

from taskly_live.api import LiveClient
from taskly_live.mock_server import MockServer

TEST_TOKEN = "test-token"


@pytest.fixture()
def mock() -> MockServer:
    server = MockServer.with_ephemeral()
    yield server
    server.stop()


@pytest.fixture()
def client(mock: MockServer) -> LiveClient:
    return LiveClient(mock.url, TEST_TOKEN, batch_limit=200)


@pytest.fixture()
def journal(tmp_path: Path):
    from taskly_live.journal import Journal

    j = Journal(tmp_path / "journal.sqlite3")
    yield j
    j.close()


def make_segments(n: int, start_seq: int = 1, session_start_ms: int = 0) -> list[dict]:
    """Contract-shaped segment dicts for bulk tests."""
    out = []
    for i in range(n):
        seq = start_seq + i
        out.append(
            {
                "seq": seq,
                "source": "mic" if i % 2 == 0 else "system",
                "lang": "en" if i % 2 == 0 else "ar",
                "text": f"utterance {seq}",
                "text_en": f"utterance {seq}",
                "started_at": session_start_ms + i * 1000,
                "ended_at": session_start_ms + i * 1000 + 800,
            }
        )
    return out
