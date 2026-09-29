"""Turning a stream of trades into bars.

Bars are built once, incrementally, from the same trade stream the live system
sees, and are what every volatility feature reads. Deriving them twice — once for
training and once for serving — is the classic way a forecasting system ends up
training on one thing and predicting from another.

A bar is stamped with its **opening** timestamp and is only complete once the
clock has passed its end. `closed_bars` never returns the bar currently being
filled, because a partially filled bar looks like a low-volume bar and would
teach a volatility model something false about the present moment.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import pairwise

from forecaster.clock import floor_ns
from forecaster.types import NS_PER_SECOND, Bar, Side, Trade


@dataclass
class _Building:
    open_ns: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    buy_volume: float = 0.0
    sell_volume: float = 0.0
    trade_count: int = 0
    notional: float = 0.0

    def add(self, trade: Trade) -> None:
        self.high = max(self.high, trade.price)
        self.low = min(self.low, trade.price)
        self.close = trade.price
        self.volume += trade.size
        self.trade_count += 1
        self.notional += trade.price * trade.size
        if trade.side is Side.BUY:
            self.buy_volume += trade.size
        elif trade.side is Side.SELL:
            self.sell_volume += trade.size

    def finish(self, symbol: str, resolution_s: int) -> Bar:
        return Bar(
            open_ns=self.open_ns,
            resolution_s=resolution_s,
            symbol=symbol,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            buy_volume=self.buy_volume,
            sell_volume=self.sell_volume,
            trade_count=self.trade_count,
            vwap=(self.notional / self.volume) if self.volume > 0 else self.close,
        )


class BarAggregator:
    """Builds bars at several resolutions from one pass over the trades.

    Uses **exchange time** to decide which bar a trade belongs to, because a bar
    labelled 18:42 should contain the trades the venue stamped 18:42. Feature
    windows still close on receipt time; the two clocks are kept apart
    deliberately (see `clock.py`).
    """

    def __init__(self, resolutions_s: tuple[int, ...] = (1, 5, 15, 60, 300)) -> None:
        self.resolutions_s = tuple(sorted(resolutions_s))
        self._building: dict[tuple[str, int], _Building] = {}
        self._closed: dict[tuple[str, int], list[Bar]] = {}
        self._last_price: dict[str, float] = {}

    def add(self, trade: Trade) -> list[Bar]:
        """Add a trade. Returns any bars that this trade completed."""
        completed: list[Bar] = []
        self._last_price[trade.symbol] = trade.price
        for resolution in self.resolutions_s:
            key = (trade.symbol, resolution)
            bucket = floor_ns(trade.exchange_ns, resolution)
            current = self._building.get(key)
            if current is None:
                fresh = _Building(
                    open_ns=bucket,
                    open=trade.price,
                    high=trade.price,
                    low=trade.price,
                    close=trade.price,
                )
                fresh.add(trade)
                self._building[key] = fresh
                continue
            if bucket > current.open_ns:
                bar = current.finish(trade.symbol, resolution)
                self._closed.setdefault(key, []).append(bar)
                completed.append(bar)
                # Empty intervals are not back-filled with flat bars. A gap in
                # the bar series is information — it says the feed was quiet or
                # broken — and papering over it with synthetic zero-volume bars
                # would hide exactly the condition the quality layer looks for.
                current = _Building(
                    open_ns=bucket,
                    open=trade.price,
                    high=trade.price,
                    low=trade.price,
                    close=trade.price,
                )
                self._building[key] = current
            elif bucket < current.open_ns:
                # Out-of-order arrival. Dropped rather than back-applied: a bar
                # already published as closed must not silently change.
                continue
            current.add(trade)
        return completed

    def seal_through(self, now_ns: int) -> list[Bar]:
        """Close every bar whose interval has fully elapsed by `now_ns`.

        A bar covering [T-1s, T) is complete once the clock passes T. Waiting for
        the *next trade* to close it — which is what happens if only `add` is
        ever called — makes the most recent bar invisible until someone trades
        again, so a quiet market silently shortens every volatility window.

        Worse, it made the answer depend on trade arrival rather than on time: a
        window built at T by a process that had seen a later trade contained one
        more bar than the same window built by a process that had not. Two views
        of the same instant disagreed, which is exactly the sort of gap that
        turns into training-serving skew.

        Sealing is driven by the clock, so both views agree.
        """
        completed: list[Bar] = []
        for (symbol, resolution), building in list(self._building.items()):
            end_ns = building.open_ns + resolution * NS_PER_SECOND
            if end_ns <= now_ns:
                bar = building.finish(symbol, resolution)
                self._closed.setdefault((symbol, resolution), []).append(bar)
                completed.append(bar)
                del self._building[(symbol, resolution)]
        return completed

    def closed_bars(self, symbol: str, resolution_s: int) -> list[Bar]:
        return list(self._closed.get((symbol, resolution_s), ()))

    def flush(self, symbol: str, resolution_s: int) -> Bar | None:
        """Close the in-progress bar. Only for the end of a finite capture."""
        key = (symbol, resolution_s)
        current = self._building.pop(key, None)
        if current is None:
            return None
        bar = current.finish(symbol, resolution_s)
        self._closed.setdefault(key, []).append(bar)
        return bar

    def flush_all(self) -> list[Bar]:
        out: list[Bar] = []
        for symbol, resolution in list(self._building.keys()):
            bar = self.flush(symbol, resolution)
            if bar is not None:
                out.append(bar)
        return out

    def last_price(self, symbol: str) -> float | None:
        return self._last_price.get(symbol)


def bars_to_returns(bars: list[Bar]) -> list[float]:
    """Log returns of consecutive bar closes.

    Consecutive in the list, not in time. A gap in the bar series produces one
    return spanning the gap, which is correct: the price did move over that
    interval, and pretending otherwise would understate volatility exactly when
    the feed was struggling.
    """
    out: list[float] = []
    for previous, current in pairwise(bars):
        if previous.close > 0.0 and current.close > 0.0:
            out.append(math.log(current.close / previous.close))
    return out


def resolution_ns(resolution_s: int) -> int:
    return resolution_s * NS_PER_SECOND
