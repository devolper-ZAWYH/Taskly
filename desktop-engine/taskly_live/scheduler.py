"""Fair sharing of one GPU between platforms: round-robin across API keys.

The model server is one 8 GB card serving several products at once. Without
a scheduler, whoever sends the most requests wins: a batch transcription job
on one platform would starve another platform's live meeting. A
`FairScheduler` guards one resource (the server keeps one for speech —
Whisper and the line translator — and one for Ollama's language models, so
a long streaming chat never blocks live transcription) and grants its slots:

  * round-robin across keys: after a key is served it goes to the back of the
    line, so each waiting platform gets the next free slot in turn;
  * at most `per_key` running at once for any one key (a key's own limit
    from the key store overrides it), so one platform can't hold every slot;
  * a bounded queue: past `max_queue` waiting requests in all (or
    `max_queue_per_key` for one key) the request is refused at once with a
    retry hint, and a request that waits longer than `max_wait_s` gives up
    the same way — callers turn both into 429 + Retry-After.

FIFO within a key. No request content passes through here, only key names.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator

log = logging.getLogger(__name__)


class Busy(Exception):
    """No slot now: the queue is full, or the wait ran out. Retry later."""

    def __init__(self, message: str, retry_after: int) -> None:
        super().__init__(message)
        self.retry_after = max(1, int(retry_after))


@dataclass
class _Ticket:
    key: str
    limit: int
    event: threading.Event = field(default_factory=threading.Event)
    granted: bool = False


class FairScheduler:
    """Grants `slots` concurrent turns at one resource, fairly across keys."""

    def __init__(self, name: str, *, slots: int = 1, per_key: int = 1,
                 max_queue: int = 32, max_queue_per_key: int | None = None,
                 max_wait_s: float = 40.0,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.name = name
        self.slots = max(1, int(slots))
        self.per_key = max(1, int(per_key))
        self.max_queue = max(0, int(max_queue))
        self.max_queue_per_key = self.max_queue if max_queue_per_key is None \
            else max(0, int(max_queue_per_key))
        self.max_wait_s = float(max_wait_s)
        self._clock = clock
        self._lock = threading.Lock()
        self._free = self.slots
        self._waiting: dict[str, deque[_Ticket]] = {}
        self._order: deque[str] = deque()  # keys with waiters, next-up first
        self._running: dict[str, int] = defaultdict(int)  # read with .get: no empty rows
        self._queued = 0
        self._hold_s = 2.0  # running average of how long a turn takes
        self.served: dict[str, int] = defaultdict(int)

    # ---- the public turn ---------------------------------------------------
    @contextmanager
    def turn(self, key: str, *, limit: int | None = None,
             timeout: float | None = None) -> Iterator[None]:
        """`with scheduler.turn(key):` — wait for a slot, hold it, give it back."""
        self.acquire(key, limit=limit, timeout=timeout)
        started = self._clock()
        try:
            yield
        finally:
            self.release(key, held_s=self._clock() - started)

    def acquire(self, key: str, *, limit: int | None = None,
                timeout: float | None = None) -> None:
        limit = max(1, int(limit or self.per_key))
        wait = self.max_wait_s if timeout is None else float(timeout)
        with self._lock:
            # Nobody waiting and room for this key: no queue at all.
            if self._queued == 0 and self._free > 0 and self._running.get(key, 0) < limit:
                self._grant_locked(key)
                return
            mine = len(self._waiting.get(key, ()))
            if self._queued >= self.max_queue or mine >= self.max_queue_per_key:
                raise Busy(f"{self.name} queue is full", self._retry_after_locked())
            ticket = _Ticket(key, limit)
            if key not in self._waiting:
                self._waiting[key] = deque()
                self._order.append(key)
            self._waiting[key].append(ticket)
            self._queued += 1
            self._dispatch_locked()
        if ticket.event.wait(wait):
            return
        with self._lock:
            if ticket.granted:  # granted between the timeout and the lock
                return
            self._drop_locked(ticket)
            retry = self._retry_after_locked()
        raise Busy(f"{self.name} busy: no turn within {wait:.0f}s", retry)

    def release(self, key: str, *, held_s: float | None = None) -> None:
        with self._lock:
            if self._running.get(key, 0) <= 0:
                log.error("%s: release without a turn for %s", self.name, key)
                return
            self._running[key] -= 1
            if self._running[key] == 0:
                del self._running[key]
            self._free += 1
            if held_s is not None:
                self._hold_s = 0.8 * self._hold_s + 0.2 * max(0.0, held_s)
            self._dispatch_locked()

    def snapshot(self) -> dict:
        """Counts for health/stats: running and waiting per key (names only)."""
        with self._lock:
            return {
                "slots": self.slots,
                "free": self._free,
                "running": dict(self._running),
                "waiting": {k: len(q) for k, q in self._waiting.items()},
            }

    # ---- internals (lock held) ---------------------------------------------
    def _grant_locked(self, key: str) -> None:
        self._free -= 1
        self._running[key] += 1
        self.served[key] += 1

    def _dispatch_locked(self) -> None:
        """Hand free slots to waiting keys in rotation, skipping keys at their
        own limit (they keep their place for the next free slot)."""
        while self._free > 0 and self._order:
            granted = False
            for _ in range(len(self._order)):
                key = self._order.popleft()
                queue = self._waiting[key]
                if self._running.get(key, 0) < queue[0].limit:
                    ticket = queue.popleft()
                    self._queued -= 1
                    self._grant_locked(key)
                    ticket.granted = True
                    ticket.event.set()
                    if queue:
                        self._order.append(key)  # served: to the back of the line
                    else:
                        del self._waiting[key]
                    granted = True
                    break
                self._order.append(key)
            if not granted:
                return  # everyone waiting is at their own limit

    def _drop_locked(self, ticket: _Ticket) -> None:
        queue = self._waiting.get(ticket.key)
        if queue is None:
            return
        try:
            queue.remove(ticket)
        except ValueError:
            return
        self._queued -= 1
        if not queue:
            del self._waiting[ticket.key]
            self._order.remove(ticket.key)

    def _retry_after_locked(self) -> int:
        """Rough seconds until a slot: queue depth times the average turn."""
        return int(min(120.0, max(1.0, self._hold_s * (self._queued + 1) / self.slots)))
