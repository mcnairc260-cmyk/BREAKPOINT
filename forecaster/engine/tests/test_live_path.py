"""The live data path, end to end, over a real socket.

Every other test in this repository feeds the system events constructed in
Python. These tests do not: they start a server that speaks Coinbase's wire
protocol on `127.0.0.1`, point the unmodified production adapter at it, and
exercise the whole path — TCP connect, WebSocket handshake, subscribe frame,
JSON off the wire, parse, quality check, store, window, forecast, expire,
resolve.

Sockets are enabled **only for localhost**. That is a stronger guarantee than
switching the block off: a test that claims the adapter connected cannot have
connected to a real exchange, because a real exchange is still unreachable.

What is deliberately NOT claimed here: that Coinbase emits these shapes today.
These tests prove the client. `forecaster live-check` is the only thing that can
prove the server, and it needs a network this repository's build environment does
not have.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from forecaster.marketdata.conformance import CoinbaseConformanceVenue, Faults
from forecaster.marketdata.venues.coinbase import CoinbaseProvider
from forecaster.marketdata.venues.endpoints import (
    classify_endpoint,
    host_of,
    is_real_venue,
)
from forecaster.service.livecheck import live_check, run_checks
from forecaster.types import BookSnapshot, DataSource, Quote, Side, Trade

localhost_only = [
    pytest.mark.enable_socket,
    pytest.mark.allow_hosts(["127.0.0.1", "::1"]),
]


# ---------------------------------------------------------------------------
# The provenance guard. No socket needed, and the most important test here.
# ---------------------------------------------------------------------------


def test_real_venue_hosts_are_labelled_live() -> None:
    assert CoinbaseProvider().data_source is DataSource.LIVE
    assert classify_endpoint("coinbase", "wss://ws-feed.exchange.coinbase.com") is DataSource.LIVE


def test_anything_else_can_never_be_labelled_live() -> None:
    """The single check that keeps the track record meaningful."""
    for url in (
        "ws://127.0.0.1:9001",
        "wss://localhost:443",
        # A host that merely contains the venue's name. A suffix or substring
        # match would pass this and must not.
        "wss://ws-feed.exchange.coinbase.com.attacker.example",
        "wss://evil-coinbase.com",
        "wss://coinbase.com.evil.net/ws",
    ):
        assert classify_endpoint("coinbase", url) is DataSource.SIMULATED, url


def test_one_real_url_cannot_launder_another() -> None:
    """Trades from the venue and the book from elsewhere is not venue data."""
    provider = CoinbaseProvider(rest_url="http://127.0.0.1:9002")
    assert provider.data_source is DataSource.SIMULATED
    assert not is_real_venue(
        "coinbase", "wss://ws-feed.exchange.coinbase.com", "http://127.0.0.1:9002"
    )


def test_host_parsing_strips_ports_and_case() -> None:
    assert host_of("wss://WS-FEED.Exchange.Coinbase.COM:443/x") == "ws-feed.exchange.coinbase.com"
    assert host_of("not a url") == ""


def test_unknown_venue_is_never_live() -> None:
    assert classify_endpoint("nasdaq", "https://api.exchange.coinbase.com") is DataSource.SIMULATED


# ---------------------------------------------------------------------------
# The adapter against a server, over a real socket.
# ---------------------------------------------------------------------------


async def _drain(provider: CoinbaseProvider, symbols: tuple[str, ...], limit: int) -> list:
    events: list = []
    async for event in provider.stream(symbols):
        events.append(event)
        if len(events) >= limit:
            break
    await provider.close()
    return events


@pytest.mark.parametrize("transport", ["websocket", "poll"])
@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_adapter_reads_a_real_socket(transport: str) -> None:
    """Connect, subscribe, parse. The code path fixtures never reach."""
    async with CoinbaseConformanceVenue(rate_hz=400.0) as venue:
        provider = CoinbaseProvider(
            ws_url=venue.ws_url,
            rest_url=venue.rest_url,
            transport=transport,
            poll_interval_s=0.05,
        )
        events = await asyncio.wait_for(_drain(provider, ("BTC-USD", "ETH-USD"), 120), timeout=30)

    trades = [e for e in events if isinstance(e, Trade)]
    quotes = [e for e in events if isinstance(e, Quote)]
    assert trades, "no trades parsed off the wire"
    assert quotes, "no quotes parsed off the wire"
    assert {t.symbol for t in trades} <= {"BTC-USD", "ETH-USD"}
    assert all(t.price > 0 for t in trades)
    assert all(q.ask > q.bid > 0 for q in quotes)
    # Dual timestamps, both populated, receipt at or after the exchange stamp.
    assert all(t.received_ns >= t.exchange_ns for t in trades)


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_maker_side_is_inverted_to_the_aggressor() -> None:
    """Coinbase publishes the maker's side. Reading it raw inverts order flow.

    The harness emits the venue's convention, so an adapter that forgot to invert
    would produce a one-sided distribution here and fail.
    """
    async with CoinbaseConformanceVenue(rate_hz=400.0, seed=11) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        events = await asyncio.wait_for(_drain(provider, ("BTC-USD",), 200), timeout=30)
    sides = [e.side for e in events if isinstance(e, Trade)]
    assert sides
    assert Side.BUY in sides and Side.SELL in sides
    assert Side.UNKNOWN not in sides


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_order_book_is_built_from_snapshot_and_deltas() -> None:
    async with CoinbaseConformanceVenue(rate_hz=400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        events = await asyncio.wait_for(_drain(provider, ("BTC-USD", "ETH-USD"), 150), timeout=30)
    books = [e for e in events if isinstance(e, BookSnapshot)]
    assert books, "no book snapshot produced"
    for book in books:
        assert book.bids and book.asks
        assert book.bids[0].price < book.asks[0].price


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_reconnects_after_the_feed_drops() -> None:
    """A dropped socket must be reconnected, not treated as end of stream."""
    async with CoinbaseConformanceVenue(rate_hz=400.0, faults=Faults(drop_after=40)) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        events = await asyncio.wait_for(_drain(provider, ("BTC-USD", "ETH-USD"), 150), timeout=40)
        assert provider.health.reconnects >= 1
        assert venue.connections >= 2, "the adapter did not reconnect"
    assert len(events) >= 150


# ---------------------------------------------------------------------------
# Live price correctness (§3), against the same checks the user runs live.
# ---------------------------------------------------------------------------


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_live_check_passes_on_a_well_behaved_feed() -> None:
    async with CoinbaseConformanceVenue(rate_hz=200.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        report = await live_check(
            provider,
            symbols=("BTC-USD", "ETH-USD"),
            seconds=4.0,
            ws_url=venue.ws_url,
            rest_url=venue.rest_url,
        )
    assert report.ok, [f"{c.name}: {c.detail}" for c in report.failures]
    assert report.data_source == DataSource.SIMULATED.value
    for symbol in ("BTC-USD", "ETH-USD"):
        data = report.symbols[symbol]
        assert data["trades"] > 0 and data["quotes"] > 0
        assert data["bid"] < data["midpoint"] < data["ask"]
        assert 0.0 < data["spread_bps"] < 100.0


@pytest.mark.parametrize(
    ("faults", "expect_substring"),
    [
        (Faults(crossed_book_every=6), "not crossed"),
        (Faults(zero_price_every=7), "price"),
        (Faults(negative_price_every=7), "price"),
        (Faults(wide_spread_every=5), "spread"),
        (Faults(drop_quotes=True), "quotes received"),
    ],
)
@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_live_check_fails_loudly_on_a_bad_feed(faults: Faults, expect_substring: str) -> None:
    """Every one of these would otherwise produce a confident, wrong forecast."""
    async with CoinbaseConformanceVenue(rate_hz=200.0, faults=faults) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        report = await live_check(
            provider,
            symbols=("BTC-USD", "ETH-USD"),
            seconds=4.0,
            ws_url=venue.ws_url,
            rest_url=venue.rest_url,
        )
    assert not report.ok, "a broken feed was reported as healthy"
    assert any(expect_substring in c.name for c in report.failures), [
        c.name for c in report.failures
    ]


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_live_check_reports_an_unreachable_endpoint_rather_than_hanging() -> None:
    """The failure mode the user will actually hit if a venue is blocked."""
    provider = CoinbaseProvider(ws_url="ws://127.0.0.1:1", rest_url="http://127.0.0.1:1")
    report = await asyncio.wait_for(
        live_check(provider, symbols=("BTC-USD",), seconds=1.0, ws_url="ws://127.0.0.1:1"),
        timeout=40,
    )
    assert not report.ok
    assert report.error is not None
    assert report.events == 0


def test_check_list_is_pure_and_flags_missing_data() -> None:
    """Every symbol asked about is answered for, even one that never appeared."""
    checks = run_checks({}, requested=("BTC-USD",), transport="websocket")
    assert checks
    assert any(c.failed for c in checks)


# ---------------------------------------------------------------------------
# Provider lifecycle. The bug that cost a twenty-two-minute proof run.
# ---------------------------------------------------------------------------


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_closed_provider_yields_nothing_and_says_so() -> None:
    """Closing a provider is permanent, and anything reusing one gets silence.

    `live_check` closes the feed it samples. The live proof then handed that same
    object to its collector, which dutifully streamed nothing for twenty-two
    minutes and reported "service level down" — a failure indistinguishable from
    a dead venue, and one that would have cost an hour to find against a real
    exchange rather than a local server.

    The behaviour itself is correct: `close()` means closed. What was wrong was
    the assumption that a provider could be used twice. This pins the behaviour
    so the assumption cannot quietly come back.
    """
    async with CoinbaseConformanceVenue(rate_hz=400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        first = await asyncio.wait_for(_drain(provider, ("BTC-USD",), 20), timeout=30)
        assert len(first) == 20, "the first use should work normally"

        # `_drain` closed it. A second pass must end immediately, not hang and
        # not reconnect.
        second: list = []

        async def reuse() -> None:
            async for event in provider.stream(("BTC-USD",)):
                second.append(event)

        await asyncio.wait_for(reuse(), timeout=10)
        assert second == [], "a closed provider produced events"

        # A fresh provider against the same venue works, which is the fix.
        replacement = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        third = await asyncio.wait_for(_drain(replacement, ("BTC-USD",), 20), timeout=30)
        assert len(third) == 20, "a new provider on the same venue must work"


# ---------------------------------------------------------------------------
# Frame size. The bug that only a real order book could expose.
# ---------------------------------------------------------------------------


def test_the_frame_limit_is_large_enough_for_a_real_order_book() -> None:
    """A real level2 snapshot is bigger than the library's 1 MiB default.

    Coinbase opens the `level2_batch` channel by sending the entire book for each
    product. The websockets default rejected that frame, closed with code 1009
    "message too big", reconnected, resubscribed, and was sent the same oversized
    snapshot again — 6,177 times in 72 minutes on the first live run, while still
    passing enough trades and quotes between reconnects to look healthy.

    No fixture could have caught it. Fixtures are small because someone typed
    them; only a venue sends a real book. So the constant is pinned here instead,
    with the default it must exceed.
    """
    from websockets.asyncio.client import connect as ws_connect

    from forecaster.marketdata.venues import binance, coinbase, kraken

    library_default = inspect.signature(ws_connect).parameters["max_size"].default
    assert library_default == 1024 * 1024, "the library default moved; re-check this reasoning"

    for module in (coinbase, kraken, binance):
        limit = module.MAX_FRAME_BYTES
        assert limit > library_default, f"{module.__name__} would reject a real book snapshot"
        assert limit >= 16 * 1024 * 1024, f"{module.__name__}: too tight for a busy book"
        # Bounded, not None: an unlimited frame size removes the only defence
        # against a feed that misbehaves.
        assert limit is not None and limit <= 64 * 1024 * 1024


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_frame_larger_than_the_default_is_accepted() -> None:
    """Asserted end to end over a socket, not just as a constant.

    The harness sends a book snapshot padded past 1 MiB. Before the fix this
    closed the connection; it must now be parsed like any other frame.
    """
    venue = CoinbaseConformanceVenue(rate_hz=200.0)
    venue.book_padding_levels = 40_000  # ~1.5 MiB of price levels
    async with venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        events = await asyncio.wait_for(_drain(provider, ("BTC-USD",), 40), timeout=40)
    assert len(events) == 40, "an oversized frame broke the stream"
    assert provider.health.reconnects == 0, "an oversized frame caused a reconnect"
