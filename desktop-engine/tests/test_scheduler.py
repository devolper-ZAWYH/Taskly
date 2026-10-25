"""FairScheduler: round-robin across keys, per-key limits, a bounded queue."""

from __future__ import annotations

import threading
import time

import pytest

from taskly_live.scheduler import Busy, FairScheduler


def _waiter(sched: FairScheduler, key: str, granted: list[str], **kwargs) -> threading.Thread:
    """Start a thread that waits for a turn and records the key when granted."""

    def run() -> None:
        try:
            sched.acquire(key, **kwargs)
        except Busy:
            return  # a waiter the test left queued: its wait ran out
        granted.append(key)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def _until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        time.sleep(0.005)


def test_a_free_slot_is_granted_at_once():
    sched = FairScheduler("gpu", slots=1)
    with sched.turn("a"):
        assert sched.snapshot()["running"] == {"a": 1}
    assert sched.snapshot() == {"slots": 1, "free": 1, "running": {}, "waiting": {}}


def test_keys_take_turns_instead_of_first_come_first_served():
    sched = FairScheduler("gpu", slots=1, max_wait_s=5)
    sched.acquire("a")  # a is running
    granted: list[str] = []
    threads = []
    for key in ("a", "a", "b"):  # a queues twice before b arrives
        threads.append(_waiter(sched, key, granted))
        _until(lambda n=len(threads): sum(sched.snapshot()["waiting"].values()) == n)
    for expected in (["a"], ["a", "b"], ["a", "b", "a"]):
        sched.release(granted[-1] if granted else "a")
        _until(lambda e=expected: granted == e)
    # b went before a's second queued request: a was served, so it went to the back.
    assert granted == ["a", "b", "a"]
    sched.release("a")
    for t in threads:
        t.join(1)


def test_one_key_cannot_hold_every_slot():
    sched = FairScheduler("llm", slots=2, per_key=1, max_wait_s=5)
    sched.acquire("a")
    granted: list[str] = []
    _waiter(sched, "a", granted)  # a is at its limit: waits despite a free slot
    _until(lambda: sched.snapshot()["waiting"] == {"a": 1})
    assert granted == []
    _waiter(sched, "b", granted)  # b gets the free slot straight away
    _until(lambda: granted == ["b"])
    sched.release("a")  # now a's queued request can run
    _until(lambda: granted == ["b", "a"])


def test_a_keys_own_limit_overrides_the_default():
    sched = FairScheduler("llm", slots=3, per_key=1)
    sched.acquire("batch", limit=2)
    sched.acquire("batch", limit=2)
    assert sched.snapshot()["running"] == {"batch": 2}
    with pytest.raises(Busy):
        sched.acquire("batch", limit=2, timeout=0.05)


def test_a_full_queue_refuses_at_once_with_a_retry_hint():
    sched = FairScheduler("gpu", slots=1, max_queue=1, max_wait_s=5)
    sched.acquire("a")
    _waiter(sched, "b", [])
    _until(lambda: sched.snapshot()["waiting"] == {"b": 1})
    t0 = time.monotonic()
    with pytest.raises(Busy) as refused:
        sched.acquire("c")
    assert time.monotonic() - t0 < 0.5
    assert refused.value.retry_after >= 1


def test_per_key_queue_cap_leaves_room_for_others():
    sched = FairScheduler("gpu", slots=1, max_queue=10, max_queue_per_key=1, max_wait_s=5)
    sched.acquire("a")
    _waiter(sched, "b", [])
    _until(lambda: sched.snapshot()["waiting"] == {"b": 1})
    with pytest.raises(Busy):
        sched.acquire("b")  # b already has one waiting
    _waiter(sched, "c", [])  # c still gets in line
    _until(lambda: sched.snapshot()["waiting"] == {"b": 1, "c": 1})


def test_a_wait_that_runs_out_leaves_the_queue_clean():
    sched = FairScheduler("gpu", slots=1)
    sched.acquire("a")
    with pytest.raises(Busy) as refused:
        sched.acquire("b", timeout=0.05)
    assert "busy" in str(refused.value)
    assert sched.snapshot()["waiting"] == {}
    sched.release("a")
    with sched.turn("b", timeout=0.05):  # the slot is free again
        pass


def test_release_without_a_turn_is_ignored():
    sched = FairScheduler("gpu", slots=1)
    sched.release("ghost")
    assert sched.snapshot()["free"] == 1


def test_many_threads_never_exceed_the_slots_and_all_finish():
    sched = FairScheduler("gpu", slots=2, per_key=2, max_queue=100, max_wait_s=10)
    running = 0
    peak = 0
    lock = threading.Lock()
    done = []

    def work(key: str) -> None:
        nonlocal running, peak
        with sched.turn(key):
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.005)
            with lock:
                running -= 1
        done.append(key)

    threads = [threading.Thread(target=work, args=(f"k{i % 4}",)) for i in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(done) == 40
    assert peak <= 2
    assert sched.snapshot() == {"slots": 2, "free": 2, "running": {}, "waiting": {}}
    assert sum(sched.served.values()) == 40
