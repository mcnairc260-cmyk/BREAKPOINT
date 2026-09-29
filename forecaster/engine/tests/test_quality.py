"""Data-quality checks, including the failure they were caught by.

The anomaly filter had a runaway: a rejected trade left the reference price
behind, so the next trade was measured from a stale price and looked just as
extreme, and the filter discarded the rest of the feed in silence. A real
eighty-hour run threw away 17.6% of all trades that way — and nothing anywhere
said so except a rejection count nobody was watching.

These tests exist so that cannot come back.
"""

from __future__ import annotations

import asyncio

from forecaster.config import QualityConfig
from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
from forecaster.quality import QualityMonitor, Severity, service_level_for
from forecaster.service.collector import Collector
from forecaster.store import MarketRepository, QualityRepository, open_database
from forecaster.types import (
    NS_PER_SECOND,
    BookLevel,
    BookSnapshot,
    Quote,
    ServiceLevel,
    Side,
    Trade,
)


def trade(price: float, index: int, *, symbol: str = "BTC-USD") -> Trade:
    ns = index * NS_PER_SECOND
    return Trade(
        exchange_ns=ns,
        received_ns=ns,
        symbol=symbol,
        price=price,
        size=0.1,
        side=Side.BUY,
        trade_id=f"t{index}",
    )


def quote(bid: float, ask: float, index: int = 1) -> Quote:
    ns = index * NS_PER_SECOND
    return Quote(
        exchange_ns=ns,
        received_ns=ns,
        symbol="BTC-USD",
        bid=bid,
        bid_size=1.0,
        ask=ask,
        ask_size=1.0,
    )


def warm(monitor: QualityMonitor, ticks: int = 200) -> None:
    """Feed normal, bouncing prices so the scale estimate settles."""
    for i in range(ticks):
        monitor.check_trade(trade(79_000 + (i % 9) * 0.5, i))


class TestAnomalyFilterDoesNotRunAway:
    """The regression that motivated this file."""

    def test_ordinary_moves_are_not_rejected(self) -> None:
        """Bid-ask bounce makes the robust scale tiny.

        A 0.05% move is then "50 sigma" without being unusual at all. Before the
        absolute floor was added, that alone was enough to start rejecting.
        """
        monitor = QualityMonitor()
        warm(monitor)
        accepted = 0
        for i in range(200, 400):
            # A steady drift of a few basis points per tick — entirely normal.
            price = 79_000 * (1.0 + 0.0003 * (i - 200) / 200) + (i % 7) * 0.5
            if monitor.check_trade(trade(price, i))[0]:
                accepted += 1
        assert accepted == 200, f"{200 - accepted} ordinary trades were rejected"

    def test_the_filter_resynchronises_instead_of_discarding_the_feed(self) -> None:
        """A sustained real move must not silence the feed forever.

        This is the exact shape of the original bug: the market genuinely jumps,
        the first print is rejected, the reference price stays behind, and every
        subsequent print looks equally extreme.
        """
        monitor = QualityMonitor()
        warm(monitor)
        # A genuine 3% jump, then trading continues at the new level.
        accepted = 0
        for i in range(200, 260):
            price = 81_400 + (i % 7) * 0.5
            if monitor.check_trade(trade(price, i))[0]:
                accepted += 1
        assert accepted >= 55, (
            f"only {accepted}/60 trades accepted after a real jump — "
            "the filter is discarding the feed instead of resynchronising"
        )
        assert monitor.state("BTC-USD").resync_count >= 1, "no resync was recorded"

    def test_the_resync_raises_an_alarm_rather_than_passing_silently(self) -> None:
        monitor = QualityMonitor()
        warm(monitor)
        for i in range(200, 240):
            monitor.check_trade(trade(81_400 + (i % 5) * 0.5, i))
        kinds = {issue.kind for issue in monitor.issues}
        assert "anomaly_filter_resync" in kinds
        resync = next(i for i in monitor.issues if i.kind == "anomaly_filter_resync")
        assert resync.severity is Severity.WARNING
        assert "resynchronising" in resync.detail

    def test_a_genuine_bad_print_is_still_rejected(self) -> None:
        """The filter must still do its job."""
        monitor = QualityMonitor()
        warm(monitor)
        accepted, issues = monitor.check_trade(trade(91_000.0, 999))
        assert accepted is False
        assert issues[0].kind == "price_anomaly"

    def test_a_realistic_feed_loses_essentially_nothing(self) -> None:
        """The end-to-end version of the same check.

        Four hours of ordinary simulated market must pass through the quality
        layer intact. The original bug showed up here as a 17.6% rejection rate.
        """
        database = open_database("sqlite:///:memory:")
        try:
            provider = SimulatedProvider(
                symbols=("BTC-USD", "ETH-USD"),
                seed=4242,
                params=SimulatorParams.for_regime(Regime.REALISTIC),
                duration_s=14_400,
                start_ns=0,
                realtime=False,
            )
            collector = Collector(
                provider=provider,
                market_repo=MarketRepository(database),
                quality_repo=QualityRepository(database),
                symbols=("BTC-USD", "ETH-USD"),
            )
            asyncio.run(collector.run())
            total = collector.stats.trades + collector.stats.rejected
            assert total > 50_000
            rate = collector.stats.rejected / total
            assert rate < 0.001, f"{rate:.2%} of a clean feed was rejected"
        finally:
            database.dispose()


class TestDuplicatesAndOrdering:
    def test_a_repeated_trade_id_is_dropped(self) -> None:
        monitor = QualityMonitor()
        assert monitor.check_trade(trade(79_000.0, 1))[0] is True
        accepted, issues = monitor.check_trade(trade(79_000.0, 1))
        assert accepted is False
        assert issues[0].kind == "duplicate_trade"

    def test_a_slightly_out_of_order_trade_is_kept_but_noted(self) -> None:
        """Brief reordering is normal on a busy feed.

        Dropping it would understate volume, and the bar aggregator places it
        correctly by exchange time anyway — so it is accepted and counted.
        """
        monitor = QualityMonitor()
        monitor.check_trade(trade(79_000.0, 10))
        accepted, issues = monitor.check_trade(trade(79_000.5, 9))
        assert accepted is True
        assert any(issue.kind == "out_of_order" for issue in issues)


class TestQuotes:
    def test_a_crossed_quote_is_rejected(self) -> None:
        monitor = QualityMonitor()
        accepted, issues = monitor.check_quote(quote(bid=79_010.0, ask=79_000.0))
        assert accepted is False
        assert issues[0].kind == "crossed_quote"

    def test_a_non_positive_quote_is_rejected(self) -> None:
        monitor = QualityMonitor()
        assert monitor.check_quote(quote(bid=0.0, ask=79_000.0))[0] is False

    def test_an_implausibly_wide_spread_is_flagged_but_kept(self) -> None:
        monitor = QualityMonitor()
        accepted, issues = monitor.check_quote(quote(bid=78_000.0, ask=79_500.0))
        assert accepted is True
        assert issues[0].kind == "wide_spread"


class TestStalenessLadder:
    def test_the_ladder_descends_as_the_feed_ages(self) -> None:
        monitor = QualityMonitor(QualityConfig())
        assert monitor.staleness("BTC-USD", 0)[0] is ServiceLevel.DOWN  # nothing seen

        monitor.check_trade(trade(79_000.0, 100))
        monitor.check_quote(quote(78_999.0, 79_001.0, index=100))
        base = 100 * NS_PER_SECOND

        assert monitor.staleness("BTC-USD", base + NS_PER_SECOND)[0] is ServiceLevel.FULL
        assert monitor.staleness("BTC-USD", base + 10 * NS_PER_SECOND)[0] is ServiceLevel.DEGRADED
        assert monitor.staleness("BTC-USD", base + 200 * NS_PER_SECOND)[0] is ServiceLevel.STALE

    def test_the_worst_level_across_symbols_wins(self) -> None:
        """Degradation is never averaged away."""
        assert service_level_for([ServiceLevel.FULL, ServiceLevel.STALE]) is ServiceLevel.STALE
        assert (
            service_level_for([ServiceLevel.FULL, ServiceLevel.DEGRADED]) is ServiceLevel.DEGRADED
        )
        assert service_level_for([ServiceLevel.FULL, ServiceLevel.FULL]) is ServiceLevel.FULL


class TestBooks:
    def test_a_crossed_book_is_rejected(self) -> None:
        monitor = QualityMonitor()
        book = BookSnapshot(
            exchange_ns=1,
            received_ns=1,
            symbol="BTC-USD",
            bids=(BookLevel(79_010.0, 1.0),),
            asks=(BookLevel(79_000.0, 1.0),),
        )
        accepted, issues = monitor.check_book(book)
        assert accepted is False
        assert issues[0].kind == "crossed_book"

    def test_a_one_sided_book_is_rejected(self) -> None:
        monitor = QualityMonitor()
        book = BookSnapshot(
            exchange_ns=1,
            received_ns=1,
            symbol="BTC-USD",
            bids=(BookLevel(79_000.0, 1.0),),
            asks=(),
        )
        assert monitor.check_book(book)[0] is False
