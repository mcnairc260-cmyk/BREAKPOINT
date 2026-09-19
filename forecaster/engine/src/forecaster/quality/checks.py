"""Catching bad data before it becomes a confident wrong answer.

The failure this guards against is specific. A feed does not usually break
loudly — it goes quiet, or repeats itself, or emits one absurd print. The
forecaster keeps working, produces plausible-looking numbers, and is wrong. Every
check here exists to turn a silent failure into a visible one.

The rule throughout: **a bad feed reduces what the system claims**. It never
produces a number from data it does not trust.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from enum import StrEnum

from forecaster.config import QualityConfig
from forecaster.types import NS_PER_SECOND, BookSnapshot, Quote, ServiceLevel, Trade


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass(frozen=True)
class QualityIssue:
    kind: str
    severity: Severity
    detail: str
    observed_ns: int
    symbol: str | None = None


@dataclass
class SymbolQualityState:
    last_trade_ns: int | None = None
    last_quote_ns: int | None = None
    last_price: float | None = None
    recent_returns: deque[float] = field(default_factory=lambda: deque(maxlen=600))
    seen_trade_ids: deque[str] = field(default_factory=lambda: deque(maxlen=5_000))
    seen_trade_set: set[str] = field(default_factory=set)
    duplicate_count: int = 0
    out_of_order_count: int = 0
    anomaly_count: int = 0
    crossed_book_count: int = 0
    rejected_count: int = 0
    consecutive_rejections: int = 0
    resync_count: int = 0


class QualityMonitor:
    """Inspects every event and reports what is wrong.

    Stateful per symbol, because most of these checks are about the relationship
    between an event and the ones before it. A single trade is almost never
    detectably bad in isolation.
    """

    def __init__(self, config: QualityConfig | None = None) -> None:
        self.config = config or QualityConfig()
        self._state: dict[str, SymbolQualityState] = {}
        self.issues: list[QualityIssue] = []

    def state(self, symbol: str) -> SymbolQualityState:
        if symbol not in self._state:
            self._state[symbol] = SymbolQualityState()
        return self._state[symbol]

    def _record(self, issue: QualityIssue) -> None:
        self.issues.append(issue)
        if len(self.issues) > 2_000:
            del self.issues[:1_000]

    # -- per-event checks ----------------------------------------------------

    def check_trade(self, trade: Trade) -> tuple[bool, list[QualityIssue]]:
        """Returns (accept, issues).

        A rejected trade is not stored and does not reach the volatility
        estimator. Rejecting good data costs a little precision; accepting a
        garbage print costs a wrong forecast for the next hour, because one
        absurd return dominates a realized-variance sum for as long as it stays
        in the window.
        """
        state = self.state(trade.symbol)
        found: list[QualityIssue] = []
        accept = True

        if trade.price <= 0.0 or not math.isfinite(trade.price):
            found.append(
                QualityIssue(
                    "invalid_price",
                    Severity.CRITICAL,
                    f"price {trade.price}",
                    trade.received_ns,
                    trade.symbol,
                )
            )
            accept = False
        if trade.size < 0.0 or not math.isfinite(trade.size):
            found.append(
                QualityIssue(
                    "invalid_size",
                    Severity.CRITICAL,
                    f"size {trade.size}",
                    trade.received_ns,
                    trade.symbol,
                )
            )
            accept = False

        if accept and trade.trade_id and trade.trade_id in state.seen_trade_set:
            state.duplicate_count += 1
            found.append(
                QualityIssue(
                    "duplicate_trade",
                    Severity.WARNING,
                    f"trade id {trade.trade_id}",
                    trade.received_ns,
                    trade.symbol,
                )
            )
            accept = False

        if accept and state.last_trade_ns is not None and trade.exchange_ns < state.last_trade_ns:
            state.out_of_order_count += 1
            lag_ms = (state.last_trade_ns - trade.exchange_ns) / 1e6
            found.append(
                QualityIssue(
                    "out_of_order",
                    Severity.WARNING,
                    f"{lag_ms:.0f}ms behind",
                    trade.received_ns,
                    trade.symbol,
                )
            )
            # Accepted anyway: brief reordering is normal on a busy feed, the bar
            # aggregator places it correctly by exchange time, and dropping it
            # would understate volume.

        if accept and state.last_price is not None and state.last_price > 0.0:
            ret = math.log(trade.price / state.last_price)
            sigma = self._recent_sigma(state)
            # The return always feeds the volatility estimate, even when the
            # trade is rejected. Feeding it only accepted returns lets the
            # estimate collapse toward the quiet regime, after which every
            # ordinary move looks like an anomaly.
            state.recent_returns.append(ret)

            # Two conditions, both required. The sigma test alone is not enough:
            # at one-second resolution most of the measured variation is bid-ask
            # bounce, so sigma is tiny and an ordinary move can be dozens of
            # "sigmas" without being unusual at all. The absolute floor stops the
            # filter firing on moves that are simply normal.
            unusual = sigma > 0.0 and abs(ret) > self.config.max_return_sigma * sigma
            large = abs(ret) > self.config.min_anomaly_return

            if unusual and large:
                state.consecutive_rejections += 1
                # The circuit breaker. A rejected trade leaves the reference
                # price behind, so the NEXT trade is measured from a stale price
                # and looks just as extreme — and the filter rejects the entire
                # rest of the feed, silently, forever. This was observed: a real
                # run discarded 17% of all trades that way.
                #
                # So a filter that rejects repeatedly is treated as wrong about
                # the market rather than the market being wrong. It resynchronises
                # to the current price and raises an alarm, because failing open
                # and saying so beats failing closed in silence.
                if state.consecutive_rejections >= self.config.max_consecutive_rejections:
                    state.resync_count += 1
                    state.consecutive_rejections = 0
                    found.append(
                        QualityIssue(
                            "anomaly_filter_resync",
                            Severity.WARNING,
                            f"{self.config.max_consecutive_rejections} consecutive rejections "
                            f"at {trade.price}; resynchronising rather than discarding the feed",
                            trade.received_ns,
                            trade.symbol,
                        )
                    )
                else:
                    state.anomaly_count += 1
                    found.append(
                        QualityIssue(
                            "price_anomaly",
                            Severity.CRITICAL,
                            f"{abs(ret) / sigma:.0f} sigma move ({abs(ret) * 100:.2f}%) "
                            f"to {trade.price}",
                            trade.received_ns,
                            trade.symbol,
                        )
                    )
                    accept = False
            else:
                state.consecutive_rejections = 0

        if accept:
            state.last_trade_ns = max(state.last_trade_ns or 0, trade.exchange_ns)
            state.last_price = trade.price
            if trade.trade_id:
                if len(state.seen_trade_ids) == state.seen_trade_ids.maxlen:
                    state.seen_trade_set.discard(state.seen_trade_ids[0])
                state.seen_trade_ids.append(trade.trade_id)
                state.seen_trade_set.add(trade.trade_id)
        else:
            state.rejected_count += 1

        for issue in found:
            self._record(issue)
        return accept, found

    def _recent_sigma(self, state: SymbolQualityState) -> float:
        """A robust scale estimate for recent returns.

        Median absolute deviation rather than the standard deviation. A handful
        of genuine large moves inflate a standard deviation enough to hide the
        next real anomaly, and a run of quiet ticks shrinks it enough to reject
        ordinary ones. The MAD does neither.
        """
        if len(state.recent_returns) < 30:
            return 0.0
        values = sorted(abs(v) for v in state.recent_returns)
        median_abs = values[len(values) // 2]
        # 1.4826 rescales the MAD to a standard deviation for Gaussian data.
        return 1.4826 * median_abs

    def check_quote(self, quote: Quote) -> tuple[bool, list[QualityIssue]]:
        state = self.state(quote.symbol)
        found: list[QualityIssue] = []
        accept = True

        if quote.bid <= 0.0 or quote.ask <= 0.0:
            found.append(
                QualityIssue(
                    "invalid_quote",
                    Severity.CRITICAL,
                    "non-positive bid or ask",
                    quote.received_ns,
                    quote.symbol,
                )
            )
            accept = False
        elif quote.bid >= quote.ask:
            state.crossed_book_count += 1
            found.append(
                QualityIssue(
                    "crossed_quote",
                    Severity.CRITICAL,
                    f"bid {quote.bid} at or above ask {quote.ask}",
                    quote.received_ns,
                    quote.symbol,
                )
            )
            accept = False
        elif quote.mid > 0.0 and quote.spread / quote.mid > self.config.max_relative_spread:
            found.append(
                QualityIssue(
                    "wide_spread",
                    Severity.WARNING,
                    f"spread {quote.spread / quote.mid * 100:.2f}% of mid",
                    quote.received_ns,
                    quote.symbol,
                )
            )

        if accept:
            state.last_quote_ns = quote.received_ns
        else:
            state.rejected_count += 1

        for issue in found:
            self._record(issue)
        return accept, found

    def check_book(self, book: BookSnapshot) -> tuple[bool, list[QualityIssue]]:
        found: list[QualityIssue] = []
        if book.is_crossed:
            self.state(book.symbol).crossed_book_count += 1
            found.append(
                QualityIssue(
                    "crossed_book",
                    Severity.CRITICAL,
                    "best bid at or above best ask",
                    book.received_ns,
                    book.symbol,
                )
            )
            for issue in found:
                self._record(issue)
            return False, found
        if not book.bids or not book.asks:
            found.append(
                QualityIssue(
                    "empty_book",
                    Severity.WARNING,
                    "one side of the book is empty",
                    book.received_ns,
                    book.symbol,
                )
            )
            for issue in found:
                self._record(issue)
            return False, found
        return True, found

    # -- staleness -----------------------------------------------------------

    def staleness(self, symbol: str, now_ns: int) -> tuple[ServiceLevel, list[QualityIssue]]:
        """The check that catches an open but silent socket."""
        state = self.state(symbol)
        found: list[QualityIssue] = []

        if state.last_trade_ns is None:
            return ServiceLevel.DOWN, [
                QualityIssue("no_data", Severity.CRITICAL, "no trades seen", now_ns, symbol)
            ]

        trade_age = now_ns - state.last_trade_ns
        quote_age = now_ns - state.last_quote_ns if state.last_quote_ns else None

        if trade_age > self.config.trade_stale_halt_ns:
            found.append(
                QualityIssue(
                    "trade_feed_stale",
                    Severity.CRITICAL,
                    f"no trade for {trade_age / NS_PER_SECOND:.0f}s",
                    now_ns,
                    symbol,
                )
            )
            for issue in found:
                self._record(issue)
            return ServiceLevel.STALE, found

        if quote_age is not None and quote_age > self.config.quote_stale_halt_ns:
            found.append(
                QualityIssue(
                    "quote_feed_stale",
                    Severity.CRITICAL,
                    f"no quote for {quote_age / NS_PER_SECOND:.0f}s",
                    now_ns,
                    symbol,
                )
            )
            for issue in found:
                self._record(issue)
            return ServiceLevel.DEGRADED, found

        if quote_age is not None and quote_age > self.config.quote_stale_degraded_ns:
            found.append(
                QualityIssue(
                    "quote_lagging",
                    Severity.WARNING,
                    f"top of book {quote_age / NS_PER_SECOND:.1f}s old",
                    now_ns,
                    symbol,
                )
            )
            for issue in found:
                self._record(issue)
            return ServiceLevel.DEGRADED, found

        return ServiceLevel.FULL, found

    def summary(self, symbol: str) -> dict[str, int]:
        state = self.state(symbol)
        return {
            "duplicates": state.duplicate_count,
            "out_of_order": state.out_of_order_count,
            "anomalies": state.anomaly_count,
            "crossed_books": state.crossed_book_count,
            "rejected": state.rejected_count,
            "filter_resyncs": state.resync_count,
        }


def service_level_for(levels: list[ServiceLevel]) -> ServiceLevel:
    """The worst level across symbols. Degradation is never averaged away."""
    order = [ServiceLevel.DOWN, ServiceLevel.STALE, ServiceLevel.DEGRADED, ServiceLevel.FULL]
    for level in order:
        if level in levels:
            return level
    return ServiceLevel.DOWN
