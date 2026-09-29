"""Time, handled carefully enough to be trusted.

Three separate concerns get confused in forecasting systems, so they are three
separate things here:

* **Exchange time** — when the venue says an event happened. Outcomes resolve
  against this, because "the price at 18:42:00" means the venue's 18:42:00.
* **Receipt time** — when this process saw the event. Feature windows close on
  this, because it is the only cutoff that is honestly causal: information that
  had not arrived yet cannot be an input.
* **Monotonic time** — for measuring durations. Wall clocks step backwards
  during NTP corrections, and a negative measured latency corrupts a staleness
  check at exactly the wrong moment.

Using exchange time to close a feature window would leak, by an amount equal to
the feed latency. That is invisible at a twenty-minute horizon and material for
a feature measured over the last two seconds.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime

from forecaster.types import NS_PER_SECOND


def now_ns() -> int:
    """Wall-clock nanoseconds since the epoch."""
    return time.time_ns()


def monotonic_ns() -> int:
    """Nanoseconds from a clock that cannot go backwards. Durations only."""
    return time.monotonic_ns()


def to_datetime(ns: int) -> datetime:
    return datetime.fromtimestamp(ns / NS_PER_SECOND, tz=UTC)


def to_ns(dt: datetime) -> int:
    if dt.tzinfo is None:
        raise ValueError("naive datetime; timezone is never assumed")
    return int(dt.timestamp() * NS_PER_SECOND)


def iso(ns: int) -> str:
    return to_datetime(ns).isoformat().replace("+00:00", "Z")


def floor_ns(ns: int, resolution_s: int) -> int:
    """Round a timestamp down to a bar boundary."""
    step = resolution_s * NS_PER_SECOND
    return (ns // step) * step


@dataclass
class SkewEstimate:
    """Running estimate of this venue's clock offset from ours.

    Estimated as a low quantile of (received - exchange): the minimum observed
    transit time is mostly clock offset, because network latency can only add.
    A robust low quantile rather than the true minimum, so one bad packet with a
    mangled timestamp cannot pin the estimate forever.
    """

    samples: list[int]
    capacity: int = 512
    quantile: float = 0.05

    @classmethod
    def empty(cls, capacity: int = 512) -> SkewEstimate:
        return cls(samples=[], capacity=capacity)

    def observe(self, exchange_ns: int, received_ns: int) -> None:
        delta = received_ns - exchange_ns
        self.samples.append(delta)
        if len(self.samples) > self.capacity:
            del self.samples[0 : len(self.samples) - self.capacity]

    @property
    def skew_ns(self) -> int:
        if not self.samples:
            return 0
        ordered = sorted(self.samples)
        index = min(len(ordered) - 1, int(len(ordered) * self.quantile))
        return ordered[index]

    @property
    def sample_count(self) -> int:
        return len(self.samples)


class FrozenClock:
    """A clock that only moves when told to.

    Every component that needs the time takes a clock, so tests and the
    backtester can drive it. Real time in a test is a source of flakes and, in a
    forecasting system, of accidental look-ahead: code that calls
    `time.time_ns()` during a replay is reading the wall clock of the machine
    running the replay, not the instant being replayed.
    """

    def __init__(self, start_ns: int) -> None:
        self._ns = start_ns

    def now_ns(self) -> int:
        return self._ns

    def advance_ns(self, delta_ns: int) -> int:
        if delta_ns < 0:
            raise ValueError("a clock does not run backwards")
        self._ns += delta_ns
        return self._ns

    def set_ns(self, ns: int) -> None:
        self._ns = ns
