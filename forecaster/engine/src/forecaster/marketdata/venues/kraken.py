"""Kraken spot market data.

Secondary venue, US-accessible, no key needed for public data. Useful as a
cross-check on Coinbase: two independent views of the same asset is how a bad
feed gets caught, and is the groundwork for the cross-venue signals the design
leaves room for.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from forecaster.clock import now_ns
from forecaster.marketdata.provider import MarketEvent, ProviderBase, ProviderError
from forecaster.types import NS_PER_SECOND, DataSource, Quote, Side, Trade

WS_URL = "wss://ws.kraken.com/v2"
REST_URL = "https://api.kraken.com"


def to_venue_symbol(symbol: str) -> str:
    base, _, quote = symbol.partition("-")
    return f"{base}/{quote}".upper()


def from_venue_symbol(venue_symbol: str) -> str:
    return venue_symbol.replace("/", "-").upper()


def parse_trade(payload: dict[str, Any], received_ns: int) -> Trade | None:
    """Kraken v2 reports the aggressor side directly, which is the easy case."""
    try:
        side = payload.get("side")
        return Trade(
            exchange_ns=_parse_ts(payload.get("timestamp"), received_ns),
            received_ns=received_ns,
            symbol=from_venue_symbol(str(payload["symbol"])),
            price=float(payload["price"]),
            size=float(payload["qty"]),
            side=Side.BUY if side == "buy" else Side.SELL if side == "sell" else Side.UNKNOWN,
            trade_id=str(payload.get("trade_id", "")),
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_ticker(payload: dict[str, Any], received_ns: int) -> Quote | None:
    try:
        return Quote(
            exchange_ns=received_ns,
            received_ns=received_ns,
            symbol=from_venue_symbol(str(payload["symbol"])),
            bid=float(payload["bid"]),
            bid_size=float(payload.get("bid_qty", 0.0)),
            ask=float(payload["ask"]),
            ask_size=float(payload.get("ask_qty", 0.0)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _parse_ts(value: str | None, fallback_ns: int) -> int:
    if not value:
        return fallback_ns
    from datetime import datetime

    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * NS_PER_SECOND)
    except ValueError:
        return fallback_ns


class KrakenProvider(ProviderBase):
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
            venue="kraken", data_source=DataSource.LIVE, stale_after_ns=30 * NS_PER_SECOND
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

        venue_symbols = [to_venue_symbol(s) for s in symbols]
        async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20) as socket:
            for channel in ("trade", "ticker"):
                await socket.send(
                    json.dumps(
                        {
                            "method": "subscribe",
                            "params": {"channel": channel, "symbol": venue_symbols},
                        }
                    )
                )
            async for raw in socket:
                received_ns = now_ns()
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    self._health.malformed_messages += 1
                    continue
                channel = message.get("channel")
                if channel not in ("trade", "ticker"):
                    continue
                parser = parse_trade if channel == "trade" else parse_ticker
                for item in message.get("data", []):
                    event = parser(item, received_ns)
                    if event is None:
                        self._health.malformed_messages += 1
                        continue
                    yield event

    async def _poll(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        async with httpx.AsyncClient(base_url=self.rest_url, timeout=10.0) as client:
            while True:
                for symbol in symbols:
                    received_ns = now_ns()
                    response = await client.get(
                        "/0/public/Ticker", params={"pair": to_venue_symbol(symbol)}
                    )
                    if response.status_code == 429:
                        self._health.rate_limited += 1
                        await asyncio.sleep(5.0)
                        continue
                    response.raise_for_status()
                    payload = response.json()
                    if payload.get("error"):
                        raise ProviderError(f"kraken error: {payload['error']}")
                    for _pair, values in payload.get("result", {}).items():
                        try:
                            yield Quote(
                                exchange_ns=received_ns,
                                received_ns=received_ns,
                                symbol=symbol,
                                bid=float(values["b"][0]),
                                bid_size=float(values["b"][2]),
                                ask=float(values["a"][0]),
                                ask_size=float(values["a"][2]),
                            )
                        except (KeyError, IndexError, TypeError, ValueError):
                            self._health.malformed_messages += 1
                await asyncio.sleep(self.poll_interval_s)
