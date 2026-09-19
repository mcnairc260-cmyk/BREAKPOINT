"""Real exchange adapters.

Each venue is a thin HTTP/WebSocket adapter with no vendor SDK, so adding one is
a single small file and no new dependency. Coinbase is the hardened default:
its market data needs no API key at all, which removes an entire class of
security problem before it exists.

**None of these has been exercised against a live venue in this repository's
build environment.** Every exchange host is blocked by network policy there, and
WebSocket upgrades are unsupported through its proxy. They are unit-tested
against fixtures written from each venue's public API documentation — which
proves the parsing, and proves nothing about the connection. `scripts/smoke_live.py`
is the thirty-second check to run somewhere with real network access.
"""

from __future__ import annotations

from forecaster.marketdata.provider import MarketDataProvider, ProviderError


def build_venue_provider(
    venue: str, *, symbols: tuple[str, ...], transport: str = "websocket", **kwargs: object
) -> MarketDataProvider:
    if venue == "coinbase":
        from forecaster.marketdata.venues.coinbase import CoinbaseProvider

        return CoinbaseProvider(symbols=symbols, transport=transport, **kwargs)  # type: ignore[arg-type]
    if venue == "binance":
        from forecaster.marketdata.venues.binance import BinanceProvider

        return BinanceProvider(symbols=symbols, transport=transport, **kwargs)  # type: ignore[arg-type]
    if venue == "kraken":
        from forecaster.marketdata.venues.kraken import KrakenProvider

        return KrakenProvider(symbols=symbols, transport=transport, **kwargs)  # type: ignore[arg-type]
    raise ProviderError(f"unknown venue: {venue!r} (expected coinbase, binance or kraken)")
