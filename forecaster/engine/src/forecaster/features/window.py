"""The window of market data a forecast is allowed to see.

Every feature reads a `MarketWindow` and nothing else. The window is constructed
with an explicit cutoff and physically excludes anything after it, so a feature
*cannot* look ahead — not because the author remembered, but because the data is
not there.

Two sources build the same window type:

* `RollingWindowSource` keeps the recent past in memory and is what the live
  server uses.
* `StoreWindowSource` reads the database and is what training and backtesting
  use.

They produce identical windows for identical inputs, and `tests/test_feature_parity.py`
asserts it on real generated data. That equality is the defence against
training-serving skew, which is the most common way a model that validates
beautifully performs badly in production.

The cutoff is **receipt time**, not exchange time. Information that had not
reached this process yet was not available, whatever the venue's clock says.
"""

from __future__ import annotations

import threading
from bisect import bisect_left, bisect_right
from collections import deque
from dataclasses import dataclass, field

from forecaster.types import (
    NS_PER_SECOND,
    Bar,
    BookSnapshot,
    DataSource,
    Quote,
    Trade,
)


@dataclass(frozen=True)
class MarketWindow:
    """Everything visible as of `as_of_ns`, and nothing else."""

    symbol: str
    as_of_ns: int
    bars_1s: tuple[Bar, ...]
    bars_60s: tuple[Bar, ...]
    trades: tuple[Trade, ...]
    quotes: tuple[Quote, ...]
    book: BookSnapshot | None
    data_source: DataSource
    venue: str

    @property
    def last_trade(self) -> Trade | None:
        return self.trades[-1] if self.trades else None

    @property
    def last_quote(self) -> Quote | None:
        return self.quotes[-1] if self.quotes else None

    @property
    def spot(self) -> float | None:
        """The price a forecast is made from.

        The last trade, not the mid. A trade is a price someone actually paid;
        a mid is an average of two intentions. The user's target is compared
        against traded prices at expiry, so the reference price has to be a
        traded price too or the comparison is not like for like.
        """
        trade = self.last_trade
        if trade is not None:
            return trade.price
        quote = self.last_quote
        return quote.mid if quote is not None else None

    @property
    def history_ns(self) -> int:
        """How much history this window actually contains."""
        if self.bars_1s:
            return self.as_of_ns - self.bars_1s[0].open_ns
        if self.trades:
            return self.as_of_ns - self.trades[0].received_ns
        return 0

    def oldest_ns(self) -> int:
        candidates = []
        if self.bars_1s:
            candidates.append(self.bars_1s[0].open_ns)
        if self.trades:
            candidates.append(self.trades[0].received_ns)
        if self.quotes:
            candidates.append(self.quotes[0].received_ns)
        return min(candidates) if candidates else self.as_of_ns

    def validate_causality(self) -> None:
        """Prove nothing in the window postdates the cutoff.

        Called by the feature computation on every build. Cheap, and it turns a
        whole category of silent look-ahead bug into a loud exception.
        """
        for trade in self.trades:
            if trade.received_ns > self.as_of_ns:
                raise ValueError(
                    f"window for {self.symbol} contains a trade received "
                    f"{trade.received_ns - self.as_of_ns} ns after the cutoff"
                )
        for quote in self.quotes:
            if quote.received_ns > self.as_of_ns:
                raise ValueError(
                    f"window for {self.symbol} contains a quote received "
                    f"{quote.received_ns - self.as_of_ns} ns after the cutoff"
                )
        if self.book is not None and self.book.received_ns > self.as_of_ns:
            raise ValueError(f"window for {self.symbol} contains a book after the cutoff")
        for bar in self.bars_1s:
            end = bar.open_ns + bar.resolution_s * NS_PER_SECOND
            if end > self.as_of_ns:
                raise ValueError(
                    f"window for {self.symbol} contains a 1s bar closing "
                    f"{end - self.as_of_ns} ns after the cutoff"
                )


def _latest_book(books: list[BookSnapshot], as_of_ns: int) -> BookSnapshot | None:
    """The newest book at or before the cutoff."""
    latest: BookSnapshot | None = None
    for book in books:
        if book.received_ns <= as_of_ns:
            latest = book
        else:
            break
    return latest


# Retention is set by the longest feature lookback (one hour) plus headroom.
# Keeping more would cost memory for nothing; keeping less would silently
# truncate the slowest volatility component and make it quietly wrong.
DEFAULT_RETENTION_NS = 2 * 3600 * NS_PER_SECOND


@dataclass
class RollingWindowSource:
    """In-memory recent history, for the live path.

    Bounded by time rather than by count, so a quiet market keeps its full hour
    of context instead of ageing out after N events.

    **Guarded by a lock.** The collector appends from the event loop while
    request handlers read from FastAPI's worker threads, and those are genuinely
    concurrent. Without the lock this raised `RuntimeError: deque mutated during
    iteration` under load — intermittently, as a 500, on a request that looked
    fine a moment earlier. It was found by the browser verification rather than
    by any unit test, because it only appears when something is reading and
    writing at the same time.
    """

    symbol: str
    venue: str
    data_source: DataSource
    retention_ns: int = DEFAULT_RETENTION_NS
    _trades: deque[Trade] = field(default_factory=deque)
    _quotes: deque[Quote] = field(default_factory=deque)
    _bars_1s: deque[Bar] = field(default_factory=deque)
    _bars_60s: deque[Bar] = field(default_factory=deque)
    _books: deque[BookSnapshot] = field(default_factory=deque)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def add_trade(self, trade: Trade) -> None:
        with self._lock:
            self._trades.append(trade)
            self._evict(trade.received_ns)

    def add_quote(self, quote: Quote) -> None:
        with self._lock:
            self._quotes.append(quote)
            self._evict(quote.received_ns)

    def add_book(self, book: BookSnapshot) -> None:
        # A deque, not a single value. Keeping only the newest snapshot meant a
        # window built for an earlier instant found no book and quietly dropped
        # both order-book features — the kind of gap that shows up as a model
        # performing worse in production than in training, with no error anywhere.
        with self._lock:
            self._books.append(book)

    def add_bar(self, bar: Bar) -> None:
        with self._lock:
            if bar.resolution_s == 1:
                self._bars_1s.append(bar)
            elif bar.resolution_s == 60:
                self._bars_60s.append(bar)

    def _evict(self, now_ns: int) -> None:
        cutoff = now_ns - self.retention_ns
        while self._trades and self._trades[0].received_ns < cutoff:
            self._trades.popleft()
        while self._quotes and self._quotes[0].received_ns < cutoff:
            self._quotes.popleft()
        while self._bars_1s and self._bars_1s[0].open_ns < cutoff:
            self._bars_1s.popleft()
        while self._bars_60s and self._bars_60s[0].open_ns < cutoff:
            self._bars_60s.popleft()
        while len(self._books) > 1 and self._books[0].received_ns < cutoff:
            self._books.popleft()

    def window(self, as_of_ns: int) -> MarketWindow:
        # Snapshot everything under the lock, then filter outside it. Holding the
        # lock across the filtering would block the collector for as long as a
        # window takes to build; copying four references does not.
        with self._lock:
            bars_1s = list(self._bars_1s)
            bars_60s = list(self._bars_60s)
            trades = list(self._trades)
            quotes = list(self._quotes)
            books = list(self._books)

        return MarketWindow(
            symbol=self.symbol,
            as_of_ns=as_of_ns,
            bars_1s=tuple(
                b for b in bars_1s if b.open_ns + b.resolution_s * NS_PER_SECOND <= as_of_ns
            ),
            bars_60s=tuple(
                b for b in bars_60s if b.open_ns + b.resolution_s * NS_PER_SECOND <= as_of_ns
            ),
            trades=tuple(t for t in trades if t.received_ns <= as_of_ns),
            quotes=tuple(q for q in quotes if q.received_ns <= as_of_ns),
            book=_latest_book(books, as_of_ns),
            data_source=self.data_source,
            venue=self.venue,
        )


@dataclass
class StoreWindowSource:
    """Windows read from the database, for training and backtesting.

    Produces the same `MarketWindow` as the live source. That is the point: one
    window type, one feature function, no second implementation to drift.
    """

    market_repo: object  # MarketRepository; typed loosely to keep this layer import-light
    symbol: str
    venue: str
    data_source: DataSource
    retention_ns: int = DEFAULT_RETENTION_NS

    def window(self, as_of_ns: int) -> MarketWindow:
        repo = self.market_repo
        start_ns = as_of_ns - self.retention_ns
        trades = repo.trades_between(  # type: ignore[attr-defined]
            self.symbol, start_ns, as_of_ns + 1, source=self.data_source, venue=self.venue
        )
        # Ordered by RECEIPT time, matching the order the live collector saw
        # them. The database returns exchange-time order, which differs whenever
        # network latency varies, and a window that is ordered differently in
        # training than in production is a training-serving skew waiting to
        # matter the first time a feature depends on sequence.
        trades = sorted(
            (t for t in trades if t.received_ns <= as_of_ns), key=lambda t: t.received_ns
        )
        bars_1s = repo.bars_between(  # type: ignore[attr-defined]
            self.symbol, 1, start_ns, as_of_ns, source=self.data_source, venue=self.venue
        )
        bars_60s = repo.bars_between(  # type: ignore[attr-defined]
            self.symbol, 60, start_ns, as_of_ns, source=self.data_source, venue=self.venue
        )
        quotes = repo.quotes_between(  # type: ignore[attr-defined]
            self.symbol, start_ns, as_of_ns, source=self.data_source, venue=self.venue
        )
        book = repo.latest_book(  # type: ignore[attr-defined]
            self.symbol, as_of_ns, source=self.data_source, venue=self.venue
        )
        return MarketWindow(
            symbol=self.symbol,
            as_of_ns=as_of_ns,
            bars_1s=tuple(
                b for b in bars_1s if b.open_ns + b.resolution_s * NS_PER_SECOND <= as_of_ns
            ),
            bars_60s=tuple(
                b for b in bars_60s if b.open_ns + b.resolution_s * NS_PER_SECOND <= as_of_ns
            ),
            trades=tuple(trades),
            quotes=tuple(quotes),
            book=book,
            data_source=self.data_source,
            venue=self.venue,
        )


@dataclass
class CachedWindowSource:
    """A store-backed window source that loads its range once.

    `StoreWindowSource` re-queries the database for every instant. That is fine
    for a handful of windows and hopeless for training: a day of fifteen-second
    samples means several thousand queries, each scanning two hours of trades.
    Measured here at roughly a hundred times slower than necessary, and it was
    slow enough to make training on six hours of data time out.

    This loads the whole range once and slices it with binary search. It produces
    **the same `MarketWindow`** as the uncached source — `tests/test_feature_parity.py`
    asserts field-by-field equality across hundreds of instants — so training and
    serving still share one definition of what the model sees. The optimisation is
    in how the data is fetched, never in what the window contains.
    """

    market_repo: object
    symbol: str
    venue: str
    data_source: DataSource
    start_ns: int
    end_ns: int
    retention_ns: int = DEFAULT_RETENTION_NS
    _trades: list[Trade] = field(default_factory=list)
    _quotes: list[Quote] = field(default_factory=list)
    _bars_1s: list[Bar] = field(default_factory=list)
    _bars_60s: list[Bar] = field(default_factory=list)
    _books: list[BookSnapshot] = field(default_factory=list)
    _trade_keys: list[int] = field(default_factory=list)
    _quote_keys: list[int] = field(default_factory=list)
    _book_keys: list[int] = field(default_factory=list)
    _bar_1s_keys: list[int] = field(default_factory=list)
    _bar_60s_keys: list[int] = field(default_factory=list)
    _loaded: bool = False

    def load(self) -> CachedWindowSource:
        repo = self.market_repo
        lo = self.start_ns - self.retention_ns
        hi = self.end_ns + 1
        self._trades = sorted(
            repo.trades_between(self.symbol, lo, hi, source=self.data_source, venue=self.venue),  # type: ignore[attr-defined]
            key=lambda t: t.received_ns,
        )
        self._quotes = sorted(
            repo.quotes_between(self.symbol, lo, hi, source=self.data_source, venue=self.venue),  # type: ignore[attr-defined]
            key=lambda q: q.received_ns,
        )
        self._bars_1s = repo.bars_between(  # type: ignore[attr-defined]
            self.symbol, 1, lo, hi, source=self.data_source, venue=self.venue
        )
        self._bars_60s = repo.bars_between(  # type: ignore[attr-defined]
            self.symbol, 60, lo, hi, source=self.data_source, venue=self.venue
        )
        self._books = sorted(
            repo.books_between(self.symbol, lo, hi, source=self.data_source, venue=self.venue),  # type: ignore[attr-defined]
            key=lambda b: b.received_ns,
        )
        self._trade_keys = [t.received_ns for t in self._trades]
        self._quote_keys = [q.received_ns for q in self._quotes]
        self._book_keys = [b.received_ns for b in self._books]
        # Bars are keyed by their CLOSING time, because that is when a bar
        # becomes visible. Keying by open time would let a bar into the window
        # up to a full resolution before it finished, which is look-ahead.
        self._bar_1s_keys = [b.open_ns + b.resolution_s * NS_PER_SECOND for b in self._bars_1s]
        self._bar_60s_keys = [b.open_ns + b.resolution_s * NS_PER_SECOND for b in self._bars_60s]
        self._loaded = True
        return self

    def window(self, as_of_ns: int) -> MarketWindow:
        if not self._loaded:
            self.load()
        floor_ns = as_of_ns - self.retention_ns

        return MarketWindow(
            symbol=self.symbol,
            as_of_ns=as_of_ns,
            bars_1s=tuple(self._slice_bars(self._bars_1s, self._bar_1s_keys, floor_ns, as_of_ns)),
            bars_60s=tuple(
                self._slice_bars(self._bars_60s, self._bar_60s_keys, floor_ns, as_of_ns)
            ),
            trades=tuple(
                self._trades[
                    bisect_left(self._trade_keys, floor_ns) : bisect_right(
                        self._trade_keys, as_of_ns
                    )
                ]
            ),
            quotes=tuple(
                self._quotes[
                    bisect_left(self._quote_keys, floor_ns) : bisect_right(
                        self._quote_keys, as_of_ns
                    )
                ]
            ),
            book=self._latest_book(as_of_ns),
            data_source=self.data_source,
            venue=self.venue,
        )

    def _slice_bars(
        self, bars: list[Bar], close_keys: list[int], floor_ns: int, as_of_ns: int
    ) -> list[Bar]:
        end = bisect_right(close_keys, as_of_ns)
        return [b for b in bars[:end] if b.open_ns >= floor_ns]

    def _latest_book(self, as_of_ns: int) -> BookSnapshot | None:
        index = bisect_right(self._book_keys, as_of_ns)
        return self._books[index - 1] if index > 0 else None
