"""How long the recorder waits for one utterance's decode (recorder.decode_wait_s)."""

from __future__ import annotations

from taskly_live.recorder import SHUTDOWN_DECODE_GRACE_S, decode_wait_s
from taskly_live.remote import RemoteStt


class _LocalStt:
    """Like SttPipeline: no result_timeout_s."""


def test_local_whisper_keeps_the_30s_grace():
    assert decode_wait_s(_LocalStt()) == SHUTDOWN_DECODE_GRACE_S


def test_a_model_server_outage_is_waited_out():
    stt = RemoteStt("http://127.0.0.1:9", "k")
    # The whole 5-minute retry window and then some: the recorder never gives
    # up on a line the client is still retrying.
    assert decode_wait_s(stt) > stt.retry_window_s >= 300


def test_a_short_timeout_never_shrinks_the_grace():
    class _Quick:
        result_timeout_s = 5.0

    assert decode_wait_s(_Quick()) == SHUTDOWN_DECODE_GRACE_S
