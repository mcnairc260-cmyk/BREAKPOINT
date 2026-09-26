#!/usr/bin/env python3
"""Prove a venue adapter works against the real exchange. Takes about 30 seconds.

**Run this from a machine with ordinary network access.** It is the one check
this project could not perform on itself: the environment it was built in cannot
reach any exchange, so every venue adapter here is tested against fixtures
written from published API documentation. Fixtures prove the parsing. Only this
proves the connection.

    make smoke                                    # Coinbase, WebSocket
    make smoke ARGS="--venue kraken"
    make smoke ARGS="--transport poll"            # where WebSockets are blocked

Run it through make, or with the project's own interpreter
(`engine/.venv/bin/python scripts/smoke_live.py`). A bare `python` almost
certainly lacks `httpx` and `websockets` and will fail on import.

It reports what it actually saw — prices, spreads, trade counts, whether the
aggressor side was published — and it says plainly when something looks wrong.
It writes nothing to the database.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "src"))

from forecaster.clock import iso, now_ns  # noqa: E402
from forecaster.marketdata.provider import build_provider  # noqa: E402
from forecaster.types import NS_PER_SECOND, BookSnapshot, Quote, Side, Trade  # noqa: E402


async def smoke(venue: str, transport: str, symbols: tuple[str, ...], seconds: float) -> int:
    # The websockets library logs a full traceback to stderr for every failed
    # handshake. During a reconnect loop against a blocked host that is six
    # tracebacks of noise wrapped around one useful line, and it buries the
    # diagnosis this script exists to print. The provider records the error and
    # this script reports it, so the library's own logging adds nothing.
    logging.getLogger("websockets").setLevel(logging.CRITICAL)
    logging.getLogger("websockets.client").setLevel(logging.CRITICAL)

    # A failed handshake also leaves unretrieved exceptions on internal tasks,
    # which asyncio prints itself — once per reconnect attempt. They are counted
    # rather than printed: nothing is hidden (the total is reported at the end),
    # but six copies of a library's internal error must not bury the one line
    # that says what is actually wrong.
    background: Counter[str] = Counter()

    def _collect(_loop: object, context: dict[str, object]) -> None:
        exception = context.get("exception")
        label = (
            f"{type(exception).__name__}: {exception}"
            if exception is not None
            else str(context.get("message", "unknown"))
        )
        background[label] += 1

    asyncio.get_running_loop().set_exception_handler(_collect)

    provider = build_provider(
        "live", venue=venue, symbols=symbols, transport=transport
    )
    print(f"connecting to {venue} over {transport} for {', '.join(symbols)}…")

    trades: Counter[str] = Counter()
    quotes: Counter[str] = Counter()
    books: Counter[str] = Counter()
    sides: Counter[str] = Counter()
    last_price: dict[str, float] = {}
    last_quote: dict[str, Quote] = {}
    latencies: list[int] = []
    started = now_ns()
    deadline = started + int(seconds * NS_PER_SECOND)

    async def consume() -> None:
        async for event in provider.stream(symbols):
            if isinstance(event, Trade):
                trades[event.symbol] += 1
                sides[event.side.value] += 1
                last_price[event.symbol] = event.price
                latencies.append(event.received_ns - event.exchange_ns)
            elif isinstance(event, Quote):
                quotes[event.symbol] += 1
                last_quote[event.symbol] = event
            elif isinstance(event, BookSnapshot):
                books[event.symbol] += 1
            if now_ns() >= deadline:
                break

    # A hard overall deadline. The provider reconnects forever by design — which
    # is right for a long-running collector and wrong here, because a venue that
    # never connects would leave this script spinning silently instead of
    # reporting the failure it exists to report.
    try:
        await asyncio.wait_for(consume(), timeout=seconds + 10.0)
    except asyncio.TimeoutError:
        print(f"\nFAILED: no usable data from {venue} within {seconds + 10:.0f}s.")
        print(f"  connected: {provider.health.connected}")
        print(f"  reconnect attempts: {provider.health.reconnects}")
        if provider.health.last_error:
            print(f"  last error: {provider.health.last_error}")
        print()
        if transport == "websocket":
            print("If a firewall or proxy blocks WebSocket upgrades, try --transport poll.")
            print("Otherwise run this from a network that allows outbound connections")
            print(f"to {venue}.")
        else:
            print(f"Polling is blocked too, so this is not a WebSocket problem — {venue}")
            print("is unreachable from this network. Try another venue (--venue kraken)")
            print("or run this where outbound connections are permitted.")
        await provider.close()
        return 1
    except Exception as exc:  # noqa: BLE001 - the whole point is to report failures
        print(f"\nFAILED: {type(exc).__name__}: {exc}")
        if provider.health.last_error:
            print(f"last provider error: {provider.health.last_error}")
        await provider.close()
        return 1
    finally:
        await provider.close()

    print(f"\nran for {(now_ns() - started) / NS_PER_SECOND:.1f}s, ending {iso(now_ns())}\n")

    problems: list[str] = []
    for symbol in symbols:
        print(f"{symbol}")
        print(f"  trades  {trades[symbol]:>6}")
        print(f"  quotes  {quotes[symbol]:>6}")
        print(f"  books   {books[symbol]:>6}")
        if symbol in last_price:
            print(f"  last    ${last_price[symbol]:,.2f}")
        else:
            problems.append(f"{symbol}: no trades seen")
        quote = last_quote.get(symbol)
        if quote:
            spread_bps = quote.spread / quote.mid * 10_000 if quote.mid else 0.0
            print(f"  book    ${quote.bid:,.2f} / ${quote.ask:,.2f}  ({spread_bps:.2f} bps)")
            if quote.bid >= quote.ask:
                problems.append(f"{symbol}: crossed book — bid at or above ask")
            if spread_bps > 50:
                problems.append(f"{symbol}: spread of {spread_bps:.0f} bps is implausibly wide")
        else:
            problems.append(f"{symbol}: no quotes seen")
        print()

    if sides:
        unknown = sides.get(Side.UNKNOWN.value, 0)
        total = sum(sides.values())
        print(f"aggressor side: {dict(sides)}")
        if unknown > total * 0.5:
            problems.append(
                "most trades had no aggressor side — order-flow features will report "
                "MISSING rather than guessing"
            )
    if latencies:
        latencies.sort()
        median_ms = latencies[len(latencies) // 2] / 1e6
        print(f"median feed latency: {median_ms:.0f} ms")
        if median_ms > 5_000:
            problems.append(f"median latency of {median_ms:.0f} ms suggests a clock or routing problem")
        if median_ms < -1_000:
            problems.append(
                f"median latency of {median_ms:.0f} ms is negative — this machine's clock "
                "is likely ahead of the venue's"
            )

    if background:
        print("background errors from the network stack (not necessarily faults):")
        for label, count in background.most_common(3):
            print(f"  {count}x {label}")
        print()

    health = provider.health
    if health.reconnects:
        print(f"reconnects: {health.reconnects} (last: {health.last_error})")
    if health.malformed_messages:
        problems.append(f"{health.malformed_messages} messages could not be parsed")
    if health.rate_limited:
        problems.append(f"rate-limited {health.rate_limited} times — lengthen the poll interval")

    print()
    if problems:
        print("PROBLEMS")
        for problem in problems:
            print(f"  · {problem}")
        return 1
    print(f"{venue} over {transport} looks healthy.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venue", default="coinbase", choices=["coinbase", "binance", "kraken"])
    parser.add_argument("--transport", default="websocket", choices=["websocket", "poll"])
    parser.add_argument("--symbols", default="BTC-USD,ETH-USD")
    parser.add_argument("--seconds", type=float, default=30.0)
    args = parser.parse_args()
    symbols = tuple(s.strip() for s in args.symbols.split(",") if s.strip())
    return asyncio.run(smoke(args.venue, args.transport, symbols, args.seconds))


if __name__ == "__main__":
    sys.exit(main())
