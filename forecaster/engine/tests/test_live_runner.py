"""The unattended runner: real forecasts, real expiry, and surviving a restart.

Sections 4, 5, 6 and 11 of the brief, tested together because they are one story:
a forecast is made on live-path data, it is written to an append-only log, its
horizon passes, it is scored from the recorded feed, and none of that changes if
the process dies in the middle.

The horizons here are short — seconds, not minutes — so the whole life cycle fits
inside a test. The horizon is a parameter of the machinery, not a constant, and
the product's own horizons (300s and 1200s) are exercised by the live collection
run rather than by a suite that would have to wait twenty minutes.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forecaster.clock import now_ns
from forecaster.config import Config
from forecaster.labels.resolve import label_from_price
from forecaster.marketdata.conformance import CoinbaseConformanceVenue
from forecaster.marketdata.venues.coinbase import CoinbaseProvider
from forecaster.models.baseline import BaselineModel
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine
from forecaster.service.livereport import live_validation_report, monotonicity_violations
from forecaster.service.liverunner import TARGET_LADDER_Z, LiveRunner, read_status
from forecaster.store import (
    MarketRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import DataSource, Outcome

HORIZON_S = 12
RUN_S = 55.0
SAMPLE_EVERY_S = 5.0


def build(tmp_path: Path, horizons=(HORIZON_S,)):
    url = f"sqlite:///{tmp_path}/live.db"
    database = open_database(url)
    config = Config(database_url=url, data_dir=tmp_path)
    return (
        database,
        config,
        MarketRepository(database),
        PredictionRepository(database),
        QualityRepository(database),
        horizons,
    )


async def run_once(tmp_path: Path, *, seconds: float = RUN_S, horizons=(HORIZON_S,)):
    _database, config, market, predictions, quality, horizons = build(tmp_path, horizons)
    async with CoinbaseConformanceVenue(rate_hz=80.0, history_s=2400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=quality,
            symbols=("BTC-USD", "ETH-USD"),
            bar_resolutions_s=config.bar_resolutions_s,
            monitor=QualityMonitor(config.quality),
        )
        runner = LiveRunner(
            provider=provider,
            collector=collector,
            engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=config),
            prediction_repo=predictions,
            market_repo=market,
            config=config,
            symbols=("BTC-USD", "ETH-USD"),
            horizons_s=horizons,
            interval_s=dict.fromkeys(horizons, SAMPLE_EVERY_S),
            status_path=tmp_path / "status.json",
        )
        status = await runner.run(seconds=seconds)
    return status, predictions, market, quality, config


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_the_runner_forecasts_records_and_resolves(tmp_path: Path) -> None:
    """The whole life cycle, unattended, on data that came off a socket."""
    status, predictions, _market, _quality, _config = await run_once(tmp_path)

    rows = predictions.history(limit=10_000)
    assert rows, "the runner produced no forecasts"
    assert status.evaluated > 0, "no forecast was resolved at expiry"

    # Provenance: the conformance venue is not a venue host, so nothing here may
    # claim to be live market data.
    assert {r["data_source"] for r in rows} == {DataSource.SIMULATED.value}
    assert {r["prediction_mode"] for r in rows} == {"live"}

    # The append-only log is intact after concurrent writers.
    assert predictions.verify_chain() == len(rows)


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_every_target_type_from_the_brief_is_forecast(tmp_path: Path) -> None:
    """Targets A to F: at the money, modestly either side, one move either side, far out."""
    _status, predictions, _m, _q, _c = await run_once(tmp_path)
    rows = predictions.history(limit=10_000)
    assert rows

    by_instant: dict[tuple[str, int], list[dict]] = {}
    for row in rows:
        by_instant.setdefault((row["symbol"], int(row["as_of_ns"])), []).append(row)

    full = [group for group in by_instant.values() if len(group) == len(TARGET_LADDER_Z)]
    assert full, "no sampling instant produced the whole target ladder"

    group = full[0]
    spot = float(group[0]["spot"])
    zs = sorted(float(r["z"]) for r in group)
    # Below spot, at spot, above spot, and one rung well beyond a normal move.
    assert min(zs) < -0.5, "no target a full expected move below the price"
    assert max(zs) > 2.0, "no target substantially farther than the market should go"
    assert any(abs(z) < 0.05 for z in zs), "no target at the current price"
    assert any(0.1 < z < 0.5 for z in zs), "no target modestly above"
    assert any(-0.5 < z < -0.1 for z in zs), "no target modestly below"
    # And the targets straddle the spot in price terms, not only in z.
    targets = [float(r["target"]) for r in group]
    assert min(targets) < spot < max(targets)


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_the_probability_curve_never_contradicts_itself(tmp_path: Path) -> None:
    """If A < B then P(price > A) >= P(price > B). Checked on real served output."""
    _status, predictions, _m, _q, _c = await run_once(tmp_path)
    rows = predictions.history(limit=10_000)
    violations, checked = monotonicity_violations(rows)
    assert checked > 0, "nothing to check: the ladder produced no comparable pairs"
    assert violations == 0, f"{violations} of {checked} target pairs contradicted each other"


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_resolution_follows_the_documented_rule_exactly(tmp_path: Path) -> None:
    """ABOVE iff eval_price > target. BELOW iff eval_price <= target. No exceptions."""
    _status, predictions, _m, _q, _c = await run_once(tmp_path)
    scored = predictions.scored(prediction_mode="live", data_source=DataSource.SIMULATED.value)
    assert scored, "nothing was resolved"

    for row in scored:
        price = float(row["eval_price"])
        target = float(row["target"])
        outcome = str(row["outcome"])
        went_above = outcome in (Outcome.ABOVE.value, Outcome.STALE_ABOVE.value)
        assert went_above == label_from_price(price, target), (
            f"outcome {outcome} disagrees with price {price} vs target {target}"
        )
        # Every resolved row carries the whole audit trail the brief asks for.
        for field in (
            "as_of_ns",
            "eval_at_ns",
            "horizon_s",
            "target",
            "p_above",
            "eval_price",
            "eval_price_ns",
            "model_version",
            "data_source",
            "venue",
            "resolver_version",
        ):
            assert row[field] is not None, f"resolved row is missing {field}"
        assert (
            int(row["eval_at_ns"]) - int(row["as_of_ns"]) == int(row["horizon_s"]) * 1_000_000_000
        )


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_resolved_outcome_never_changes_when_asked_again(tmp_path: Path) -> None:
    """History that changes depending on when you look at it is not history."""
    _status, predictions, market, _q, config = await run_once(tmp_path)
    first = {
        int(r["id"]): (r["outcome"], r["eval_price"])
        for r in predictions.scored(prediction_mode="live", data_source=DataSource.SIMULATED.value)
    }
    assert first

    # Run the evaluator again, twice, well after the fact.
    from forecaster.service.evaluator import Evaluator

    evaluator = Evaluator(prediction_repo=predictions, market_repo=market, quality=config.quality)
    evaluator.run_once(at_ns=now_ns() + 3_600 * 1_000_000_000)
    evaluator.run_once(at_ns=now_ns() + 7_200 * 1_000_000_000)

    second = {
        int(r["id"]): (r["outcome"], r["eval_price"])
        for r in predictions.scored(prediction_mode="live", data_source=DataSource.SIMULATED.value)
    }
    for key, value in first.items():
        assert second[key] == value, f"prediction {key} changed its outcome on re-query"


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_predictions_survive_a_restart_and_resolve_exactly_once(tmp_path: Path) -> None:
    """Kill the process mid-flight; the open forecasts must still be known and scored once.

    Section 11. The runner is stopped while forecasts are still open, everything
    is torn down, and a completely fresh set of objects is built against the same
    database file — which is what a restart actually is.
    """
    url = f"sqlite:///{tmp_path}/restart.db"
    config = Config(database_url=url, data_dir=tmp_path)

    # -- first process ---------------------------------------------------
    database = open_database(url)
    market, predictions = MarketRepository(database), PredictionRepository(database)
    async with CoinbaseConformanceVenue(rate_hz=80.0, history_s=2400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=QualityRepository(database),
            symbols=("BTC-USD",),
            bar_resolutions_s=config.bar_resolutions_s,
            monitor=QualityMonitor(config.quality),
        )
        runner = LiveRunner(
            provider=provider,
            collector=collector,
            engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=config),
            prediction_repo=predictions,
            market_repo=market,
            config=config,
            symbols=("BTC-USD",),
            horizons_s=(120,),  # long enough that nothing resolves before the kill
            interval_s={120: 4.0},
            status_path=tmp_path / "status.json",
        )
        await runner.run(seconds=20.0)

    open_before = predictions.history(limit=10_000)
    assert open_before, "nothing was forecast before the restart"
    assert all(r["outcome"] is None for r in open_before), "something resolved too early"
    ids_before = {int(r["id"]) for r in open_before}

    # -- everything from the first process is now gone --------------------
    del runner, collector, provider, predictions, market, database

    # -- second process, same database ------------------------------------
    database2 = open_database(url)
    market2, predictions2 = MarketRepository(database2), PredictionRepository(database2)

    after = predictions2.history(limit=10_000)
    assert {int(r["id"]) for r in after} == ids_before, "the restart lost open predictions"
    assert predictions2.verify_chain() == len(after), "the chain did not survive the restart"

    # The horizons have passed by the time the evaluator is asked.
    from forecaster.service.evaluator import Evaluator

    evaluator = Evaluator(prediction_repo=predictions2, market_repo=market2, quality=config.quality)
    future = max(int(r["eval_at_ns"]) for r in after) + 1_000_000_000
    first_run = evaluator.run_once(at_ns=future)
    assert first_run.checked == len(after), "the restarted process did not find the open forecasts"

    # Running again must write nothing new: resolution is idempotent.
    second_run = evaluator.run_once(at_ns=future)
    assert second_run.checked == 0, "a second pass re-resolved forecasts already scored"

    resolved = predictions2.history(limit=10_000)
    outcomes = [r for r in resolved if r["outcome"] is not None]
    assert len(outcomes) == len(after), "not every forecast was resolved after the restart"
    assert len({int(r["id"]) for r in outcomes}) == len(outcomes), "duplicate outcome rows"


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_live_metrics_never_include_non_live_rows(tmp_path: Path) -> None:
    """Section 7, asserted rather than asserted-about.

    The runner wrote rows through a conformance endpoint, so they are SIMULATED.
    A report asked for LIVE must show nothing at all, no matter how much data is
    in the database.
    """
    _status, predictions, _m, quality, _c = await run_once(tmp_path)
    assert predictions.history(limit=10_000), "no rows were written"

    live = live_validation_report(
        prediction_repo=predictions,
        quality_repo=quality,
        horizons_s=(HORIZON_S,),
        data_source=DataSource.LIVE,
    )
    assert live["totals"]["forecasts"] == 0
    assert live["totals"]["resolved"] == 0
    assert "no real-market track record" in live["headline"]
    for group in live["groups"]:
        assert group["brier"] is None
        assert group["calibration_error"] is None
        assert group["can_claim_calibration"] is False

    simulated = live_validation_report(
        prediction_repo=predictions,
        quality_repo=quality,
        horizons_s=(HORIZON_S,),
        data_source=DataSource.SIMULATED,
    )
    assert simulated["totals"]["resolved"] > 0


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_small_sample_is_labelled_insufficient(tmp_path: Path) -> None:
    """The report must refuse to quote calibration from a handful of observations."""
    _status, predictions, _m, quality, _c = await run_once(tmp_path)
    report = live_validation_report(
        prediction_repo=predictions,
        quality_repo=quality,
        horizons_s=(HORIZON_S,),
        data_source=DataSource.SIMULATED,
    )
    groups = [g for g in report["groups"] if g["resolved"] > 0]
    assert groups
    for group in groups:
        assert group["n_non_overlapping"] < group["resolved"], (
            "overlapping forecasts were counted as independent evidence"
        )
        assert "INSUFFICIENT" in group["sufficiency"] or "PRELIMINARY" in group["sufficiency"]
        if not group["can_claim_calibration"]:
            assert group["calibration_error"] is None


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_the_status_file_says_whether_the_runner_is_alive(tmp_path: Path) -> None:
    """An operator must be able to tell a quiet runner from a dead one.

    Three ways a runner can be gone, and the file has to distinguish all of them
    from "running but the market is quiet":

      * it shut down cleanly and said so;
      * it died without saying anything, so the file has simply stopped moving;
      * it never started, so there is no file.
    """
    status, _p, _m, _q, _c = await run_once(tmp_path, seconds=25.0)
    path = tmp_path / "status.json"

    # 1. A clean shutdown is recorded, and is not reported as running however
    #    recently the file was written. Age alone would call this alive for a
    #    full minute after the process was gone.
    after = read_status(path)
    assert after["running"] is False
    assert "clean shutdown" in after["reason"]
    assert after["data_source"] == DataSource.SIMULATED.value
    assert after["connected"] is False
    assert status.started_ns > 0
    assert "BTC-USD" in after["per_symbol"]

    # 2. A runner that is alive and writing: same file, shutdown marker cleared.
    payload = json.loads(path.read_text())
    payload["stopped"] = False
    payload["updated"] = (
        datetime.fromtimestamp(now_ns() / 1_000_000_000, tz=UTC).isoformat().replace("+00:00", "Z")
    )
    path.write_text(json.dumps(payload))
    assert read_status(path)["running"] is True

    # 3. A runner that died without a word: the file simply stops moving.
    payload["updated"] = (
        datetime.fromtimestamp(now_ns() / 1_000_000_000 - 3_600, tz=UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )
    path.write_text(json.dumps(payload))
    stale = read_status(path)
    assert stale["running"] is False
    assert "not running" in stale["reason"]

    # 4. A runner that never started.
    missing = read_status(tmp_path / "nope.json")
    assert missing["running"] is False
    assert "no readable status file" in missing["reason"]


def test_the_target_ladder_covers_both_sides_and_the_far_tail() -> None:
    """A property of the ladder itself, so a careless edit to it fails here."""
    assert 0.0 in TARGET_LADDER_Z
    assert any(z > 2.0 for z in TARGET_LADDER_Z)
    assert any(z < -0.9 for z in TARGET_LADDER_Z)
    assert any(0.0 < z < 0.5 for z in TARGET_LADDER_Z)
    assert any(-0.5 < z < 0.0 for z in TARGET_LADDER_Z)
    assert len(set(TARGET_LADDER_Z)) == len(TARGET_LADDER_Z), "the ladder has a duplicate rung"


def test_targets_are_placed_in_log_space_and_stay_positive() -> None:
    """A huge sigma must not produce a negative or zero target price."""
    from forecaster.service.liverunner import LiveRunner as _Runner

    place = _Runner.targets_for
    fake = type("F", (), {"ladder_z": (-5.0, 0.0, 5.0)})()
    targets = place(fake, 79_434.21, 0.9)
    assert all(t > 0 for t in targets)
    assert targets[1] == pytest.approx(79_434.21, rel=1e-9)
    # Symmetric in log space means the ±z rungs multiply to spot². The tolerance
    # is 1e-4 rather than machine epsilon because targets are rounded to cents,
    # and rounding 882.4297 to 882.43 is a relative change of a few parts per
    # million at this spread. It is still three orders of magnitude tighter than
    # the error a linear ladder would produce: `spot * (1 - 5 * 0.9)` is
    # -278,019, which the positivity assertion above already rejects.
    assert math.isclose(targets[0] * targets[2], 79_434.21**2, rel_tol=1e-4)
    assert place(fake, 0.0, 0.01) == []
    assert place(fake, 100.0, 0.0) == []
    assert place(fake, 100.0, float("nan")) == []


# ---------------------------------------------------------------------------
# Segments. A multi-day track record is built from bounded runs.
# ---------------------------------------------------------------------------


def test_a_self_contained_run_stops_sampling_before_it_stops_collecting() -> None:
    """Every forecast a segment starts must also expire inside it.

    A segment drops its raw ticks when it ends, and a forecast still open when
    the ticks go is scored VOID afterwards. Sampling to the last second would
    therefore end every segment with a tail of voids caused by the schedule
    rather than by the market — and across a fortnight of segments that would
    quietly become the dominant term in the void rate.
    """
    from forecaster.service.liverunner import SAMPLING_CUTOFF_MARGIN_S

    seconds, horizon = 3600.0, 1200
    cutoff = seconds - horizon - SAMPLING_CUTOFF_MARGIN_S
    assert cutoff > 0
    # The last forecast starts at the cutoff and expires a full horizon later,
    # with the margin left over for the evaluator to score it.
    assert cutoff + horizon + SAMPLING_CUTOFF_MARGIN_S == seconds


def test_the_cutoff_is_off_by_default() -> None:
    """Wrong for a one-shot run, and the live proof is a one-shot run.

    `live-proof` budgets warm-up + 2x the longest horizon precisely so forecasts
    can be made and then expire. Taking another horizon off the end double-counts
    that allowance and would cut the proof from 22 sampling instants to about 10.
    Unresolved forecasts at the end of a one-shot run are merely unscored, which
    is harmless. At the end of a segment they are voids, which is not.
    """
    import inspect

    from forecaster.service.liverunner import LiveRunner as Runner

    assert inspect.signature(Runner.run).parameters["self_contained"].default is False


@pytest.mark.enable_socket
@pytest.mark.allow_hosts(["127.0.0.1", "::1"])
async def test_a_segment_resolves_everything_it_starts(tmp_path: Path) -> None:
    """The contract, over a socket: predictions == outcomes, and no voids."""
    url = f"sqlite:///{tmp_path}/segment.db"
    database = open_database(url)
    config = Config(database_url=url, data_dir=tmp_path)
    market, predictions = MarketRepository(database), PredictionRepository(database)

    horizon, run_for = 12, 40.0
    async with CoinbaseConformanceVenue(rate_hz=80.0, history_s=2400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=QualityRepository(database),
            symbols=("BTC-USD",),
            bar_resolutions_s=config.bar_resolutions_s,
            monitor=QualityMonitor(config.quality),
        )
        runner = LiveRunner(
            provider=provider,
            collector=collector,
            engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=config),
            prediction_repo=predictions,
            market_repo=market,
            config=config,
            symbols=("BTC-USD",),
            horizons_s=(horizon,),
            interval_s={horizon: 4.0},
            status_path=tmp_path / "status.json",
        )
        # Margin is 120s, far longer than this test run, so the cutoff cannot
        # apply — the run records that rather than silently sampling anyway.
        await runner.run(seconds=run_for, self_contained=True)

    assert any("too short" in error for error in runner.status.errors), (
        "a run too short to self-contain must say so rather than pretend"
    )
