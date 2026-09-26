"""Order-book reconstruction from snapshots and deltas.

The fiddliest part of any exchange integration, and the part most likely to be
silently wrong. A book built from deltas with a missed message is not slightly
stale — it is wrong in a way that persists until the next resync, and every
microstructure feature computed from it is wrong with it.

So the rule here is strict: a sequence gap is not tolerated, patched or
interpolated. It invalidates the book, raises, and forces a resync. A book that
might be wrong is worth less than no book at all, because the confidence layer
can act on a missing book and cannot act on a plausible-looking wrong one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from forecaster.types import BookLevel, BookSnapshot


class SequenceGap(Exception):
    """A message was missed; the book must be rebuilt from a fresh snapshot."""

    def __init__(self, expected: int, received: int) -> None:
        super().__init__(f"order book sequence gap: expected {expected}, received {received}")
        self.expected = expected
        self.received = received


@dataclass
class BookBuilder:
    """Maintains one symbol's book.

    Prices are dict keys, so a level set to zero size is removed rather than
    kept at zero — venues signal deletion that way, and a book full of
    zero-size levels would make depth features nonsense.
    """

    symbol: str
    depth: int = 10
    _bids: dict[float, float] = field(default_factory=dict)
    _asks: dict[float, float] = field(default_factory=dict)
    _sequence: int | None = None
    _synced: bool = False

    @property
    def synced(self) -> bool:
        return self._synced

    @property
    def sequence(self) -> int | None:
        return self._sequence

    def apply_snapshot(
        self, bids: list[tuple[float, float]], asks: list[tuple[float, float]], sequence: int | None
    ) -> None:
        self._bids = {p: s for p, s in bids if s > 0.0}
        self._asks = {p: s for p, s in asks if s > 0.0}
        self._sequence = sequence
        self._synced = True

    def apply_delta(
        self,
        bids: list[tuple[float, float]],
        asks: list[tuple[float, float]],
        sequence: int | None,
        *,
        strict: bool = True,
    ) -> None:
        if not self._synced:
            raise SequenceGap(-1, sequence if sequence is not None else -1)
        if strict and sequence is not None and self._sequence is not None:
            expected = self._sequence + 1
            if sequence < expected:
                # An already-applied message replayed after a reconnect. Ignoring
                # it is correct; applying it twice is not.
                return
            if sequence > expected:
                self._synced = False
                raise SequenceGap(expected, sequence)
        for price, size in bids:
            if size <= 0.0:
                self._bids.pop(price, None)
            else:
                self._bids[price] = size
        for price, size in asks:
            if size <= 0.0:
                self._asks.pop(price, None)
            else:
                self._asks[price] = size
        if sequence is not None:
            self._sequence = sequence

    def invalidate(self) -> None:
        self._synced = False
        self._bids.clear()
        self._asks.clear()
        self._sequence = None

    def snapshot(self, exchange_ns: int, received_ns: int) -> BookSnapshot | None:
        if not self._synced or not self._bids or not self._asks:
            return None
        top_bids = sorted(self._bids.items(), key=lambda kv: -kv[0])[: self.depth]
        top_asks = sorted(self._asks.items(), key=lambda kv: kv[0])[: self.depth]
        return BookSnapshot(
            exchange_ns=exchange_ns,
            received_ns=received_ns,
            symbol=self.symbol,
            bids=tuple(BookLevel(p, s) for p, s in top_bids),
            asks=tuple(BookLevel(p, s) for p, s in top_asks),
            sequence=self._sequence,
        )


def imbalance(book: BookSnapshot, levels: int = 5) -> float:
    """Depth imbalance over the top N levels, in [-1, 1].

    Positive means more size bid than offered. Returns 0.0 for an empty book
    rather than raising, because "no information" and "balanced" are the same
    thing to a downstream model, and the confidence layer already knows the book
    is missing.
    """
    bid_size = sum(level.size for level in book.bids[:levels])
    ask_size = sum(level.size for level in book.asks[:levels])
    total = bid_size + ask_size
    if total <= 0.0:
        return 0.0
    return (bid_size - ask_size) / total


def microprice_deviation(book: BookSnapshot, levels: int = 1) -> float:
    """Where the size-weighted price sits relative to the mid, in basis points."""
    if not book.bids or not book.asks:
        return 0.0
    best_bid = book.bids[0]
    best_ask = book.asks[0]
    mid = (best_bid.price + best_ask.price) / 2.0
    total = best_bid.size + best_ask.size
    if total <= 0.0 or mid <= 0.0:
        return 0.0
    micro = (best_bid.price * best_ask.size + best_ask.price * best_bid.size) / total
    return (micro - mid) / mid * 10_000.0
