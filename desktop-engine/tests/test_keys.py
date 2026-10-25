"""The shared server's API-key store: key format and hashing at rest, per-name
revocation, usage counters, throttled persistence, the legacy single key, and
use from many threads."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone

import pytest

from taskly_live.keys import KEY_PREFIX, KeyInfo, KeyStore, KeyStoreError


class Clock:
    """A hand-driven monotonic clock for the flush throttle."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def path(tmp_path):
    return tmp_path / "server-keys.json"


def on_disk(path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def by_name(store: KeyStore, name: str) -> KeyInfo:
    return next(k for k in store.list() if k.name == name)


# ---- keys -----------------------------------------------------------------------------


def test_add_returns_a_prefixed_key_that_verifies(path):
    store = KeyStore(path)
    raw = store.add("zawyh")
    assert raw.startswith(KEY_PREFIX) and len(raw) > len(KEY_PREFIX) + 32
    info = store.verify(raw)
    assert info is not None and info.name == "zawyh" and info.active


def test_keys_are_unique(path):
    store = KeyStore(path)
    assert store.add("a") != store.add("b")


def test_disk_holds_no_raw_key(path):
    store = KeyStore(path)
    raw = store.add("zawyh")
    text = path.read_text(encoding="utf-8")
    assert raw not in text
    assert raw[len(KEY_PREFIX):] not in text
    entry = on_disk(path)["keys"][0]
    assert entry["name"] == "zawyh"
    assert len(entry["hash"]) == 64 and int(entry["hash"], 16) >= 0
    assert entry["revoked"] is None and entry["last_used"] is None
    assert entry["usage"] == {"requests": 0, "audio_seconds": 0.0,
                              "prompt_tokens": 0, "completion_tokens": 0}


def test_keyinfo_never_carries_a_secret(path):
    store = KeyStore(path)
    raw = store.add("zawyh")
    info = store.verify(raw)
    assert not hasattr(info, "hash")
    assert raw not in repr(store.list())


@pytest.mark.parametrize("bad", ["", "Upper", "-lead", "has space", "a/b", "x" * 65, "n\n", "é", None])
def test_bad_names_are_refused(path, bad):
    store = KeyStore(path)
    with pytest.raises(ValueError):
        store.add(bad)
    assert store.list() == []


@pytest.mark.parametrize("good", ["a", "0", "taskly-laptops", "a_b.c-9", "x" * 64])
def test_good_names_are_accepted(path, good):
    assert KeyStore(path).add(good)


def test_bad_concurrency_is_refused(path):
    store = KeyStore(path)
    for bad in (0, -1, 1.5, True):
        with pytest.raises(ValueError):
            store.add("a", concurrency=bad)
    store.add("a", concurrency=3)
    assert by_name(store, "a").concurrency == 3
    assert on_disk(path)["keys"][0]["concurrency"] == 3


def test_wrong_or_empty_key_does_not_verify(path):
    store = KeyStore(path)
    raw = store.add("a")
    assert store.verify(raw + "x") is None
    assert store.verify(raw[:-1]) is None
    assert store.verify("") is None
    assert store.verify("tsk_nope") is None


def test_duplicate_active_name_is_refused(path):
    store = KeyStore(path)
    store.add("a")
    with pytest.raises(ValueError):
        store.add("a")
    assert len(store.list()) == 1


def test_revoke_stops_verification_and_is_listed(path):
    store = KeyStore(path)
    raw = store.add("a")
    other = store.add("b")
    assert store.revoke("a") is True
    assert store.verify(raw) is None
    assert store.verify(other) is not None  # the others carry on
    info = by_name(store, "a")
    assert not info.active and info.revoked is not None
    assert on_disk(path)["keys"][0]["revoked"] == info.revoked  # flushed at once


def test_revoke_unknown_or_twice_is_false(path):
    store = KeyStore(path)
    store.add("a")
    assert store.revoke("nope") is False
    assert store.revoke("a") is True
    assert store.revoke("a") is False


def test_revoked_name_can_be_issued_again(path):
    store = KeyStore(path)
    old = store.add("a")
    store.revoke("a")
    new = store.add("a")
    assert new != old
    assert store.verify(old) is None
    assert store.verify(new).name == "a"
    entries = store.list()
    assert [e.active for e in entries] == [False, True]  # the old entry stays


def test_revoked_entry_is_not_a_duplicate_on_reload(path):
    store = KeyStore(path)
    store.add("a")
    store.revoke("a")
    store.add("a")
    again = KeyStore(path)
    assert [e.active for e in again.list()] == [False, True]


def test_records_use_the_injected_utc_clock(path):
    now = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone(timedelta(hours=4)))
    store = KeyStore(path, utcnow=lambda: now)
    raw = store.add("a")
    assert by_name(store, "a").created == "2026-01-01T23:04:05+00:00"
    assert store.verify(raw).last_used == "2026-01-01T23:04:05+00:00"


# ---- usage and persistence --------------------------------------------------------------


def test_verify_sets_last_used(path):
    store = KeyStore(path)
    raw = store.add("a")
    assert by_name(store, "a").last_used is None
    info = store.verify(raw)
    assert info.last_used is not None
    assert by_name(store, "a").last_used == info.last_used


def test_usage_accumulates_and_survives_flush_and_reload(path):
    store = KeyStore(path)
    store.add("a")
    store.add("b")
    store.record("a")
    store.record("a", requests=2, audio_seconds=1.5, prompt_tokens=10, completion_tokens=4)
    store.record("a", audio_seconds=0.25, completion_tokens=1)
    store.record("ghost")  # unknown names are ignored
    store.flush()

    for source in (store, KeyStore(path)):
        usage = by_name(source, "a").usage
        assert (usage.requests, usage.audio_seconds) == (4, 1.75)
        assert (usage.prompt_tokens, usage.completion_tokens) == (10, 5)
        assert by_name(source, "b").usage.requests == 0


def test_verified_key_still_works_after_reload(path):
    raw = KeyStore(path).add("a")
    reloaded = KeyStore(path)
    assert reloaded.verify(raw).name == "a"
    assert reloaded.verify(raw + "x") is None


def test_counter_flush_is_throttled(path):
    clock = Clock()
    store = KeyStore(path, flush_interval_s=10.0, clock=clock)
    store.add("a")  # written at once

    clock.t += 1
    store.record("a")
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 0  # not yet

    clock.t += 5
    store.record("a")
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 0  # still inside the window

    clock.t += 5  # 11 s since the last write
    store.record("a")
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 3  # all three land together

    clock.t += 1
    store.record("a")
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 3
    store.close()  # close() flushes what the throttle held back
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 4


def test_throttled_verify_flushes_last_used(path):
    clock = Clock()
    store = KeyStore(path, flush_interval_s=10.0, clock=clock)
    raw = store.add("a")
    clock.t += 1
    store.verify(raw)
    assert on_disk(path)["keys"][0]["last_used"] is None
    clock.t += 20
    store.verify(raw)
    assert on_disk(path)["keys"][0]["last_used"] is not None


def test_a_mutation_flushes_pending_counters_too(path):
    clock = Clock()
    store = KeyStore(path, flush_interval_s=1000.0, clock=clock)
    store.add("a")
    store.record("a", requests=7)
    store.add("b")  # add always writes the whole file
    assert on_disk(path)["keys"][0]["usage"]["requests"] == 7


def test_flush_without_changes_writes_nothing(path):
    store = KeyStore(path)
    store.add("a")
    path.unlink()
    store.flush()
    assert not path.exists()


def test_context_manager_flushes(path):
    with KeyStore(path, flush_interval_s=1000.0) as store:
        store.add("a")
        store.record("a", requests=3)
    assert by_name(KeyStore(path), "a").usage.requests == 3


def test_missing_file_is_an_empty_store(path):
    store = KeyStore(path)
    assert store.list() == []
    assert not path.exists()  # nothing written until there is something to keep


def test_no_temp_file_is_left_behind(path):
    store = KeyStore(path)
    store.add("a")
    store.revoke("a")
    assert [p.name for p in path.parent.iterdir()] == [path.name]


def test_parent_directory_is_created(tmp_path):
    nested = tmp_path / "data" / "server-keys.json"
    KeyStore(nested).add("a")
    assert nested.exists()


@pytest.mark.parametrize("content", [
    "{not json",
    "",
    "[]",
    '{"keys": "nope"}',
    '{"version": 99, "keys": []}',
    '{"keys": [{"name": "a"}]}',
    '{"keys": [{"name": "BAD NAME", "hash": "x", "created": "t"}]}',
    json.dumps({"keys": [
        {"name": "a", "hash": "h1", "created": "t"},
        {"name": "a", "hash": "h2", "created": "t"},
    ]}),
])
def test_corrupt_file_raises_and_is_left_alone(path, content):
    path.write_text(content, encoding="utf-8")
    with pytest.raises(KeyStoreError):
        KeyStore(path)
    assert path.read_text(encoding="utf-8") == content


# ---- legacy key and in-memory ---------------------------------------------------------


def test_import_legacy_adds_once(path):
    store = KeyStore(path)
    assert store.import_legacy("old-plain-key\n") is True
    assert store.import_legacy("old-plain-key") is False
    assert store.import_legacy("old-plain-key", name="other") is False  # same hash
    assert [k.name for k in store.list()] == ["taskly-laptops"]
    assert store.verify("old-plain-key").name == "taskly-laptops"
    assert "old-plain-key" not in path.read_text(encoding="utf-8")


def test_import_legacy_survives_restart_without_duplicating(path):
    KeyStore(path).import_legacy("old-plain-key")
    again = KeyStore(path)
    assert again.import_legacy("old-plain-key") is False
    assert len(again.list()) == 1
    assert again.verify("old-plain-key") is not None


def test_import_legacy_keeps_a_revoked_key_revoked(path):
    store = KeyStore(path)
    store.import_legacy("old-plain-key")
    store.revoke("taskly-laptops")
    assert store.import_legacy("old-plain-key") is False
    assert store.verify("old-plain-key") is None


def test_import_legacy_refuses_a_taken_name_and_an_empty_key(path):
    store = KeyStore(path)
    store.add("taskly-laptops")
    with pytest.raises(ValueError):
        store.import_legacy("old-plain-key")
    with pytest.raises(ValueError):
        store.import_legacy("  \n")
    with pytest.raises(ValueError):
        store.import_legacy("old-plain-key", name="Bad Name")


def test_in_memory_store(tmp_path):
    store = KeyStore.in_memory("plain-key", name="test")
    assert store.verify("plain-key").name == "test"
    assert store.verify("other") is None
    store.record("test", requests=2)
    store.flush()
    assert store.add("more").startswith(KEY_PREFIX)
    assert list(tmp_path.iterdir()) == []  # never touches the disk
    assert KeyStore.in_memory("plain-key").verify("plain-key").name == "default"


# ---- threads --------------------------------------------------------------------------


def test_concurrent_verify_and_record_totals_are_exact(path):
    store = KeyStore(path, flush_interval_s=0.0)  # flush on every change: worst case
    raws = {name: store.add(name) for name in ("a", "b", "c")}
    threads_n, loops = 8, 100
    failures: list[str] = []

    def work(i: int) -> None:
        name = ("a", "b", "c")[i % 3]
        for _ in range(loops):
            info = store.verify(raws[name])
            if info is None or info.name != name:
                failures.append(name)
            store.record(name, audio_seconds=0.5, prompt_tokens=2, completion_tokens=1)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(threads_n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    store.flush()

    assert failures == []
    workers = {"a": 3, "b": 3, "c": 2}  # threads per key
    for source in (store, KeyStore(path)):
        for name, n in workers.items():
            usage = by_name(source, name).usage
            assert usage.requests == n * loops
            assert usage.audio_seconds == n * loops * 0.5
            assert usage.prompt_tokens == n * loops * 2
            assert usage.completion_tokens == n * loops


def test_revoke_during_traffic_is_final(path):
    store = KeyStore(path)
    raw = store.add("a")
    stop = threading.Event()
    seen_after_revoke: list[bool] = []
    revoked = threading.Event()

    def hammer() -> None:
        while not stop.is_set():
            was_revoked = revoked.is_set()  # read first: a verify that began earlier may pass
            ok = store.verify(raw) is not None
            if was_revoked:
                seen_after_revoke.append(ok)

    threads = [threading.Thread(target=hammer) for _ in range(4)]
    for t in threads:
        t.start()
    store.revoke("a")
    revoked.set()
    for _ in range(200):  # let the hammering threads run past the revoke
        store.verify(raw)
    stop.set()
    for t in threads:
        t.join()
    assert not any(seen_after_revoke)


# ---- two processes on one file (the server + `serve keys add|revoke`) ----------------


def test_a_key_added_elsewhere_is_seen_and_never_overwritten(tmp_path):
    path = tmp_path / "keys.json"
    clock = [0.0]
    server = KeyStore(path, flush_interval_s=0, clock=lambda: clock[0])
    server.add("first")
    cli = KeyStore(path)
    new_raw = cli.add("second")
    # The server's own write (a usage flush) must keep the CLI's key.
    server.record("first")
    server.flush()
    assert {k.name for k in KeyStore(path).list()} == {"first", "second"}
    clock[0] += 5  # past the refresh pacing
    assert server.verify(new_raw) is not None


def test_a_revoke_elsewhere_takes_effect_in_the_running_server(tmp_path):
    path = tmp_path / "keys.json"
    clock = [0.0]
    server = KeyStore(path, clock=lambda: clock[0])
    raw = server.add("leaky")
    assert server.verify(raw) is not None
    KeyStore(path).revoke("leaky")
    clock[0] += 5
    assert server.verify(raw) is None


def test_merging_keeps_the_larger_counters(tmp_path):
    path = tmp_path / "keys.json"
    server = KeyStore(path, flush_interval_s=0)
    server.add("p")
    for _ in range(3):
        server.record("p", audio_seconds=1.0)
    server.flush()
    stale = KeyStore(path)  # a CLI process holding 3 requests
    for _ in range(2):
        server.record("p")
    server.flush()  # file now says 5
    stale.add("other")  # its write merges instead of rolling back to 3
    usage = {k.name: k.usage for k in KeyStore(path).list()}
    assert usage["p"].requests == 5
    assert usage["p"].audio_seconds == 3.0
