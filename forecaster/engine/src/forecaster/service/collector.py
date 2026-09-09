"""Ingesting market data.

The collector is the part that has to keep running. Everything else can be
restarted, retrained or rewritten; the data it gathers cannot be recovered after
the fact, because a five-minute-resolution history of the order book is not
something a venue will sell you later.

It does four things per event: check it, store it, fold it into the rolling
window the live forecast reads, and update the bars. Checking comes first — a
rejected trade never reaches the volatility estimator, because a single absurd
print dominates a realized-variance sum for as long as it stays in the window.

Writes are batched. One transaction per trade would make SQLite the bottleneck
at any realistic tick rate, and a crash losing the last half-second of ticks is
a far smaller problem than a collector that cannot keep up with the feed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from forecaster.clock import now_ns
from forecaster.features.window import MarketWindow, RollingWindowSource
from forecaster.marketdata.bars import BarAggregator
from forecaster.marketdata.provider import MarketDataProvider
from forecaster.marketdata.replay import CaptureWriter
from forecaster.quality import QualityMonitor
from forecaster.store import MarketRepository, QualityRepository
from forecaster.types import (
    NS_PER_SECOND,
    Bar,
    BookSnapshot,
    DataSource,
    Quote,
    ServiceLevel,
    Trade,
)

FLUSH_INTERVAL_NS = NS_PER_SECOND // 2
FLUSH_SIZE = 400


@dataclass
class CollectorStats:
    trades: int = 0
    quotes: int = 0
    books: int = 0
    bars: int = 0
    rejected: int = 0
    events: int = 0
    started_ns: int = field(default_factory=now_ns)
    last_event_ns: int | None = None

    def to_dict(self) -> dict[str, int | float | None]:
        return {
            "trades": self.trades,
            "quotes": self.quotes,
            "books": self.books,
            "bars": self.bars,
            "rejected": self.rejected,
            "events": self.events,
            "uptime_s": (now_ns() - self.started_ns) / NS_PER_SECOND,
            "last_event_ns": self.last_event_ns,
        }


class Collector:
    """Runs a provider, checks and stores what it produces."""

    def __init__(
        self,
        *,
        provider: MarketDataProvider,
        market_repo: MarketRepository,
        quality_repo: QualityRepository | None,
        symbols: tuple[str, ...],
        bar_resolutions_s: tuple[int, ...] = (1, 5, 15, 60, 300),
        monitor: QualityMonitor | None = None,
        capture: CaptureWriter | None = None,
        retention_ns: int | None = None,
    ) -> None:
        self.provider = provider
        self.market_repo = market_repo
        self.quality_repo = quality_repo
        self.symbols = symbols
        self.monitor = monitor or QualityMonitor()
        self.capture = capture
        self.stats = CollectorStats()
        self.aggregator = BarAggregator(bar_resolutions_s)
        window_kwargs = {"retention_ns": retention_ns} if retention_ns else {}
        self.windows = {
            symbol: RollingWindowSource(
                symbol=symbol,
                venue=provider.venue,
                data_source=provider.data_source,
                **window_kwargs,  # type: ignore[arg-type]
            )
            for symbol in symbols
        }
        self._trade_buffer: list[Trade] = []
        self._quote_buffer: list[Quote] = []
        self._bar_buffer: list[Bar] = []
        self._last_flush_ns = now_ns()
        self._running = False

    @property
    def data_source(self) -> DataSource:
        return self.provider.data_source

    def window(self, symbol: str, as_of_ns: int) -> MarketWindow:
        """The market as of an instant.

        Bars are sealed by the clock first. A bar whose interval ended before
        `as_of_ns` is complete whether or not another trade has arrived since,
        and leaving that to trade arrival makes the window depend on how busy the
        market happened to be rather than on what time it is.
        """
        for bar in self.aggregator.seal_through(as_of_ns):
            self._bar_buffer.append(bar)
            self.windows[bar.symbol].add_bar(bar)
            self.stats.bars += 1
        return self.windows[symbol].window(as_of_ns)

    def service_level(self, symbol: str, at_ns: int | None = None) -> tuple[ServiceLevel, list]:
        return self.monitor.staleness(symbol, at_ns if at_ns is not None else now_ns())

    def feed_age_ns(self, symbol: str, at_ns: int | None = None) -> int | None:
        state = self.monitor.state(symbol)
        if state.last_trade_ns is None:
            return None
        return (at_ns if at_ns is not None else now_ns()) - state.last_trade_ns

    # -- ingestion -----------------------------------------------------------

    def handle(self, event: Trade | Quote | BookSnapshot) -> None:
        """Process one event. Synchronous so the backtester can reuse it exactly."""
        self.stats.events += 1
        self.stats.last_event_ns = event.received_ns
        if self.capture is not None:
            self.capture.write(event)

        if isinstance(event, Trade):
            accepted, issues = self.monitor.check_trade(event)
            self._log(issues)
            if not accepted:
                self.stats.rejected += 1
                return
            self.stats.trades += 1
            self._trade_buffer.append(event)
            self.windows[event.symbol].add_trade(event)
            for bar in self.aggregator.add(event):
                self._bar_buffer.append(bar)
                self.windows[event.symbol].add_bar(bar)
                self.stats.bars += 1
        elif isinstance(event, Quote):
            accepted, issues = self.monitor.check_quote(event)
            self._log(issues)
            if not accepted:
                self.stats.rejected += 1
                return
            self.stats.quotes += 1
            self._quote_buffer.append(event)
            self.windows[event.symbol].add_quote(event)
        else:
            accepted, issues = self.monitor.check_book(event)
            self._log(issues)
            if not accepted:
                self.stats.rejected += 1
                return
            self.stats.books += 1
            self.windows[event.symbol].add_book(event)
            self.market_repo.insert_book(event, self.provider.venue, self.data_source)

    def _log(self, issues: list) -> None:
        if not issues or self.quality_repo is None:
            return
        for issue in issues:
            self.quality_repo.record(
                observed_ns=issue.observed_ns,
                venue=self.provider.venue,
                symbol=issue.symbol,
                kind=issue.kind,
                severity=issue.severity.value,
                detail=issue.detail,
            )

    def flush(self, force: bool = False) -> None:
        pending = len(self._trade_buffer) + len(self._quote_buffer) + len(self._bar_buffer)
        if pending == 0:
            return
        if (
            not force
            and pending < FLUSH_SIZE
            and now_ns() - self._last_flush_ns < FLUSH_INTERVAL_NS
        ):
            return
        if self._trade_buffer:
            self.market_repo.insert_trades(
                self._trade_buffer, self.provider.venue, self.data_source
            )
            self._trade_buffer.clear()
        if self._quote_buffer:
            self.market_repo.insert_quotes(
                self._quote_buffer, self.provider.venue, self.data_source
            )
            self._quote_buffer.clear()
        if self._bar_buffer:
            self.market_repo.upsert_bars(self._bar_buffer, self.provider.venue, self.data_source)
            self._bar_buffer.clear()
        self._last_flush_ns = now_ns()

    async def run(self, *, max_events: int | None = None) -> CollectorStats:
        """Consume the provider until it stops or the limit is reached."""
        self._running = True
        try:
            async for event in self.provider.stream(self.symbols):
                self.handle(event)
                self.flush()
                if max_events is not None and self.stats.events >= max_events:
                    break
                if not self._running:
                    break
        finally:
            for bar in self.aggregator.flush_all():
                self._bar_buffer.append(bar)
            self.flush(force=True)
            self._running = False
        return self.stats

    def stop(self) -> None:
        self._running = False

    async def close(self) -> None:
        self.stop()
        await self.provider.close()
        if self.capture is not None:
            self.capture.close()
