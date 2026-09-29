"""LIVE, SIMULATED and REPLAY must never be summed, averaged or confused.

Section 6 of the live-proof brief, and the guarantee the whole track record rests
on. It is asserted three ways, because each covers a different way it could fail:

* at the **provider**, where a label could be attached to the wrong feed;
* at the **store**, where two sources could be read back as one;
* at the **report**, where they could be aggregated after being stored correctly.

The third data source is the one that had never been exercised end to end. REPLAY
existed only inside the backtester, so nothing checked that a replayed capture
flows through the collector, the store and the report carrying its own label the
whole way. It does now.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from forecaster.marketdata.conformance import CoinbaseConformanceVenue
from forecaster.marketdata.provider import build_provider
from forecaster.marketdata.replay import CaptureWriter, ReplayProvider, capture_header
from forecaster.marketdata.venues.coinbase import CoinbaseProvider
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.service.livereport import live_validation_report
from forecaster.store import (
    MarketRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import DataSource, Side, Trade


def _open(tmp_path: Path, name: str = "sep.db"):
    database = open_database(f"sqlite:///{tmp_path}/{name}")
    return (
        database,
        MarketRepository(database),
        PredictionRepository(database),
        QualityRepository(database),
    )


# ---------------------------------------------------------------------------
# At the provider.
# ---------------------------------------------------------------------------


def test_each_provider_kind_declares_its_own_source() -> None:
    """Three kinds, three labels, no overlap."""
    simulated = build_provider("simulated", symbols=("BTC-USD",), seed=1)
    assert simulated.data_source is DataSource.SIMULATED
    assert CoinbaseProvider().data_source is DataSource.LIVE


def test_a_replayed_capture_is_replay_even_from_a_live_venue(tmp_path: Path) -> None:
    """A recording of a live feed is not a live feed.

    The subtle one. The capture's header says the bytes came from a venue, and it
    is still a replay: the prices are old, the book is a reconstruction, and
    nothing about it is happening now. Reading the header's venue while keeping
    REPLAY as the source is exactly the right split, and this pins it.
    """
    path = tmp_path / "cap.ndjson"
    writer = CaptureWriter(path, venue="coinbase", data_source=DataSource.LIVE)
    base = 1_700_000_000_000_000_000
    for i in range(20):
        writer.write(
            Trade(
                exchange_ns=base + i * 1_000_000_000,
                received_ns=base + i * 1_000_000_000,
                symbol="BTC-USD",
                price=79_000.0 + i,
                size=0.01,
                side=Side.BUY,
                trade_id=f"t{i}",
            )
        )
    writer.close()

    header = capture_header(path)
    assert header["venue"] == "coinbase"
    assert header["data_source"] == DataSource.LIVE.value

    provider = ReplayProvider(capture_path=path)
    assert provider.venue == "coinbase", "the venue is worth keeping"
    assert provider.data_source is DataSource.REPLAY, "a replay is never live"


# ---------------------------------------------------------------------------
# At the store, end to end through the collector.
# ---------------------------------------------------------------------------


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_capture_then_replay_keeps_the_sources_apart(tmp_path: Path) -> None:
    """Record a session, replay it, and confirm the store holds two distinct sets.

    This is the path that had never been run: conformance feed -> collector ->
    capture file -> replay provider -> collector -> store, with the label checked
    at both ends.
    """
    capture = tmp_path / "session.ndjson"
    _database, market, _predictions, quality = _open(tmp_path)

    # -- record ----------------------------------------------------------
    async with CoinbaseConformanceVenue(rate_hz=400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        assert provider.data_source is DataSource.SIMULATED
        writer = CaptureWriter(capture, venue=provider.venue, data_source=provider.data_source)
        recorder = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=quality,
            symbols=("BTC-USD", "ETH-USD"),
            monitor=QualityMonitor(),
            capture=writer,
        )
        with _suppress():
            await asyncio.wait_for(recorder.run(max_events=250), timeout=40)
        await recorder.close()

    recorded = market.counts_for(symbol="BTC-USD", data_source=DataSource.SIMULATED)
    assert recorded["trades"] > 0, "nothing was recorded to replay"
    assert market.counts_for(symbol="BTC-USD", data_source=DataSource.REPLAY)["trades"] == 0, (
        "the recording leaked into REPLAY before a replay happened"
    )

    # -- replay ----------------------------------------------------------
    replay_provider = ReplayProvider(capture_path=capture, speed=0.0)
    assert replay_provider.data_source is DataSource.REPLAY
    replayer = Collector(
        provider=replay_provider,
        market_repo=market,
        quality_repo=quality,
        symbols=("BTC-USD", "ETH-USD"),
        monitor=QualityMonitor(),
    )
    with _suppress():
        await asyncio.wait_for(replayer.run(), timeout=60)
    await replayer.close()

    replayed = market.counts_for(symbol="BTC-USD", data_source=DataSource.REPLAY)
    assert replayed["trades"] > 0, "the replay stored nothing"

    # The two sets are separate, and neither is live.
    still_simulated = market.counts_for(symbol="BTC-USD", data_source=DataSource.SIMULATED)
    assert still_simulated["trades"] == recorded["trades"], "the replay overwrote the original"
    assert market.counts_for(symbol="BTC-USD", data_source=DataSource.LIVE)["trades"] == 0
    assert market.counts_for(symbol="ETH-USD", data_source=DataSource.LIVE)["trades"] == 0

    # And a span query for one source never reaches into the other.
    sim_first, sim_last = market.span(symbol="BTC-USD", data_source=DataSource.SIMULATED)
    rep_first, rep_last = market.span(symbol="BTC-USD", data_source=DataSource.REPLAY)
    live_first, live_last = market.span(symbol="BTC-USD", data_source=DataSource.LIVE)
    assert sim_first is not None and rep_first is not None
    assert live_first is None and live_last is None
    assert sim_last is not None and rep_last is not None


def _suppress():
    import contextlib

    return contextlib.suppress(TimeoutError, asyncio.TimeoutError)


# ---------------------------------------------------------------------------
# At the report.
# ---------------------------------------------------------------------------


def test_a_report_for_one_source_reports_nothing_from_another(tmp_path: Path) -> None:
    """The last line of defence: stored correctly, then aggregated wrongly."""
    from forecaster.clock import now_ns
    from forecaster.service.persist import prediction_row
    from forecaster.types import (
        Confidence,
        FeatureVector,
        Forecast,
        PredictionMode,
        ServiceLevel,
    )

    _database, _market, predictions, quality = _open(tmp_path, "report.db")

    def write(source: DataSource, n: int) -> None:
        for i in range(n):
            moment = now_ns() + i
            forecast = Forecast(
                as_of_ns=moment,
                eval_at_ns=moment + 300 * 1_000_000_000,
                horizon_s=300,
                venue="v",
                symbol="BTC-USD",
                spot=79_000.0,
                target=79_100.0,
                z=0.5,
                sigma=0.001,
                p_above=0.4,
                range_low=78_000.0,
                range_high=80_000.0,
                range_confidence=0.8,
                median=79_000.0,
                confidence=Confidence.MODERATE,
                confidence_reasons=(),
                service_level=ServiceLevel.FULL,
                model_version="baseline-t@test",
                model_train_source=source,
                calibration_source=None,
                data_source=source,
                prediction_mode=PredictionMode.LIVE,
                features=FeatureVector(
                    as_of_ns=moment,
                    symbol="BTC-USD",
                    values={},
                    lookback_ns=moment - 3_600 * 1_000_000_000,
                    feature_set_version="fs-1",
                ),
                contributions=(),
            )
            predictions.append(prediction_row(forecast))

    write(DataSource.SIMULATED, 5)
    write(DataSource.REPLAY, 7)

    for source in (DataSource.LIVE, DataSource.SIMULATED, DataSource.REPLAY):
        report = live_validation_report(
            prediction_repo=predictions,
            quality_repo=quality,
            symbols=("BTC-USD",),
            horizons_s=(300,),
            data_source=source,
        )
        expected = {DataSource.LIVE: 0, DataSource.SIMULATED: 5, DataSource.REPLAY: 7}[source]
        assert report["totals"]["forecasts"] == expected, (
            f"{source.value} report counted {report['totals']['forecasts']}, expected {expected}"
        )
        assert report["data_source"] == source.value

    live = live_validation_report(
        prediction_repo=predictions,
        quality_repo=quality,
        symbols=("BTC-USD",),
        horizons_s=(300,),
        data_source=DataSource.LIVE,
    )
    assert live["totals"]["forecasts"] == 0
    assert "no real-market track record" in live["headline"]
    # And it says out loud which other sources it excluded, so a reader cannot
    # mistake an empty live report for an empty database.
    assert "simulated" in live["scope"] or "replay" in live["scope"]
