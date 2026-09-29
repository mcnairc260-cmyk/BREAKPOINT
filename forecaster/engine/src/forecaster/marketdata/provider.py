"""The market data boundary.

Everything above this module asks "what is the market doing"; everything below it
is "how do we get that from a particular venue". Swapping Coinbase for Kraken, or
either for a recorded capture, changes which class is constructed and nothing
else.

The protocol is deliberately event-based rather than request-based. A forecaster
at a five-minute horizon needs to see the sequence of trades, not a price; an
interface built around `get_price()` would throw away the information the whole
product depends on.

Failure handling lives in `ProviderBase` rather than in each adapter, because
every venue fails the same handful of ways — the connection drops, the rate limit
bites, a message does not parse, the feed goes quiet — and an adapter that had to
re-solve all of that would be an adapter nobody writes correctly.
"""

from __future__ import annotations

import asyncio
import random
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from forecaster.clock import SkewEstimate, monotonic_ns, now_ns
from forecaster.types import NS_PER_SECOND, BookSnapshot, DataSource, Quote, Trade

MarketEvent = Trade | Quote | BookSnapshot


class ProviderError(Exception):
    """A provider failed in a way the caller should know about."""


class StaleFeed(ProviderError):
    """The connection is up but nothing has arrived for too long.

    A separate condition from a dropped connection, and a more dangerous one: a
    socket that is open but silent looks healthy to everything except a clock.
    """


@dataclass
class ProviderHealth:
    """What the provider knows about its own reliability.

    Read by the confidence layer and shown in the UI. A provider that cannot say
    how stale it is cannot be trusted to say anything.
    """

    connected: bool = False
    last_event_ns: int | None = None
    last_trade_ns: int | None = None
    last_quote_ns: int | None = None
    reconnects: int = 0
    dropped_messages: int = 0
    malformed_messages: int = 0
    sequence_gaps: int = 0
    rate_limited: int = 0
    skew: SkewEstimate = field(default_factory=SkewEstimate.empty)
    last_error: str | None = None

    def age_ns(self, at_ns: int | None = None) -> int | None:
        if self.last_event_ns is None:
            return None
        return (at_ns if at_ns is not None else now_ns()) - self.last_event_ns

    def trade_age_ns(self, at_ns: int | None = None) -> int | None:
        if self.last_trade_ns is None:
            return None
        return (at_ns if at_ns is not None else now_ns()) - self.last_trade_ns

    def quote_age_ns(self, at_ns: int | None = None) -> int | None:
        if self.last_quote_ns is None:
            return None
        return (at_ns if at_ns is not None else now_ns()) - self.last_quote_ns

    def observe(self, event: MarketEvent) -> None:
        self.last_event_ns = event.received_ns
        if isinstance(event, Trade):
            self.last_trade_ns = event.received_ns
        elif isinstance(event, Quote):
            self.last_quote_ns = event.received_ns
        self.skew.observe(event.exchange_ns, event.received_ns)


@runtime_checkable
class MarketDataProvider(Protocol):
    """What every source of market data must be able to do."""

    @property
    def name(self) -> str: ...

    @property
    def venue(self) -> str: ...

    @property
    def data_source(self) -> DataSource: ...

    @property
    def health(self) -> ProviderHealth: ...

    def stream(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        """Yield market events as they arrive, reconnecting as needed."""
        ...

    async def close(self) -> None: ...


@dataclass
class BackoffPolicy:
    """Reconnect delays.

    Exponential with full jitter. Jitter is not decoration: without it, every
    client of a venue that has just restarted reconnects in lockstep and gives
    the venue a second outage.
    """

    initial_s: float = 0.5
    maximum_s: float = 30.0
    factor: float = 2.0

    def delay_for(self, attempt: int, rng: random.Random) -> float:
        ceiling = min(self.maximum_s, self.initial_s * (self.factor**attempt))
        return rng.uniform(0.0, ceiling)


class ProviderBase(ABC):
    """Shared reconnection, staleness and health accounting.

    Subclasses implement `_connect_and_yield`, which streams events until it
    raises. Everything about what to do when it raises is decided here, once.
    """

    def __init__(
        self,
        *,
        venue: str,
        data_source: DataSource,
        stale_after_ns: int = 60 * NS_PER_SECOND,
        backoff: BackoffPolicy | None = None,
        seed: int = 0,
    ) -> None:
        self._venue = venue
        self._data_source = data_source
        self._stale_after_ns = stale_after_ns
        self._backoff = backoff or BackoffPolicy()
        self._health = ProviderHealth()
        self._rng = random.Random(seed)
        self._closed = False

    @property
    def name(self) -> str:
        return f"{self._venue}:{self._data_source.value}"

    @property
    def venue(self) -> str:
        return self._venue

    @property
    def data_source(self) -> DataSource:
        return self._data_source

    @property
    def health(self) -> ProviderHealth:
        return self._health

    @abstractmethod
    def _connect_and_yield(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        """Stream events from the venue. Raise to trigger a reconnect."""
        raise NotImplementedError

    async def stream(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        attempt = 0
        while not self._closed:
            try:
                self._health.connected = True
                async for event in self._connect_and_yield(symbols):
                    self._health.observe(event)
                    attempt = 0
                    yield event
                # A clean end of stream is still an end of stream. Finite sources
                # (a replay, a fixed-length simulation) stop here rather than
                # reconnecting forever.
                self._health.connected = False
                return
            except asyncio.CancelledError:
                self._health.connected = False
                raise
            except Exception as exc:
                self._health.connected = False
                self._health.reconnects += 1
                self._health.last_error = f"{type(exc).__name__}: {exc}"
                # `_closed` is set by `close()`, which runs in another task, so
                # mypy analysing this function alone concludes the branch is
                # dead. It is not: it is how a shutdown stops the reconnect loop.
                if self._closed:
                    return  # type: ignore[unreachable]
                delay = self._backoff.delay_for(attempt, self._rng)
                attempt += 1
                await asyncio.sleep(delay)

    def is_stale(self, at_ns: int | None = None) -> bool:
        age = self._health.age_ns(at_ns)
        return age is None or age > self._stale_after_ns

    async def close(self) -> None:
        self._closed = True


def build_provider(
    kind: str,
    *,
    venue: str = "coinbase",
    symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD"),
    seed: int = 0,
    transport: str = "websocket",
    capture_path: str | None = None,
    **kwargs: object,
) -> MarketDataProvider:
    """Construct a provider by name.

    The only place in the system that maps a configuration string to a class, so
    adding a venue is one import and one branch.
    """
    from forecaster.marketdata.replay import ReplayProvider
    from forecaster.marketdata.simulator import SimulatedProvider

    if kind == "simulated":
        return SimulatedProvider(symbols=symbols, seed=seed, **kwargs)  # type: ignore[arg-type]
    if kind == "replay":
        if capture_path is None:
            raise ProviderError("replay provider needs capture_path")
        return ReplayProvider(capture_path=capture_path, venue=venue, **kwargs)  # type: ignore[arg-type]
    if kind == "live":
        from forecaster.marketdata.venues import build_venue_provider

        return build_venue_provider(venue, symbols=symbols, transport=transport, **kwargs)
    raise ProviderError(f"unknown provider kind: {kind!r} (expected simulated, replay or live)")


def elapsed_ms(start_monotonic_ns: int) -> float:
    return (monotonic_ns() - start_monotonic_ns) / 1_000_000.0
