"""Every venue this system knows how to reach, and how to test whether it can.

Two jobs, deliberately in one place.

The first is a **catalogue**: for each reputable venue, its production REST and
WebSocket hostnames, a public unauthenticated endpoint that returns a BTC price,
and whether an adapter exists for it yet. Keeping that beside
`endpoints.VENUE_HOSTS` means adding a venue is one edit in two obvious places
rather than a hunt.

The second is a **reachability probe**. When market data will not arrive, the
question is always the same and is always asked badly: "is it the code, the
network, or the venue?". The probe answers it per venue and per layer — DNS, TCP,
TLS, HTTP, WebSocket upgrade — so the answer is a table rather than an opinion.

It exists because this project's build environment blocks every exchange, and
"blocked" needed to be demonstrated across many venues at several layers rather
than asserted from one failed curl. It is equally useful on a normal machine:
run it first and it will say in fifteen seconds which venue to use.

No credentials, ever. Every endpoint here is public and unauthenticated, which is
why they can be probed at all.
"""

from __future__ import annotations

import asyncio
import socket
import ssl
import time
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlsplit

#: Seconds before a probe gives up on one layer. Short: the question is whether a
#: route exists, and a route that needs longer than this is not one to forecast on.
PROBE_TIMEOUT_S = 12.0


@dataclass(frozen=True)
class VenueSpec:
    """A venue, its public endpoints, and what this system can do with it."""

    name: str
    rest_url: str
    """A public, unauthenticated endpoint returning a BTC price. Probed for real."""
    ws_url: str
    btc_symbol: str
    eth_symbol: str
    adapter: bool
    """Whether `marketdata/venues/` has an adapter. False means reachable-but-not-wired."""
    note: str = ""

    @property
    def rest_host(self) -> str:
        return urlsplit(self.rest_url).hostname or ""

    @property
    def ws_host(self) -> str:
        return urlsplit(self.ws_url).hostname or ""

    @property
    def ws_port(self) -> int:
        return urlsplit(self.ws_url).port or 443


#: Ordered by preference. Adapters exist for the first three; the rest are
#: catalogued so the probe can answer "would any venue work here?" without
#: writing an adapter first, which would be the wrong order of work.
VENUES: tuple[VenueSpec, ...] = (
    VenueSpec(
        name="kraken",
        rest_url="https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
        ws_url="wss://ws.kraken.com/v2",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=True,
        note="US-accessible, public data, no key. Reports the aggressor side directly.",
    ),
    VenueSpec(
        name="coinbase",
        rest_url="https://api.exchange.coinbase.com/products/BTC-USD/ticker",
        ws_url="wss://ws-feed.exchange.coinbase.com",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=True,
        note="The default. Public data, no key, works in the US.",
    ),
    VenueSpec(
        name="binance",
        rest_url="https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT",
        ws_url="wss://stream.binance.com:9443/ws/btcusdt@trade",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=True,
        note="Deepest book. binance.com is not available to US users; see binance.us.",
    ),
    VenueSpec(
        name="binance.us",
        rest_url="https://api.binance.us/api/v3/ticker/bookTicker?symbol=BTCUSD",
        ws_url="wss://stream.binance.us:9443/ws/btcusd@trade",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=True,
        note="The US entity. Same wire format as binance, so the adapter is shared.",
    ),
    VenueSpec(
        name="bitstamp",
        rest_url="https://www.bitstamp.net/api/v2/ticker/btcusd/",
        ws_url="wss://ws.bitstamp.net",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=False,
        note="Public data, no key. No adapter yet.",
    ),
    VenueSpec(
        name="gemini",
        rest_url="https://api.gemini.com/v1/pubticker/btcusd",
        ws_url="wss://api.gemini.com/v1/marketdata/BTCUSD",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=False,
        note="US-regulated, public data, no key. No adapter yet.",
    ),
    VenueSpec(
        name="okx",
        rest_url="https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
        ws_url="wss://ws.okx.com:8443/ws/v5/public",
        btc_symbol="BTC-USDT",
        eth_symbol="ETH-USDT",
        adapter=False,
        note="USDT pairs rather than USD. No adapter yet.",
    ),
    VenueSpec(
        name="bitfinex",
        rest_url="https://api-pub.bitfinex.com/v2/ticker/tBTCUSD",
        ws_url="wss://api-pub.bitfinex.com/ws/2",
        btc_symbol="BTC-USD",
        eth_symbol="ETH-USD",
        adapter=False,
        note="Public data, no key. No adapter yet.",
    ),
)


@dataclass
class LayerResult:
    """One layer of one venue: did it work, and what exactly happened."""

    ok: bool
    detail: str
    error_class: str | None = None
    elapsed_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class VenueProbe:
    """Every layer, for one venue."""

    venue: str
    rest_host: str
    ws_host: str
    adapter: bool
    dns: LayerResult | None = None
    tcp: LayerResult | None = None
    tls: LayerResult | None = None
    rest: LayerResult | None = None
    websocket: LayerResult | None = None
    http_status: int | None = None
    sample: str | None = None
    """A snippet of whatever the REST endpoint actually returned, on success."""

    @property
    def usable(self) -> bool:
        """Public unauthenticated market data actually arrived."""
        return bool(self.rest and self.rest.ok)

    @property
    def tls_intercepted(self) -> bool:
        """The TLS handshake succeeded against something that is not the venue."""
        return bool(self.tls and self.tls.error_class == "InterceptedTLS")

    @property
    def blocked_by_proxy(self) -> bool:
        """The failure is an egress policy denial rather than the venue."""
        for layer in (self.rest, self.websocket):
            if (
                layer
                and not layer.ok
                and ("403" in layer.detail or "proxy" in layer.detail.lower())
            ):
                return True
        return False

    def to_dict(self) -> dict[str, Any]:
        return {
            "venue": self.venue,
            "rest_host": self.rest_host,
            "ws_host": self.ws_host,
            "adapter_exists": self.adapter,
            "usable_public_market_data": self.usable,
            "blocked_by_egress_policy": self.blocked_by_proxy,
            "tls_intercepted_before_venue": self.tls_intercepted,
            "http_status": self.http_status,
            "sample": self.sample,
            "layers": {
                name: (layer.to_dict() if layer else None)
                for name, layer in (
                    ("dns", self.dns),
                    ("tcp", self.tcp),
                    ("tls", self.tls),
                    ("rest", self.rest),
                    ("websocket", self.websocket),
                )
            },
        }


def _timed(start: float) -> float:
    return (time.monotonic() - start) * 1000.0


def probe_dns(host: str) -> LayerResult:
    start = time.monotonic()
    try:
        # getaddrinfo's sockaddr is (host, port) for IPv4 and a 4-tuple for IPv6,
        # so the first element is typed as str | int. It is always the address.
        addresses = sorted({str(info[4][0]) for info in socket.getaddrinfo(host, None)})
        return LayerResult(True, ", ".join(addresses[:3]), None, _timed(start))
    except Exception as exc:
        return LayerResult(False, str(exc)[:120], type(exc).__name__, _timed(start))


def probe_tcp(host: str, port: int) -> LayerResult:
    """A direct connection, deliberately not through the proxy.

    Separating this from the HTTP probe is what distinguishes "the venue is
    unreachable" from "something in the middle refused on our behalf". A direct
    TCP connect that succeeds while HTTPS through the proxy returns 403 is an
    egress policy, full stop.
    """
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=PROBE_TIMEOUT_S):
            return LayerResult(True, f"connected to {host}:{port}", None, _timed(start))
    except Exception as exc:
        return LayerResult(False, str(exc)[:120], type(exc).__name__, _timed(start))


#: Certificate authorities that actually sign public exchange certificates. Used
#: only to answer "was that handshake with the venue, or with something standing
#: in front of it?" — see `probe_tls`.
PUBLIC_CAS = (
    "digicert",
    "let's encrypt",
    "internet security research group",
    "google trust services",
    "amazon",
    "sectigo",
    "globalsign",
    "cloudflare",
    "godaddy",
    "entrust",
    "identrust",
    "comodo",
    "starfield",
)


def probe_tls(host: str, port: int) -> LayerResult:
    """Shake hands, then look at whose certificate came back.

    Checking the issuer rather than stopping at "handshake succeeded" exists
    because of a result that is easy to read exactly backwards. In this project's
    build environment a direct TCP connection to every exchange succeeds, and so
    does the TLS handshake — which reads as "the venues are reachable, something
    higher up is at fault". They are not. Those certificates are issued by the
    environment's own egress gateway, which terminates the connection, presents a
    substituted certificate for whatever hostname was asked for, and refuses.

    A handshake proves a connection to *something*. The issuer is what says
    whether that something was the venue. Reporting "tls ok" without it invites
    precisely the wrong conclusion — here, and on any machine behind a corporate
    proxy that does the same thing.
    """
    start = time.monotonic()
    context = ssl.create_default_context()
    try:
        with (
            socket.create_connection((host, port), timeout=PROBE_TIMEOUT_S) as raw,
            context.wrap_socket(raw, server_hostname=host) as tls,
        ):
            version = tls.version() or "unknown"
            certificate = tls.getpeercert() or {}
    except Exception as exc:
        return LayerResult(False, str(exc)[:120], type(exc).__name__, _timed(start))

    # `getpeercert()` types the issuer as a tuple of relative distinguished
    # names, each a tuple of (key, value) pairs — nested one level deeper than it
    # looks, and typed loosely enough that mypy cannot assume the shape.
    issuer: dict[str, str] = {}
    for relative_name in certificate.get("issuer", ()):
        for pair in relative_name:
            if isinstance(pair, tuple) and len(pair) == 2:
                issuer[str(pair[0])] = str(pair[1])
    organisation = issuer.get("organizationName", "")
    if any(known in organisation.lower() for known in PUBLIC_CAS):
        return LayerResult(True, f"{version}, issued by {organisation}", None, _timed(start))
    return LayerResult(
        False,
        f"{version}, but issued by {organisation or 'an unnamed CA'} — this connection "
        "is terminated before it reaches the venue",
        "InterceptedTLS",
        _timed(start),
    )


async def probe_rest(spec: VenueSpec) -> tuple[LayerResult, int | None, str | None]:
    """Fetch real public market data. Success means a price actually arrived."""
    import httpx

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S, follow_redirects=True) as client:
            response = await client.get(spec.rest_url)
        body = response.text[:160].replace("\n", " ")
        if response.status_code == 200:
            return (
                LayerResult(True, f"HTTP 200, {len(response.content)} bytes", None, _timed(start)),
                200,
                body,
            )
        return (
            LayerResult(
                False, f"HTTP {response.status_code}: {body[:80]}", "HTTPStatus", _timed(start)
            ),
            response.status_code,
            None,
        )
    except Exception as exc:
        return (
            LayerResult(False, str(exc)[:120], type(exc).__name__, _timed(start)),
            None,
            None,
        )


async def probe_websocket(spec: VenueSpec) -> LayerResult:
    start = time.monotonic()
    try:
        import websockets

        socket_ = await asyncio.wait_for(
            websockets.connect(spec.ws_url, open_timeout=PROBE_TIMEOUT_S, close_timeout=2.0),
            timeout=PROBE_TIMEOUT_S + 3.0,
        )
        await socket_.close()
        return LayerResult(True, "upgrade accepted", None, _timed(start))
    except Exception as exc:
        return LayerResult(False, str(exc)[:120], type(exc).__name__, _timed(start))


async def probe_venue(spec: VenueSpec, *, include_ws: bool = True) -> VenueProbe:
    result = VenueProbe(
        venue=spec.name,
        rest_host=spec.rest_host,
        ws_host=spec.ws_host,
        adapter=spec.adapter,
    )
    result.dns = await asyncio.to_thread(probe_dns, spec.rest_host)
    if result.dns.ok:
        result.tcp = await asyncio.to_thread(probe_tcp, spec.rest_host, 443)
        if result.tcp.ok:
            result.tls = await asyncio.to_thread(probe_tls, spec.rest_host, 443)
    rest, status, sample = await probe_rest(spec)
    result.rest, result.http_status, result.sample = rest, status, sample
    if include_ws:
        result.websocket = await probe_websocket(spec)
    return result


async def probe_all(
    specs: tuple[VenueSpec, ...] = VENUES, *, include_ws: bool = True
) -> list[VenueProbe]:
    """Probe every venue in order. Sequential, so one hang cannot hide another."""
    return [await probe_venue(spec, include_ws=include_ws) for spec in specs]


def first_usable(probes: list[VenueProbe]) -> VenueProbe | None:
    """The first venue that returned real market data AND has an adapter.

    Both conditions. A venue that answers but has no adapter is a reason to write
    one, not a venue this system can use today, and conflating the two would
    produce a report claiming a route that does not exist.
    """
    return next((p for p in probes if p.usable and p.adapter), None)
