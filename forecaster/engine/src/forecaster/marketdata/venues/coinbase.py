"""Coinbase Exchange market data.

The default venue, chosen because its market-data feeds are public: no API key,
no secret, nothing to leak. A product that can be run correctly without
credentials is a product that will be.

Two transports, and the second is not a fallback of convenience:

* **WebSocket** (`wss://ws-feed.exchange.coinbase.com`) — the real-time path.
  Subscribes to `matches` for trades, `ticker` for top of book, and `level2` for
  depth.
* **REST polling** (`https://api.exchange.coinbase.com`) — for the many networks
  where a WebSocket upgrade is blocked outright, including this project's own
  build environment. Lower resolution, and honest about it: the health record
  marks polled data so the confidence layer can down-weight microstructure
  features that a one-second poll cannot support.

Parsing is tested against fixtures in `tests/fixtures/venues/`, which are
**written from the public API documentation, not captured from the venue**. They
prove the shapes are handled; they do not prove the endpoint behaves this way
today. That distinction is the whole reason `scripts/smoke_live.py` exists.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from forecaster.clock import now_ns
from forecaster.marketdata.book import BookBuilder, SequenceGap
from forecaster.marketdata.provider import MarketEvent, ProviderBase, ProviderError
from forecaster.marketdata.venues.endpoints import classify_endpoint
from forecaster.types import NS_PER_SECOND, Quote, Side, Trade

WS_URL = "wss://ws-feed.exchange.coinbase.com"
REST_URL = "https://api.exchange.coinbase.com"

# Coinbase publishes a rate limit of 10 requests/second for public REST
# endpoints. Polling three endpoints per symbol, two symbols, at 1 Hz sits at
# six — deliberately under, because being throttled costs more than the extra
# resolution is worth.
POLL_INTERVAL_S = 1.0


def parse_iso_ns(value: str | None) -> int:
    """Coinbase timestamps are RFC 3339 with variable fractional digits."""
    if not value:
        return now_ns()
    from datetime import datetime

    text = value.replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(text).timestamp() * NS_PER_SECOND)
    except ValueError:
        return now_ns()


def parse_match(message: dict[str, Any], received_ns: int) -> Trade | None:
    """A `match` (or `last_match`) message: one executed trade.

    Coinbase reports `side` as the **maker's** side, so a `sell` match means the
    resting order was a sell and the aggressor was therefore a buyer. Getting
    this backwards inverts every order-flow feature, which is the kind of bug
    that produces a confidently wrong model rather than an obviously broken one.
    """
    try:
        maker_side = message.get("side")
        aggressor = (
            Side.BUY if maker_side == "sell" else Side.SELL if maker_side == "buy" else Side.UNKNOWN
        )
        return Trade(
            exchange_ns=parse_iso_ns(message.get("time")),
            received_ns=received_ns,
            symbol=str(message["product_id"]),
            price=float(message["price"]),
            size=float(message["size"]),
            side=aggressor,
            trade_id=str(message.get("trade_id", message.get("sequence", ""))),
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_ticker(message: dict[str, Any], received_ns: int) -> Quote | None:
    """A `ticker` message: top of book plus the last trade."""
    try:
        bid = float(message["best_bid"])
        ask = float(message["best_ask"])
        if bid <= 0.0 or ask <= 0.0:
            return None
        return Quote(
            exchange_ns=parse_iso_ns(message.get("time")),
            received_ns=received_ns,
            symbol=str(message["product_id"]),
            bid=bid,
            # `best_bid_size` is absent on older ticker payloads. Zero is the
            # honest value: the size is unknown, and a fabricated one would flow
            # straight into the imbalance feature.
            bid_size=float(message.get("best_bid_size", 0.0) or 0.0),
            ask=ask,
            ask_size=float(message.get("best_ask_size", 0.0) or 0.0),
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_rest_ticker(payload: dict[str, Any], symbol: str, received_ns: int) -> Quote | None:
    try:
        bid = float(payload["bid"])
        ask = float(payload["ask"])
        if bid <= 0.0 or ask <= 0.0:
            return None
        return Quote(
            exchange_ns=parse_iso_ns(payload.get("time")),
            received_ns=received_ns,
            symbol=symbol,
            bid=bid,
            bid_size=0.0,
            ask=ask,
            ask_size=0.0,
        )
    except (KeyError, TypeError, ValueError):
        return None


def parse_rest_trade(payload: dict[str, Any], symbol: str, received_ns: int) -> Trade | None:
    try:
        maker_side = payload.get("side")
        aggressor = (
            Side.BUY if maker_side == "sell" else Side.SELL if maker_side == "buy" else Side.UNKNOWN
        )
        return Trade(
            exchange_ns=parse_iso_ns(payload.get("time")),
            received_ns=received_ns,
            symbol=symbol,
            price=float(payload["price"]),
            size=float(payload["size"]),
            side=aggressor,
            trade_id=str(payload["trade_id"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


class CoinbaseProvider(ProviderBase):
    def __init__(
        self,
        *,
        symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD"),
        transport: str = "websocket",
        book_depth: int = 10,
        ws_url: str = WS_URL,
        rest_url: str = REST_URL,
        poll_interval_s: float = POLL_INTERVAL_S,
    ) -> None:
        # The label is derived from the hosts, never asserted. Pointing this
        # adapter at anything that is not Coinbase produces SIMULATED data, so a
        # conformance double or a typo cannot enter the live track record.
        super().__init__(
            venue="coinbase",
            data_source=classify_endpoint("coinbase", ws_url, rest_url),
            stale_after_ns=30 * NS_PER_SECOND,
        )
        if transport not in ("websocket", "poll"):
            raise ProviderError(f"unknown transport: {transport!r} (expected websocket or poll)")
        self.symbols = symbols
        self.transport = transport
        self.book_depth = book_depth
        self.ws_url = ws_url
        self.rest_url = rest_url
        self.poll_interval_s = poll_interval_s
        self._books = {s: BookBuilder(symbol=s, depth=book_depth) for s in symbols}
        self._seen_trade_ids: dict[str, set[str]] = {s: set() for s in symbols}

    def _connect_and_yield(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        if self.transport == "poll":
            return self._poll(symbols)
        return self._websocket(symbols)

    # -- websocket -----------------------------------------------------------

    async def _websocket(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        import websockets

        subscribe = json.dumps(
            {
                "type": "subscribe",
                "product_ids": list(symbols),
                "channels": ["matches", "ticker", "level2_batch"],
            }
        )
        async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20) as socket:
            await socket.send(subscribe)
            async for raw in socket:
                received_ns = now_ns()
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    self._health.malformed_messages += 1
                    continue
                for event in self._handle_ws_message(message, received_ns):
                    yield event

    def _handle_ws_message(self, message: dict[str, Any], received_ns: int) -> list[MarketEvent]:
        kind = message.get("type")
        if kind == "error":
            # Both halves. `message` is the category ("Failed to subscribe") and
            # `reason` is the part that says what to fix.
            detail = " — ".join(
                str(part) for part in (message.get("message"), message.get("reason")) if part
            )
            raise ProviderError(f"coinbase feed error: {detail or 'unspecified'}")
        if kind in ("match", "last_match"):
            trade = parse_match(message, received_ns)
            if trade is None:
                self._health.malformed_messages += 1
                return []
            return [trade]
        if kind == "ticker":
            quote = parse_ticker(message, received_ns)
            if quote is None:
                self._health.malformed_messages += 1
                return []
            return [quote]
        if kind == "snapshot":
            symbol = str(message.get("product_id", ""))
            builder = self._books.get(symbol)
            if builder is None:
                return []
            builder.apply_snapshot(
                [(float(p), float(s)) for p, s in message.get("bids", [])[: self.book_depth * 4]],
                [(float(p), float(s)) for p, s in message.get("asks", [])[: self.book_depth * 4]],
                sequence=None,
            )
            snap = builder.snapshot(received_ns, received_ns)
            return [snap] if snap else []
        if kind == "l2update":
            symbol = str(message.get("product_id", ""))
            builder = self._books.get(symbol)
            if builder is None or not builder.synced:
                return []
            bids: list[tuple[float, float]] = []
            asks: list[tuple[float, float]] = []
            for change in message.get("changes", []):
                try:
                    side, price, size = change
                    (bids if side == "buy" else asks).append((float(price), float(size)))
                except (TypeError, ValueError):
                    self._health.malformed_messages += 1
            try:
                # `level2_batch` carries no per-message sequence, so strict
                # checking is off for this channel. The resync path still exists
                # and is exercised by the sequenced venues.
                builder.apply_delta(bids, asks, sequence=None, strict=False)
            except SequenceGap:
                self._health.sequence_gaps += 1
                builder.invalidate()
                return []
            snap = builder.snapshot(parse_iso_ns(message.get("time")), received_ns)
            return [snap] if snap else []
        return []

    # -- rest polling --------------------------------------------------------

    async def _poll(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        async with httpx.AsyncClient(base_url=self.rest_url, timeout=10.0) as client:
            while True:
                for symbol in symbols:
                    async for event in self._poll_symbol(client, symbol):
                        yield event
                await asyncio.sleep(self.poll_interval_s)

    async def _poll_symbol(
        self, client: httpx.AsyncClient, symbol: str
    ) -> AsyncIterator[MarketEvent]:
        try:
            ticker = await client.get(f"/products/{symbol}/ticker")
        except httpx.HTTPError as exc:
            raise ProviderError(f"coinbase ticker request failed: {exc}") from exc
        # Stamped when the response ARRIVES, not when the request was sent.
        # Taking it before the round trip makes `received_ns` earlier than the
        # exchange stamp inside the payload, which reads as negative latency:
        # it corrupts the clock-skew estimate and makes a poll look fresher
        # than it is. The websocket path never had this problem because the
        # frame is already in hand when it is stamped.
        received_ns = now_ns()
        if ticker.status_code == 429:
            self._health.rate_limited += 1
            await asyncio.sleep(2.0)
            return
        ticker.raise_for_status()
        quote = parse_rest_ticker(ticker.json(), symbol, received_ns)
        if quote is not None:
            yield quote

        try:
            trades_response = await client.get(f"/products/{symbol}/trades", params={"limit": 100})
        except httpx.HTTPError as exc:
            raise ProviderError(f"coinbase trades request failed: {exc}") from exc
        if trades_response.status_code == 429:
            self._health.rate_limited += 1
            await asyncio.sleep(2.0)
            return
        trades_response.raise_for_status()
        received_ns = now_ns()
        seen = self._seen_trade_ids[symbol]
        fresh: list[Trade] = []
        for item in trades_response.json():
            trade = parse_rest_trade(item, symbol, received_ns)
            if trade is None or trade.trade_id in seen:
                continue
            seen.add(trade.trade_id)
            fresh.append(trade)
        # Polling returns newest first; the rest of the system assumes time order.
        for trade in reversed(fresh):
            yield trade
        if len(seen) > 20_000:
            self._seen_trade_ids[symbol] = set(list(seen)[-10_000:])

        try:
            book_response = await client.get(f"/products/{symbol}/book", params={"level": 2})
        except httpx.HTTPError:
            return
        if book_response.status_code == 429:
            self._health.rate_limited += 1
            return
        if book_response.status_code != 200:
            return
        payload = book_response.json()
        received_ns = now_ns()
        builder = self._books[symbol]
        builder.apply_snapshot(
            [(float(p), float(s)) for p, s, *_ in payload.get("bids", [])[: self.book_depth]],
            [(float(p), float(s)) for p, s, *_ in payload.get("asks", [])[: self.book_depth]],
            sequence=payload.get("sequence"),
        )
        snap = builder.snapshot(received_ns, received_ns)
        if snap is not None:
            yield snap
