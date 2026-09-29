"""Binance spot market data.

Secondary venue. Binance publishes the deepest order book of the three and is
the best source of microstructure data by a distance — but `binance.com` is
blocked to US users, so it is not the default. `binance.us` serves the same
schema with thinner books; pass its host to use it.

Present mainly to prove the provider abstraction is real: this file is the whole
integration, and nothing above `MarketDataProvider` changes to use it.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from forecaster.clock import now_ns
from forecaster.marketdata.provider import MarketEvent, ProviderBase, ProviderError
from forecaster.marketdata.venues.endpoints import classify_endpoint
from forecaster.types import NS_PER_SECOND, Quote, Side, Trade

WS_URL = "wss://stream.binance.com:9443/stream"
REST_URL = "https://api.binance.com"

#: See coinbase.py: the library's 1 MiB default rejects a real order-book
#: snapshot, closes with 1009, and reconnects into the same frame for ever.
MAX_FRAME_BYTES = 32 * 1024 * 1024


def to_venue_symbol(symbol: str) -> str:
    """`BTC-USD` is not a Binance symbol; `BTCUSDT` is.

    USDT rather than USD because Binance's USD spot pairs are thin to
    non-existent. That substitution is a real modelling decision, not a detail:
    a USDT pair carries stablecoin basis risk, so a forecast built on it is
    about BTC/USDT, and `MODEL.md` says so.
    """
    base, _, quote = symbol.partition("-")
    return f"{base}{'USDT' if quote in ('USD', 'USDT') else quote}".upper()


def from_venue_symbol(venue_symbol: str) -> str:
    upper = venue_symbol.upper()
    for quote in ("USDT", "USD"):
        if upper.endswith(quote):
            return f"{upper[: -len(quote)]}-USD"
    return upper


def parse_trade(payload: dict[str, Any], received_ns: int) -> Trade | None:
    """`m` is true when the buyer was the maker, so the aggressor was a seller."""
    try:
        buyer_is_maker = bool(payload["m"])
        return Trade(
            exchange_ns=int(payload["T"]) * 1_000_000,
            received_ns=received_ns,
            symbol=from_venue_symbol(str(payload["s"])),
            price=float(payload["p"]),
            size=float(payload["q"]),
            side=Side.SELL if buyer_is_maker else Side.BUY,
            trade_id=str(payload["t"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_book_ticker(payload: dict[str, Any], received_ns: int) -> Quote | None:
    try:
        return Quote(
            exchange_ns=int(payload.get("E", 0)) * 1_000_000 or received_ns,
            received_ns=received_ns,
            symbol=from_venue_symbol(str(payload["s"])),
            bid=float(payload["b"]),
            bid_size=float(payload["B"]),
            ask=float(payload["a"]),
            ask_size=float(payload["A"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


class BinanceProvider(ProviderBase):
    def __init__(
        self,
        *,
        symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD"),
        transport: str = "websocket",
        ws_url: str = WS_URL,
        rest_url: str = REST_URL,
        poll_interval_s: float = 1.0,
    ) -> None:
        super().__init__(
            venue="binance",
            # Derived from the hosts, never asserted. See endpoints.py.
            data_source=classify_endpoint("binance", ws_url, rest_url),
            stale_after_ns=30 * NS_PER_SECOND,
        )
        if transport not in ("websocket", "poll"):
            raise ProviderError(f"unknown transport: {transport!r}")
        self.symbols = symbols
        self.transport = transport
        self.ws_url = ws_url
        self.rest_url = rest_url
        self.poll_interval_s = poll_interval_s

    def _connect_and_yield(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        return self._poll(symbols) if self.transport == "poll" else self._websocket(symbols)

    async def _websocket(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        import websockets

        streams = []
        for symbol in symbols:
            venue_symbol = to_venue_symbol(symbol).lower()
            streams.extend([f"{venue_symbol}@trade", f"{venue_symbol}@bookTicker"])
        url = f"{self.ws_url}?streams={'/'.join(streams)}"
        async with websockets.connect(
            url, ping_interval=20, ping_timeout=20, max_size=MAX_FRAME_BYTES
        ) as socket:
            async for raw in socket:
                received_ns = now_ns()
                try:
                    envelope = json.loads(raw)
                except (TypeError, ValueError):
                    self._health.malformed_messages += 1
                    continue
                data = envelope.get("data", envelope)
                stream = str(envelope.get("stream", ""))
                event: MarketEvent | None
                if "@trade" in stream or data.get("e") == "trade":
                    event = parse_trade(data, received_ns)
                else:
                    event = parse_book_ticker(data, received_ns)
                if event is None:
                    self._health.malformed_messages += 1
                    continue
                yield event

    async def _poll(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        async with httpx.AsyncClient(base_url=self.rest_url, timeout=10.0) as client:
            while True:
                for symbol in symbols:
                    venue_symbol = to_venue_symbol(symbol)
                    response = await client.get(
                        "/api/v3/ticker/bookTicker", params={"symbol": venue_symbol}
                    )
                    # Stamped on arrival. See the note in coinbase.py.
                    received_ns = now_ns()
                    if response.status_code == 429:
                        self._health.rate_limited += 1
                        await asyncio.sleep(5.0)
                        continue
                    response.raise_for_status()
                    quote = parse_book_ticker(response.json(), received_ns)
                    if quote is not None:
                        yield quote
                await asyncio.sleep(self.poll_interval_s)
