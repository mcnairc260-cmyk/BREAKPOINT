"""Replaying a recorded market.

A capture is newline-delimited JSON, one market event per line, in the order it
arrived. Replaying it reproduces exactly what the live system saw, which is what
makes a backtest a backtest rather than a simulation of one.

The format is deliberately dull: line-oriented, append-only, readable with
`head`, and compressible to roughly a tenth of its size. A capture that needs
this project's own code to be inspected is a capture nobody will ever audit.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any, TextIO, cast

from forecaster.marketdata.provider import MarketEvent, ProviderBase, ProviderError
from forecaster.types import (
    NS_PER_SECOND,
    BookLevel,
    BookSnapshot,
    DataSource,
    Quote,
    Side,
    Trade,
)

CAPTURE_VERSION = 1


def encode_event(event: MarketEvent) -> str:
    if isinstance(event, Trade):
        payload: dict[str, Any] = {
            "k": "t",
            "e": event.exchange_ns,
            "r": event.received_ns,
            "s": event.symbol,
            "p": event.price,
            "z": event.size,
            "d": event.side.value,
            "i": event.trade_id,
        }
    elif isinstance(event, Quote):
        payload = {
            "k": "q",
            "e": event.exchange_ns,
            "r": event.received_ns,
            "s": event.symbol,
            "b": event.bid,
            "bs": event.bid_size,
            "a": event.ask,
            "as": event.ask_size,
        }
    else:
        payload = {
            "k": "b",
            "e": event.exchange_ns,
            "r": event.received_ns,
            "s": event.symbol,
            "B": [[level.price, level.size] for level in event.bids],
            "A": [[level.price, level.size] for level in event.asks],
            "q": event.sequence,
        }
    return json.dumps(payload, separators=(",", ":"))


def decode_event(line: str) -> MarketEvent:
    payload = json.loads(line)
    kind = payload["k"]
    if kind == "t":
        return Trade(
            exchange_ns=payload["e"],
            received_ns=payload["r"],
            symbol=payload["s"],
            price=payload["p"],
            size=payload["z"],
            side=Side(payload["d"]),
            trade_id=payload["i"],
        )
    if kind == "q":
        return Quote(
            exchange_ns=payload["e"],
            received_ns=payload["r"],
            symbol=payload["s"],
            bid=payload["b"],
            bid_size=payload["bs"],
            ask=payload["a"],
            ask_size=payload["as"],
        )
    if kind == "b":
        return BookSnapshot(
            exchange_ns=payload["e"],
            received_ns=payload["r"],
            symbol=payload["s"],
            bids=tuple(BookLevel(p, s) for p, s in payload["B"]),
            asks=tuple(BookLevel(p, s) for p, s in payload["A"]),
            sequence=payload.get("q"),
        )
    raise ProviderError(f"unknown capture record kind: {kind!r}")


def _open_text(path: Path, mode: str) -> TextIO:
    """Open a capture, transparently handling gzip.

    A capture compresses to roughly a tenth of its size, and being able to read
    either form without the caller caring is worth the cast: `gzip.open` in text
    mode does return a text stream, but its declared type does not say so.
    """
    if path.suffix == ".gz":
        return cast(TextIO, gzip.open(path, mode + "t", encoding="utf-8"))
    return cast(TextIO, path.open(mode, encoding="utf-8"))


class CaptureWriter:
    """Writes a capture. Flushes per event so a killed collector loses one line."""

    def __init__(self, path: str | Path, *, venue: str, data_source: DataSource) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = _open_text(self.path, "w")
        header = {
            "k": "h",
            "version": CAPTURE_VERSION,
            "venue": venue,
            "data_source": data_source.value,
        }
        self._handle.write(json.dumps(header, separators=(",", ":")) + "\n")
        self._count = 0

    def write(self, event: MarketEvent) -> None:
        self._handle.write(encode_event(event) + "\n")
        self._count += 1
        if self._count % 500 == 0:
            self._handle.flush()

    @property
    def count(self) -> int:
        return self._count

    def close(self) -> None:
        self._handle.flush()
        self._handle.close()

    def __enter__(self) -> CaptureWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def read_capture(path: str | Path) -> Iterator[MarketEvent]:
    """Iterate a capture, skipping the header."""
    handle = _open_text(Path(path), "r")
    try:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            if line.startswith('{"k":"h"'):
                continue
            yield decode_event(line)
    finally:
        handle.close()


def capture_header(path: str | Path) -> dict[str, Any]:
    handle = _open_text(Path(path), "r")
    try:
        first = handle.readline().strip()
    finally:
        handle.close()
    if not first:
        raise ProviderError(f"empty capture: {path}")
    header = json.loads(first)
    if header.get("k") != "h":
        raise ProviderError(f"capture is missing its header: {path}")
    return header


class ReplayProvider(ProviderBase):
    """Streams a recorded capture back in its original order.

    `speed` scales the wait between events; the default of zero replays as fast
    as the machine allows, which is what the backtester wants. A speed of 1.0
    replays in real time, which is useful for exercising the live path against a
    known feed.
    """

    def __init__(
        self,
        *,
        capture_path: str | Path,
        venue: str = "replay",
        speed: float = 0.0,
        data_source: DataSource = DataSource.REPLAY,
    ) -> None:
        header = capture_header(capture_path)
        super().__init__(
            venue=header.get("venue", venue),
            data_source=data_source,
            stale_after_ns=60 * NS_PER_SECOND,
        )
        self.capture_path = Path(capture_path)
        self.speed = speed
        self.header = header

    async def _connect_and_yield(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        import asyncio

        wanted = set(symbols)
        previous_ns: int | None = None
        for event in read_capture(self.capture_path):
            if wanted and event.symbol not in wanted:
                continue
            if self.speed > 0.0 and previous_ns is not None:
                gap_s = (event.received_ns - previous_ns) / NS_PER_SECOND / self.speed
                if gap_s > 0.0:
                    await asyncio.sleep(min(gap_s, 5.0))
            previous_ns = event.received_ns
            yield event
