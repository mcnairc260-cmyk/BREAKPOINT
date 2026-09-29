"""Which hosts are the real exchange, and which are not.

This module exists because of one failure mode that would quietly destroy the
value of everything else in the repository: **market data from something that is
not the exchange being recorded as if it were.**

The path to that failure is short and entirely plausible. Every venue adapter
takes `ws_url` and `rest_url` as constructor arguments, because a test double,
a staging endpoint or a local capture server all need somewhere to point. If the
adapter also hardcodes `DataSource.LIVE`, then pointing it at `127.0.0.1` writes
rows labelled LIVE into the same table as real ones, the labels stop meaning
anything, and no later audit can separate them — the prediction log is
append-only, so the contamination is permanent.

So the label is not a constructor argument and not a constant. It is **derived
from the host actually being connected to**, by exact match against the list
below. A URL that is not one of these cannot produce LIVE data, whatever it is
called and whatever it serves. There is deliberately no override: an escape
hatch here would be used exactly once, on the day it mattered most.

The cost of this design is that a venue changing its hostname makes the adapter
silently downgrade to SIMULATED rather than silently mislabel. That is the right
way round — a track record that is too small is repairable, a track record that
is quietly wrong is not.

Adding a venue means adding its real hosts here, in the same commit as the
adapter.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from forecaster.types import DataSource

#: Exact hostnames operated by each venue. Lower case, no port, no path.
#: Subdomains are NOT matched by suffix: `evil-coinbase.com` and
#: `ws-feed.exchange.coinbase.com.attacker.net` both fail, which a suffix match
#: would not guarantee.
VENUE_HOSTS: dict[str, frozenset[str]] = {
    "coinbase": frozenset(
        {
            "ws-feed.exchange.coinbase.com",
            "api.exchange.coinbase.com",
            # The retail domain, kept because Coinbase has moved market data
            # between the two before and a reader checking this list should see
            # both spellings rather than assume one is a typo.
            "ws-feed.pro.coinbase.com",
            "api.pro.coinbase.com",
            "advanced-trade-ws.coinbase.com",
            "api.coinbase.com",
        }
    ),
    "binance": frozenset(
        {
            "stream.binance.com",
            "api.binance.com",
            "data-stream.binance.vision",
            "data-api.binance.vision",
            "api.binance.us",
            "stream.binance.us",
        }
    ),
    "kraken": frozenset(
        {
            "ws.kraken.com",
            "api.kraken.com",
        }
    ),
}


def host_of(url: str) -> str:
    """The bare lower-case hostname of a URL, with no port.

    `urlsplit().hostname` already strips the port, lower-cases, and handles
    bracketed IPv6 literals. Doing this by hand with `split(":")` is where
    allowlists usually break.
    """
    return (urlsplit(url).hostname or "").lower()


def is_real_venue(venue: str, *urls: str) -> bool:
    """True only if **every** supplied URL belongs to the named venue.

    Every, not any: an adapter that reads trades from the exchange but its order
    book from somewhere else is not producing exchange data, and one honest URL
    must not launder the other.
    """
    allowed = VENUE_HOSTS.get(venue)
    if not allowed:
        return False
    hosts = [host_of(url) for url in urls if url]
    if not hosts:
        return False
    return all(host in allowed for host in hosts)


def classify_endpoint(venue: str, *urls: str) -> DataSource:
    """The `data_source` label an adapter pointed at these URLs is allowed to use.

    LIVE for the venue's own hosts. SIMULATED for anything else — including a
    conformance double, a staging endpoint, or a typo. SIMULATED is the safe
    direction: it can never be mistaken for evidence about a real market.
    """
    return DataSource.LIVE if is_real_venue(venue, *urls) else DataSource.SIMULATED


def endpoint_note(venue: str, *urls: str) -> str:
    """A line for logs and reports saying what was connected to and how it counts."""
    hosts = sorted({host_of(url) for url in urls if url})
    joined = ", ".join(hosts) or "(none)"
    if is_real_venue(venue, *urls):
        return f"{venue}: real venue endpoint ({joined}) — data recorded as LIVE"
    return (
        f"{venue}: NOT a recognised {venue} endpoint ({joined}) — "
        "data recorded as SIMULATED and excluded from every live metric"
    )
