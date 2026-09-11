"""A local server that speaks a venue's wire protocol, for testing the real adapter.

## Why this exists

Every venue adapter in this repository was, until now, tested only by calling its
parse functions on dictionaries loaded from a JSON file. That proves the parsing
and nothing else. It does not touch the WebSocket handshake, the subscribe
message, the frame loop, the reconnect path, the REST client, timeout handling,
or any of the code that decides what happens when a feed misbehaves — which is
most of the code that matters when a feed misbehaves.

This module closes that gap the only way available to an environment with no
route to an exchange: it **is** an exchange, on `127.0.0.1`, speaking the same
protocol. The adapter under test is the unmodified production class. It opens a
real TCP connection, performs a real WebSocket handshake, sends its real
subscribe frame, and parses real bytes off a real socket.

## What this proves, and what it cannot

It proves the **client** is correct: that the adapter connects, subscribes,
parses, builds a book, detects staleness, reconnects after a drop, and refuses to
forecast on data it should refuse.

It cannot prove the **server** is correct — that Coinbase today emits these
shapes, these field names, these units. Only a connection to Coinbase proves
that, and `forecaster live-check` is the one-step command for it.

So: this harness moves the adapter from "the parsing is tested" to "everything
except the venue's own behaviour is tested". That is a large step and it is not
the whole distance, and both halves of that sentence belong in the report.

## Why it cannot contaminate the track record

The generated prices are a random walk with no relation to any real market. If
they were ever recorded as LIVE they would be poison. They cannot be: the
adapter derives its `data_source` from the host it connects to (see
`venues/endpoints.py`), `127.0.0.1` is not a venue host, so every row produced
through this harness is labelled SIMULATED by construction — not by convention,
and not by anyone remembering to pass a flag.

## Fault injection

The interesting half. A feed that works is easy; the value is in what happens
when it does not. `Faults` scripts the failures a real venue actually produces —
silent sockets, half-sent JSON, repeated sequence numbers, clocks that step
backwards, books that cross, prices of zero — and the tests assert the system
either recovers correctly or refuses to answer. Refusing is a pass.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import random
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from forecaster.types import NS_PER_SECOND

BASE_PRICES: dict[str, float] = {"BTC-USD": 79_434.21, "ETH-USD": 3_142.87}

#: Per-second volatility of the generated walk. Chosen to sit in the same order
#: of magnitude as real crypto (roughly 40% annualised) so that the volatility
#: estimator is exercised on plausible numbers rather than on a flat line.
SIGMA_PER_SECOND = 0.00025


def iso_ns(ns: int) -> str:
    """Nanoseconds to the RFC 3339 form Coinbase publishes, microsecond precision."""
    return datetime.fromtimestamp(ns / NS_PER_SECOND, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


@dataclass
class Faults:
    """Which failures the server should inject, and when.

    Counters are in messages sent on the current connection, so a fault scheduled
    for message 50 fires again 50 messages into the *next* connection — which is
    what makes a reconnect loop testable rather than a one-shot.
    """

    drop_after: int | None = None
    """Close the socket abruptly after this many messages. Tests reconnection."""

    silent_after: int | None = None
    """Hold the socket open and send nothing more. The dangerous failure: a
    connection that looks perfectly healthy to everything except a clock."""

    malformed_every: int | None = None
    """Send unparseable bytes every N messages."""

    duplicate_every: int | None = None
    """Resend the previous message every N messages, same trade id and all."""

    reverse_time_every: int | None = None
    """Stamp a message with a timestamp earlier than the one before it."""

    crossed_book_every: int | None = None
    """Publish a quote whose bid is above its ask."""

    zero_price_every: int | None = None
    """Publish a trade or quote at a price of zero."""

    negative_price_every: int | None = None
    """Publish a negative price. Impossible, therefore worth asserting about."""

    wide_spread_every: int | None = None
    """Blow the spread out to 5%, as happens in a real liquidity vacuum."""

    drop_quotes: bool = False
    """Send trades but never quotes, so the mid-price is never available."""

    rest_timeout: bool = False
    """Make every REST request hang past the client's timeout."""

    rest_status: int | None = None
    """Answer every REST request with this status code instead of 200."""

    def any_scheduled(self) -> bool:
        return any(
            value not in (None, False)
            for key, value in self.__dict__.items()
            if not key.startswith("_")
        )


@dataclass
class VenueState:
    """The pretend market. A driftless random walk, seeded for reproducibility."""

    symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD")
    seed: int = 7
    prices: dict[str, float] = field(default_factory=dict)
    sequence: int = 0
    trade_id: int = 0
    _rng: random.Random = field(default_factory=lambda: random.Random(7))

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)
        if not self.prices:
            self.prices = {s: BASE_PRICES.get(s, 1_000.0) for s in self.symbols}

    def step(self, symbol: str, dt_s: float) -> float:
        """Advance one symbol by `dt_s` seconds of a zero-drift walk."""
        sigma = SIGMA_PER_SECOND * math.sqrt(max(dt_s, 1e-9))
        price = self.prices[symbol] * math.exp(self._rng.gauss(0.0, sigma))
        self.prices[symbol] = price
        return price

    def spread(self, symbol: str) -> float:
        """A one-basis-point spread, the right order of magnitude for BTC-USD."""
        return max(self.prices[symbol] * 0.0001, 0.01)

    def next_trade_id(self) -> int:
        self.trade_id += 1
        return self.trade_id

    def next_sequence(self) -> int:
        self.sequence += 1
        return self.sequence


class CoinbaseConformanceVenue:
    """A Coinbase Exchange look-alike on localhost: WebSocket feed plus REST.

    The message shapes follow Coinbase's published documentation, including the
    detail that trips people up — `side` on a `match` is the **maker's** side, so
    a correct adapter inverts it to get the aggressor. A harness that emitted the
    aggressor directly would let a broken adapter pass, which is worse than no
    harness.
    """

    def __init__(
        self,
        *,
        symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD"),
        seed: int = 7,
        rate_hz: float = 50.0,
        faults: Faults | None = None,
        history_s: float = 0.0,
        history_step_s: float = 1.0,
    ) -> None:
        self.symbols = symbols
        self.state = VenueState(symbols=symbols, seed=seed)
        self.rate_hz = rate_hz
        self.faults = faults or Faults()
        self.history_s = history_s
        self.history_step_s = history_step_s
        self.connections = 0
        self.rest_requests = 0
        self.messages_sent = 0
        self._stopping = False
        self._ws_server: Any = None
        self._rest_server: asyncio.AbstractServer | None = None
        self._ws_port = 0
        self._rest_port = 0
        self._history: list[dict[str, Any]] = []

    # -- addresses -----------------------------------------------------------

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self._ws_port}"

    @property
    def rest_url(self) -> str:
        return f"http://127.0.0.1:{self._rest_port}"

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        from websockets.asyncio.server import serve

        self._ws_server = await serve(self._handle_ws, "127.0.0.1", 0)
        self._ws_port = next(iter(self._ws_server.sockets)).getsockname()[1]
        self._rest_server = await asyncio.start_server(self._handle_rest, "127.0.0.1", 0)
        assert self._rest_server.sockets is not None
        self._rest_port = self._rest_server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        # Set first: a handler parked on a fault loop watches this to unwind.
        self._stopping = True
        if self._ws_server is not None:
            self._ws_server.close()
            with contextlib.suppress(Exception):
                await self._ws_server.wait_closed()
            self._ws_server = None
        if self._rest_server is not None:
            self._rest_server.close()
            with contextlib.suppress(Exception):
                await self._rest_server.wait_closed()
            self._rest_server = None

    async def __aenter__(self) -> CoinbaseConformanceVenue:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.stop()

    # -- websocket -----------------------------------------------------------

    async def _handle_ws(self, socket: Any) -> None:
        """One client connection: read the subscribe frame, then stream."""
        self.connections += 1
        try:
            raw = await asyncio.wait_for(socket.recv(), timeout=5.0)
        except (TimeoutError, Exception):
            return
        try:
            request = json.loads(raw)
        except (TypeError, ValueError):
            await socket.send(json.dumps({"type": "error", "message": "not JSON"}))
            return
        products = tuple(request.get("product_ids") or self.symbols)
        await socket.send(
            json.dumps(
                {
                    "type": "subscriptions",
                    "channels": [
                        {"name": name, "product_ids": list(products)}
                        for name in request.get("channels", [])
                    ],
                }
            )
        )
        await self._stream(socket, products)

    async def _stream(self, socket: Any, products: tuple[str, ...]) -> None:
        from forecaster.clock import now_ns

        sent = 0
        previous: str | None = None
        interval = 1.0 / self.rate_hz if self.rate_hz > 0 else 0.0

        # Every send goes through `_send`, which treats a hung-up client as the
        # end of the handler rather than as an error. A client disconnecting is
        # the normal case here — the tests stop reading and tear the venue down —
        # and letting `ConnectionClosedOK` escape turned that into a spurious
        # failure in an unrelated test.
        #
        # Back-dated history first, as fast as the socket will take it. This is
        # what makes an end-to-end forecast testable in seconds instead of in
        # half an hour: the volatility estimator needs a real history, and a
        # venue that only ever emits "now" can never supply one.
        for message in self._replay_history(products, now_ns()):
            if not await self._send(socket, json.dumps(message)):
                return
            sent += 1
            self.messages_sent += 1

        # Opening book snapshots, so the depth features have something to read.
        for symbol in products:
            if not await self._send(socket, json.dumps(self._snapshot_message(symbol))):
                return
            sent += 1

        while True:
            if self.faults.silent_after is not None and sent >= self.faults.silent_after:
                # The open-but-silent socket: the point is that nothing about the
                # connection looks wrong to anything except a clock.
                #
                # Idled in short steps, not one long sleep. A single
                # `asyncio.sleep(3600)` keeps this handler alive, and the
                # server's `wait_closed()` waits for its handlers — so shutting
                # the venue down blocked for an hour. The test that found this
                # did not fail; it simply never finished, which is worse.
                while not self._stopping:
                    await asyncio.sleep(0.05)
                    if getattr(socket, "close_code", None) is not None:
                        return
                return
            if self.faults.drop_after is not None and sent >= self.faults.drop_after:
                await socket.close(code=1011, reason="conformance: scripted drop")
                return

            sent += 1
            self.messages_sent += 1
            payload = self._next_message(products, sent)

            if self._fires(self.faults.malformed_every, sent):
                # Deliberately truncated JSON.
                if not await self._send(socket, '{"type": "match", "price": '):
                    return
                continue
            if self._fires(self.faults.duplicate_every, sent) and previous is not None:
                if not await self._send(socket, previous):
                    return
                continue

            text = json.dumps(payload)
            previous = text
            if not await self._send(socket, text):
                return
            if interval:
                await asyncio.sleep(interval)

    @staticmethod
    async def _send(socket: Any, text: str) -> bool:
        """Send one frame. False means the client has gone, so stop."""
        try:
            await socket.send(text)
        except Exception:
            return False
        return True

    @staticmethod
    def _fires(every: int | None, counter: int) -> bool:
        return every is not None and every > 0 and counter % every == 0

    def _replay_history(self, products: tuple[str, ...], now: int) -> Iterable[dict[str, Any]]:
        """Back-dated trades and quotes covering `history_s` seconds up to now."""
        if self.history_s <= 0:
            return []
        messages: list[dict[str, Any]] = []
        steps = int(self.history_s / self.history_step_s)
        for index in range(steps, 0, -1):
            stamp = now - int(index * self.history_step_s * NS_PER_SECOND)
            for symbol in products:
                price = self.state.step(symbol, self.history_step_s)
                messages.append(self._match_message(symbol, price, stamp))
                messages.append(self._ticker_message(symbol, price, stamp))
        self._history = messages
        return messages

    def _next_message(self, products: tuple[str, ...], counter: int) -> dict[str, Any]:
        from forecaster.clock import now_ns

        # Symbol and message type must advance independently. Keying both off
        # `counter` with the same modulus made every even counter a BTC ticker
        # and every odd one an ETH match, so one symbol never saw a trade and
        # the other never saw a quote. The live-check caught it; the note is
        # here so it is not reintroduced.
        symbol = products[(counter // 2) % len(products)]
        stamp = now_ns()
        if self._fires(self.faults.reverse_time_every, counter):
            stamp -= 30 * NS_PER_SECOND

        price = self.state.step(symbol, 1.0 / max(self.rate_hz, 1.0))
        if self._fires(self.faults.zero_price_every, counter):
            price = 0.0
        elif self._fires(self.faults.negative_price_every, counter):
            price = -price

        # Alternate trades and quotes so both paths stay exercised.
        if counter % 2 == 0 and not self.faults.drop_quotes:
            return self._ticker_message(symbol, price, stamp, counter=counter)
        return self._match_message(symbol, price, stamp)

    def _match_message(self, symbol: str, price: float, stamp: int) -> dict[str, Any]:
        # `side` is the MAKER's side, as Coinbase publishes it. An adapter that
        # reads it as the aggressor gets every order-flow feature backwards, so
        # emitting it the venue's way is the point.
        maker_side = "sell" if self.state._rng.random() < 0.5 else "buy"
        return {
            "type": "match",
            "trade_id": self.state.next_trade_id(),
            "sequence": self.state.next_sequence(),
            "maker_order_id": "00000000-0000-0000-0000-000000000000",
            "taker_order_id": "00000000-0000-0000-0000-000000000001",
            "time": iso_ns(stamp),
            "product_id": symbol,
            "size": f"{abs(self.state._rng.gauss(0.0, 1.0)) * 0.02 + 0.001:.8f}",
            "price": f"{price:.2f}",
            "side": maker_side,
        }

    def _ticker_message(
        self, symbol: str, price: float, stamp: int, *, counter: int = 0
    ) -> dict[str, Any]:
        half = self.state.spread(symbol) / 2.0
        if self._fires(self.faults.wide_spread_every, counter):
            half = price * 0.025
        bid, ask = price - half, price + half
        if self._fires(self.faults.crossed_book_every, counter):
            bid, ask = ask, bid
        return {
            "type": "ticker",
            "sequence": self.state.next_sequence(),
            "product_id": symbol,
            "price": f"{price:.2f}",
            "open_24h": f"{price * 0.99:.2f}",
            "volume_24h": "12345.67890000",
            "low_24h": f"{price * 0.97:.2f}",
            "high_24h": f"{price * 1.03:.2f}",
            "volume_30d": "456789.01234567",
            "best_bid": f"{bid:.2f}",
            "best_bid_size": "1.50000000",
            "best_ask": f"{ask:.2f}",
            "best_ask_size": "1.20000000",
            "side": "buy",
            "time": iso_ns(stamp),
            "trade_id": self.state.trade_id,
            "last_size": "0.01000000",
        }

    def _snapshot_message(self, symbol: str) -> dict[str, Any]:
        price = self.state.prices[symbol]
        half = self.state.spread(symbol) / 2.0
        bids = [[f"{price - half - i * half:.2f}", f"{1.0 + i * 0.1:.8f}"] for i in range(10)]
        asks = [[f"{price + half + i * half:.2f}", f"{1.0 + i * 0.1:.8f}"] for i in range(10)]
        return {"type": "snapshot", "product_id": symbol, "bids": bids, "asks": asks}

    # -- rest ----------------------------------------------------------------

    async def _handle_rest(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """A deliberately small HTTP/1.1 server. Enough for the endpoints polled."""
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        except (TimeoutError, Exception):
            writer.close()
            return
        if not request_line:
            writer.close()
            return
        # Drain the headers so the socket is left in a sane state.
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
        self.rest_requests += 1

        if self.faults.rest_timeout:
            # Longer than any client timeout in the codebase, then hang up.
            await asyncio.sleep(30.0)
            with contextlib.suppress(Exception):
                writer.close()
            return

        try:
            target = request_line.decode("latin-1").split(" ")[1]
        except (IndexError, UnicodeDecodeError):
            target = "/"
        status, body = self._rest_response(target)
        if self.faults.rest_status is not None:
            status = self.faults.rest_status
            body = json.dumps({"message": "conformance: scripted status"})
        payload = body.encode()
        head = (
            f"HTTP/1.1 {status} {'OK' if status == 200 else 'ERROR'}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        with contextlib.suppress(Exception):
            writer.write(head + payload)
            await writer.drain()
            writer.close()

    def _rest_response(self, target: str) -> tuple[int, str]:
        from forecaster.clock import now_ns

        path = target.split("?")[0]
        parts = [p for p in path.split("/") if p]
        # /products/{symbol}/ticker | /trades | /book
        if len(parts) == 3 and parts[0] == "products":
            symbol, endpoint = parts[1], parts[2]
            if symbol not in self.state.prices:
                return 404, json.dumps({"message": "NotFound"})
            price = self.state.prices[symbol]
            half = self.state.spread(symbol) / 2.0
            stamp = iso_ns(now_ns())
            if endpoint == "ticker":
                return 200, json.dumps(
                    {
                        "trade_id": self.state.trade_id,
                        "price": f"{price:.2f}",
                        "size": "0.01000000",
                        "time": stamp,
                        "bid": f"{price - half:.2f}",
                        "ask": f"{price + half:.2f}",
                        "volume": "12345.67890000",
                    }
                )
            if endpoint == "trades":
                # Newest first, which is the ordering the real endpoint uses and
                # which the adapter has to reverse.
                rows = []
                for index in range(20):
                    stepped = self.state.step(symbol, 1.0)
                    rows.append(
                        {
                            "time": iso_ns(now_ns() - index * NS_PER_SECOND),
                            "trade_id": self.state.next_trade_id(),
                            "price": f"{stepped:.2f}",
                            "size": "0.01500000",
                            "side": "sell" if index % 2 else "buy",
                        }
                    )
                return 200, json.dumps(rows)
            if endpoint == "book":
                bids = [
                    [f"{price - half - i * half:.2f}", f"{1.0 + i * 0.1:.8f}", 1] for i in range(10)
                ]
                asks = [
                    [f"{price + half + i * half:.2f}", f"{1.0 + i * 0.1:.8f}", 1] for i in range(10)
                ]
                return 200, json.dumps(
                    {"sequence": self.state.next_sequence(), "bids": bids, "asks": asks}
                )
        if path in ("/time", "/"):
            return 200, json.dumps({"iso": iso_ns(now_ns()), "epoch": now_ns() / NS_PER_SECOND})
        return 404, json.dumps({"message": "NotFound"})
