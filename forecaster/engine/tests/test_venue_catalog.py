"""The venue catalogue and the reachability probe.

Two things are worth pinning here, and neither is about the network.

The first is that the catalogue and the LIVE allowlist agree. Every venue with an
adapter must have its hostnames in `endpoints.VENUE_HOSTS`, or the adapter would
connect to the real exchange and label the data SIMULATED — a silent,
unrecoverable loss of a live track record.

The second is the probe's own judgement. A TLS handshake that succeeds against a
certificate no public CA signed means the connection was terminated before the
venue, and reporting that as "tls ok" is how a whole afternoon gets spent blaming
the wrong layer. The probe has to draw that distinction, so the distinction is
tested rather than trusted.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import pytest

from forecaster.marketdata.venues.catalog import (
    PUBLIC_CAS,
    VENUES,
    LayerResult,
    VenueProbe,
    first_usable,
)
from forecaster.marketdata.venues.endpoints import VENUE_HOSTS, classify_endpoint
from forecaster.types import DataSource


def test_the_catalogue_is_not_empty_and_has_no_duplicates() -> None:
    assert len(VENUES) >= 6
    names = [spec.name for spec in VENUES]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("spec", VENUES, ids=lambda s: s.name)
def test_every_endpoint_is_https_or_wss_and_public(spec) -> None:
    """No credentials, ever. A probe that needed a key could not be run by anyone."""
    assert spec.rest_url.startswith("https://")
    assert spec.ws_url.startswith("wss://")
    for url in (spec.rest_url, spec.ws_url):
        assert "key" not in url.lower() and "secret" not in url.lower()
        assert urlsplit(url).hostname


@pytest.mark.parametrize("spec", [s for s in VENUES if s.adapter], ids=lambda s: s.name)
def test_a_venue_with_an_adapter_is_on_the_live_allowlist(spec) -> None:
    """The failure this prevents is silent and permanent.

    An adapter pointed at the real exchange whose hostname is missing from
    `VENUE_HOSTS` produces rows labelled SIMULATED. They go into an append-only
    log. Nothing later can tell them apart from a simulator run, so a week of
    real market data would be lost with no error anywhere.
    """
    family = "binance" if spec.name.startswith("binance") else spec.name
    assert family in VENUE_HOSTS, f"{spec.name} has an adapter but no allowlist entry"
    for url in (spec.rest_url, spec.ws_url):
        host = urlsplit(url).hostname
        assert host in VENUE_HOSTS[family], f"{host} is missing from VENUE_HOSTS[{family}]"
    assert classify_endpoint(family, spec.rest_url, spec.ws_url) is DataSource.LIVE


def _probe(**layers) -> VenueProbe:
    probe = VenueProbe(venue="x", rest_host="h", ws_host="h", adapter=True)
    for name, value in layers.items():
        setattr(probe, name, value)
    return probe


def test_an_intercepted_handshake_is_not_a_success() -> None:
    """The distinction the probe exists to draw."""
    probe = _probe(
        tls=LayerResult(False, "TLSv1.3, but issued by SomeCorp", "InterceptedTLS"),
        rest=LayerResult(False, "HTTP 403", "HTTPStatus"),
    )
    assert probe.tls_intercepted
    assert not probe.usable
    assert probe.blocked_by_proxy


def test_a_genuine_handshake_is_not_flagged() -> None:
    probe = _probe(tls=LayerResult(True, "TLSv1.3, issued by DigiCert Inc"))
    assert not probe.tls_intercepted


def test_the_public_ca_list_covers_the_authorities_exchanges_actually_use() -> None:
    for authority in ("digicert", "amazon", "cloudflare", "let's encrypt"):
        assert authority in PUBLIC_CAS


def test_reachable_without_an_adapter_is_not_usable() -> None:
    """Reachable is not the same as wired up, and conflating them invents a route."""
    no_adapter = VenueProbe(venue="bitstamp", rest_host="h", ws_host="h", adapter=False)
    no_adapter.rest = LayerResult(True, "HTTP 200, 412 bytes")
    assert no_adapter.usable, "the data did arrive"
    assert first_usable([no_adapter]) is None, "but there is no adapter to read it with"

    wired = VenueProbe(venue="kraken", rest_host="h", ws_host="h", adapter=True)
    wired.rest = LayerResult(True, "HTTP 200, 412 bytes")
    assert first_usable([no_adapter, wired]) is wired


def test_no_usable_venue_yields_no_choice() -> None:
    blocked = VenueProbe(venue="kraken", rest_host="h", ws_host="h", adapter=True)
    blocked.rest = LayerResult(False, "HTTP 403", "HTTPStatus")
    assert first_usable([blocked]) is None
