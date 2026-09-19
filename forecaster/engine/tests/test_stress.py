"""What the system does when the feed misbehaves.

Section 10 of the brief lists the ways a market data feed fails. Each one gets a
test here, and each test asserts one of two acceptable outcomes: the system
recovers correctly, or it refuses to produce a forecast. There is no third
acceptable outcome, and the unacceptable one — carrying on and answering from bad
data — is what every assertion below is written to catch.

Most of these run against the conformance server over a real socket, because the
failures worth testing are failures of the connection rather than of a parser.
"""

from __future__ import annotations

import asyncio

import pytest

from forecaster.clock import now_ns
from forecaster.config import QualityConfig
from forecaster.marketdata.conformance import CoinbaseConformanceVenue, Faults
from forecaster.marketdata.venues.coinbase import CoinbaseProvider
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.types import NS_PER_SECOND, Quote, ServiceLevel, Side, Trade

LOCAL = [pytest.mark.enable_socket, pytest.mark.allow_hosts(["127.0.0.1", "::1"])]


def trade(price: float, tid: str, ns: int, *, size: float = 0.01) -> Trade:
    return Trade(
        exchange_ns=ns,
        received_ns=ns,
        symbol="BTC-USD",
        price=price,
        size=size,
        side=Side.BUY,
        trade_id=tid,
    )


def quote(bid: float, ask: float, ns: int) -> Quote:
    return Quote(
        exchange_ns=ns,
        received_ns=ns,
        symbol="BTC-USD",
        bid=bid,
        bid_size=1.0,
        ask=ask,
        ask_size=1.0,
    )


def warmed_monitor() -> tuple[QualityMonitor, int]:
    """A monitor with enough ordinary history to have an opinion."""
    monitor = QualityMonitor()
    base = now_ns()
    for i in range(60):
        monitor.check_trade(trade(79_000.0 + i, f"warm{i}", base + i * 1_000_000))
    return monitor, base + 61 * 1_000_000


# ---------------------------------------------------------------------------
# Impossible values. None of these may reach the volatility estimator.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "price"),
    [("zero", 0.0), ("negative", -79_000.0), ("nan", float("nan")), ("inf", float("inf"))],
)
def test_impossible_trade_prices_are_rejected(label: str, price: float) -> None:
    """A single zero price would make the log return negative infinity."""
    monitor, at = warmed_monitor()
    accepted, issues = monitor.check_trade(trade(price, f"bad-{label}", at))
    assert not accepted, f"a {label} price was accepted"
    assert any(i.kind == "invalid_price" for i in issues)


def test_negative_trade_size_is_rejected() -> None:
    monitor, at = warmed_monitor()
    accepted, issues = monitor.check_trade(trade(79_050.0, "neg-size", at, size=-1.0))
    assert not accepted
    assert any(i.kind == "invalid_size" for i in issues)


@pytest.mark.parametrize(
    ("label", "bid", "ask"),
    [
        ("crossed", 79_100.0, 79_000.0),
        ("locked", 79_000.0, 79_000.0),
        ("zero bid", 0.0, 79_000.0),
        ("negative ask", 79_000.0, -1.0),
    ],
)
def test_broken_quotes_are_rejected(label: str, bid: float, ask: float) -> None:
    """A crossed book produces a midpoint that is not a price."""
    monitor, at = warmed_monitor()
    accepted, issues = monitor.check_quote(quote(bid, ask, at))
    assert not accepted, f"a {label} quote was accepted"
    assert issues


def test_duplicate_trades_are_dropped_not_counted_twice() -> None:
    """A replayed message must not become a second observation."""
    monitor, at = warmed_monitor()
    first = trade(79_050.0, "dup-1", at)
    assert monitor.check_trade(first)[0]
    accepted, issues = monitor.check_trade(first)
    assert not accepted
    assert any(i.kind == "duplicate_trade" for i in issues)


def test_a_timestamp_that_goes_backwards_is_noticed() -> None:
    """Accepted — real venues do this — but never silently."""
    monitor, at = warmed_monitor()
    assert monitor.check_trade(trade(79_050.0, "fwd", at))[0]
    accepted, issues = monitor.check_trade(trade(79_051.0, "back", at - 30 * NS_PER_SECOND))
    kinds = {i.kind for i in issues}
    assert accepted or kinds, "an out-of-order trade was dropped without a word"
    if accepted:
        assert kinds, "an out-of-order trade was accepted silently"


# ---------------------------------------------------------------------------
# Staleness. The most dangerous failure, because nothing looks wrong.
# ---------------------------------------------------------------------------


def test_a_silent_feed_degrades_then_halts() -> None:
    """The ladder, walked one step at a time."""
    config = QualityConfig()
    monitor = QualityMonitor(config)
    base = now_ns()
    monitor.check_trade(trade(79_000.0, "t", base))
    monitor.check_quote(quote(78_999.0, 79_001.0, base))

    level, _ = monitor.staleness("BTC-USD", base)
    assert level is ServiceLevel.FULL

    level, issues = monitor.staleness("BTC-USD", base + config.quote_stale_halt_ns + NS_PER_SECOND)
    assert level is ServiceLevel.DEGRADED
    assert issues

    level, issues = monitor.staleness("BTC-USD", base + config.trade_stale_halt_ns + NS_PER_SECOND)
    assert level is ServiceLevel.STALE
    assert issues


def test_a_feed_that_never_started_is_down_not_full() -> None:
    """The empty case must not default to healthy."""
    level, issues = QualityMonitor().staleness("BTC-USD", now_ns())
    assert level is ServiceLevel.DOWN
    assert issues


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_an_open_but_silent_socket_is_detected_as_stale(tmp_path) -> None:
    """The socket stays up and the data stops. Health must not say 'connected, fine'.

    This is the failure that a naive `is_connected` check reports as healthy and
    that a clock catches immediately.
    """
    from forecaster.store import MarketRepository, open_database

    database = open_database(f"sqlite:///{tmp_path}/silent.db")
    async with CoinbaseConformanceVenue(rate_hz=400.0, faults=Faults(silent_after=30)) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=MarketRepository(database),
            quality_repo=None,
            symbols=("BTC-USD", "ETH-USD"),
            monitor=QualityMonitor(QualityConfig()),
        )
        with contextlib_suppress():
            await asyncio.wait_for(collector.run(max_events=40), timeout=25)
        await collector.close()

    # The socket never closed, so the provider still believes it is connected.
    # Freshness, not connectedness, is what the service level is built on.
    far_future = now_ns() + 10 * 60 * NS_PER_SECOND
    level, issues = collector.service_level("BTC-USD", far_future)
    assert level in (ServiceLevel.STALE, ServiceLevel.DOWN)
    assert issues, "a silent feed produced no quality issue"


def contextlib_suppress():
    import contextlib

    return contextlib.suppress(TimeoutError, asyncio.TimeoutError)


# ---------------------------------------------------------------------------
# Transport failures.
# ---------------------------------------------------------------------------


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_rest_timeout_does_not_wedge_the_provider() -> None:
    """A hung endpoint must surface as a reconnect, not as a hang."""
    async with CoinbaseConformanceVenue(faults=Faults(rest_timeout=True)) as venue:
        provider = CoinbaseProvider(
            ws_url=venue.ws_url, rest_url=venue.rest_url, transport="poll", poll_interval_s=0.05
        )

        async def pull() -> int:
            seen = 0
            async for _ in provider.stream(("BTC-USD",)):
                seen += 1
                if seen > 3:
                    break
            return seen

        with contextlib_suppress():
            await asyncio.wait_for(pull(), timeout=20)
        await provider.close()
    assert provider.health.reconnects >= 1
    assert provider.health.last_error is not None


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_malformed_messages_are_counted_and_the_stream_continues() -> None:
    """Half a JSON object must not end the feed."""
    async with CoinbaseConformanceVenue(rate_hz=400.0, faults=Faults(malformed_every=5)) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        seen = 0
        async for _ in provider.stream(("BTC-USD", "ETH-USD")):
            seen += 1
            if seen >= 120:
                break
        await provider.close()
    assert seen >= 120, "malformed frames stopped the stream"
    assert provider.health.malformed_messages > 0, "malformed frames were not counted"
    assert provider.health.reconnects == 0, "a malformed frame should not drop the connection"


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_venue_error_response_reconnects_rather_than_crashing() -> None:
    async with CoinbaseConformanceVenue(faults=Faults(rest_status=500)) as venue:
        provider = CoinbaseProvider(
            ws_url=venue.ws_url, rest_url=venue.rest_url, transport="poll", poll_interval_s=0.05
        )

        async def pull() -> None:
            async for _ in provider.stream(("BTC-USD",)):
                return

        with contextlib_suppress():
            await asyncio.wait_for(pull(), timeout=12)
        await provider.close()
    assert provider.health.reconnects >= 1
    assert provider.health.last_error is not None


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_the_collector_survives_a_dirty_feed_end_to_end(tmp_path) -> None:
    """Every fault at once. The collector must keep going and reject the bad data."""
    from forecaster.store import MarketRepository, QualityRepository, open_database

    database = open_database(f"sqlite:///{tmp_path}/dirty.db")
    faults = Faults(
        malformed_every=13,
        duplicate_every=7,
        reverse_time_every=11,
        crossed_book_every=9,
        zero_price_every=17,
        wide_spread_every=23,
    )
    async with CoinbaseConformanceVenue(rate_hz=600.0, faults=faults) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=MarketRepository(database),
            quality_repo=QualityRepository(database),
            symbols=("BTC-USD", "ETH-USD"),
            monitor=QualityMonitor(QualityConfig()),
        )
        with contextlib_suppress():
            await asyncio.wait_for(collector.run(max_events=400), timeout=40)
        await collector.close()

    stats = collector.stats
    assert stats.events >= 400, "the collector stopped early on a dirty feed"
    assert stats.rejected > 0, "a deliberately dirty feed produced no rejections"
    rejected = sum(
        int(collector.monitor.summary(symbol)["rejected"]) for symbol in ("BTC-USD", "ETH-USD")
    )
    assert rejected > 0
    # Whatever was accepted must be internally consistent: no impossible prices
    # reached storage.
    for symbol in ("BTC-USD", "ETH-USD"):
        window = collector.window(symbol, now_ns())
        prices = [t.price for t in window.trades]
        assert prices, f"{symbol} ended with no usable trades at all"
        assert all(p > 0.0 for p in prices), "an impossible price reached the window"
        quotes = [q for q in window.quotes if q.bid >= q.ask]
        assert not quotes, "a crossed quote reached the window"
