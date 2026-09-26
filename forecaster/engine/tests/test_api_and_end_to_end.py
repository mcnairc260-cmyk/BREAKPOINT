"""The whole system, exercised through the API it actually serves.

This is the test that would catch a working set of parts that do not add up to a
working product. It runs the real sequence: ingest market data, forecast against
targets above and below the current price, persist, wait for the horizon to
pass, resolve outcomes from the recorded feed, and read the statistics back.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from forecaster.config import Config
from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
from forecaster.quality import QualityMonitor
from forecaster.service.app import AppState, create_app
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine
from forecaster.service.evaluator import Evaluator
from forecaster.store import (
    MarketRepository,
    ModelRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import NS_PER_SECOND, DataSource

CAPTURE_S = 7200
NOW_NS = 100 * 60 * NS_PER_SECOND  # 100 minutes into the capture


@pytest.fixture(scope="session")
def sim_events() -> list:
    """Two hours of simulated market, generated once.

    Generating it inside every test made this file take five minutes for work
    that is bit-for-bit identical each time. The simulator is deterministic, so
    the events can be produced once and replayed into a fresh database per test.
    """
    provider = SimulatedProvider(
        symbols=("BTC-USD",),
        seed=17,
        params=SimulatorParams.for_regime(Regime.REALISTIC),
        duration_s=CAPTURE_S,
        start_ns=0,
        realtime=False,
    )

    async def drain() -> list:
        return [event async for event in provider.stream(("BTC-USD",))]

    return asyncio.run(drain())


@pytest.fixture
def app_state(tmp_path, sim_events):
    """A fully wired system with two hours of simulated market behind it.

    The clock is pinned so the test is not racing real time: the collector's
    capture starts at zero and "now" is 100 minutes in, leaving 20 minutes of
    future data for outcomes to resolve against.
    """
    database = open_database(f"sqlite:///{tmp_path / 'e2e.db'}")
    market_repo = MarketRepository(database)
    prediction_repo = PredictionRepository(database)

    collector = Collector(
        provider=SimulatedProvider(symbols=("BTC-USD",), duration_s=0),
        market_repo=market_repo,
        quality_repo=QualityRepository(database),
        symbols=("BTC-USD",),
        monitor=QualityMonitor(),
    )
    for event in sim_events:
        collector.handle(event)
    collector.flush(force=True)

    config = Config(
        database_url=f"sqlite:///{tmp_path / 'e2e.db'}",
        provider="simulated",
        venue="simulator",
        symbols=("BTC-USD",),
        data_dir=tmp_path / "data",
        artifact_dir=tmp_path / "artifacts",
    )
    return AppState(
        config=config,
        engine=ForecastEngine(config=config),
        collector=collector,
        evaluator=Evaluator(
            prediction_repo=prediction_repo, market_repo=market_repo, quality=config.quality
        ),
        prediction_repo=prediction_repo,
        market_repo=market_repo,
        model_repo=ModelRepository(database),
        quality_repo=QualityRepository(database),
        tasks=[],
    )


@pytest.fixture
def client(app_state, monkeypatch):
    """The API, with the clock pinned inside the app module."""
    import forecaster.service.app as app_module

    monkeypatch.setattr(app_module, "now_ns", lambda: NOW_NS)
    return TestClient(create_app(app_state))


class TestHealthAndPrice:
    def test_health_reports_the_data_source_and_warns(self, client: TestClient) -> None:
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["data_source"] == "simulated"
        # Simulated data must announce itself, not be inferable only from a field.
        assert any("SIMULATED" in warning.upper() for warning in body["warnings"])
        assert body["chain_verified_rows"] == 0

    def test_price_is_served_with_its_age(self, client: TestClient) -> None:
        body = client.get("/api/price/BTC-USD").json()
        assert body["price"] > 0
        assert body["bid"] is not None and body["ask"] is not None
        assert body["bid"] < body["ask"]
        assert body["data_source"] == "simulated"

    def test_an_unknown_symbol_is_a_clean_404(self, client: TestClient) -> None:
        assert client.get("/api/price/DOGE-USD").status_code == 404


class TestForecastEndpoint:
    def test_a_target_above_and_a_target_below_both_work(self, client: TestClient) -> None:
        """The distinction the brief calls critical.

        The target may sit on either side of the current price, and the answer
        must respond to the target — not to a hidden opinion about direction.
        """
        spot = client.get("/api/price/BTC-USD").json()["price"]

        above = client.post(
            "/api/forecast",
            json={"symbol": "BTC-USD", "target": round(spot * 1.002, 2), "horizons": [300]},
        ).json()
        below = client.post(
            "/api/forecast",
            json={"symbol": "BTC-USD", "target": round(spot * 0.998, 2), "horizons": [300]},
        ).json()

        p_high_target = above["forecasts"][0]["p_above"]
        p_low_target = below["forecasts"][0]["p_above"]
        assert p_low_target > p_high_target
        assert above["distance"] > 0 and below["distance"] < 0

    def test_both_horizons_are_returned_and_differ(self, client: TestClient) -> None:
        spot = client.get("/api/price/BTC-USD").json()["price"]
        body = client.post(
            "/api/forecast", json={"symbol": "BTC-USD", "target": round(spot * 1.001, 2)}
        ).json()
        assert [f["horizon_s"] for f in body["forecasts"]] == [300, 1200]
        # A 20-minute window is wider, so a fixed target is closer in sigma terms
        # and its probability sits nearer 50%.
        five, twenty = body["forecasts"]
        assert twenty["sigma"] > five["sigma"]
        assert abs(twenty["p_above"] - 0.5) < abs(five["p_above"] - 0.5)

    def test_probabilities_sum_to_one_exactly(self, client: TestClient) -> None:
        spot = client.get("/api/price/BTC-USD").json()["price"]
        body = client.post("/api/forecast", json={"symbol": "BTC-USD", "target": spot}).json()
        for forecast in body["forecasts"]:
            assert forecast["p_above"] + forecast["p_below"] == pytest.approx(1.0, abs=1e-9)

    def test_a_near_the_money_target_is_near_a_coin_flip(self, client: TestClient) -> None:
        """The honesty check.

        A target a few dollars away at a five-minute horizon carries almost no
        information. If this ever returned 70%, something would be leaking.
        """
        spot = client.get("/api/price/BTC-USD").json()["price"]
        body = client.post(
            "/api/forecast",
            json={"symbol": "BTC-USD", "target": round(spot + 5.0, 2), "horizons": [300]},
        ).json()
        assert 0.35 < body["forecasts"][0]["p_above"] < 0.65

    def test_the_response_carries_its_provenance(self, client: TestClient) -> None:
        spot = client.get("/api/price/BTC-USD").json()["price"]
        body = client.post("/api/forecast", json={"symbol": "BTC-USD", "target": spot}).json()
        assert body["is_live"] is False
        assert body["data_source"] == "simulated"
        assert any("SIMULATED" in w.upper() for w in body["warnings"])
        for forecast in body["forecasts"]:
            assert forecast["model_version"]
            assert forecast["range_low"] < forecast["range_high"]
            assert forecast["signals"], "a forecast must say what drove it"
            # The dominant term is always named first.
            assert forecast["signals"][0]["name"] == "target_distance"

    def test_bad_input_is_refused_clearly(self, client: TestClient) -> None:
        assert (
            client.post("/api/forecast", json={"symbol": "BTC-USD", "target": 0}).status_code == 422
        )
        assert (
            client.post("/api/forecast", json={"symbol": "BTC-USD", "target": -5}).status_code
            == 422
        )
        assert (
            client.post(
                "/api/forecast", json={"symbol": "BTC-USD", "target": 100, "horizons": [60]}
            ).status_code
            == 422
        )
        assert (
            client.post("/api/forecast", json={"symbol": "XRP-USD", "target": 1}).status_code == 404
        )


class TestFullLifecycle:
    def test_forecast_persist_expire_evaluate_report(self, client: TestClient, app_state) -> None:
        """The complete loop, exactly as it runs in production."""
        spot = client.get("/api/price/BTC-USD").json()["price"]

        made = 0
        for offset in (-0.004, -0.001, 0.0, 0.001, 0.004):
            response = client.post(
                "/api/forecast",
                json={
                    "symbol": "BTC-USD",
                    "target": round(spot * (1 + offset), 2),
                    "horizons": [300, 1200],
                },
            )
            assert response.status_code == 200
            made += len(response.json()["forecasts"])

        # 1. Saved before the outcome could be known.
        assert app_state.prediction_repo.count() == made
        assert app_state.prediction_repo.verify_chain() == made

        history = client.get("/api/history?limit=100").json()["predictions"]
        assert len(history) == made
        assert all(row["resolved"] is False for row in history)

        # 2. Nothing resolves before its horizon has passed.
        assert app_state.evaluator.run_once(at_ns=NOW_NS).checked == 0

        # 3. Once the horizon passes, outcomes are read from the recorded feed.
        run = app_state.evaluator.run_once(at_ns=NOW_NS + 21 * 60 * NS_PER_SECOND)
        assert run.checked == made
        assert run.resolved > 0, "outcomes should resolve from the recorded feed"

        # 4. Resolving twice does not double-count.
        assert app_state.evaluator.run_once(at_ns=NOW_NS + 21 * 60 * NS_PER_SECOND).checked == 0

        # 5. History reflects the outcomes.
        history = client.get("/api/history?limit=100").json()["predictions"]
        resolved = [row for row in history if row["resolved"]]
        assert len(resolved) == made
        for row in resolved:
            assert row["outcome"] in (
                "above",
                "below",
                "stale_above",
                "stale_below",
                "void_gap",
                "void_halt",
            )
            if not row["outcome"].startswith("void"):
                assert row["eval_price"] is not None
                assert isinstance(row["correct"], bool)
                # The equality rule, checked against the stored outcome.
                went_above = row["eval_price"] > row["target"]
                assert row["outcome"].endswith("above") == went_above

        # 6. Statistics are grouped, never pooled, and say how much to trust them.
        stats = client.get("/api/stats?data_source=simulated").json()
        assert stats["total_resolved"] > 0
        assert "honesty_note" in stats
        populated = [g for g in stats["groups"].values() if g.get("n", 0) > 0]
        assert populated, "at least one group should have scored forecasts"
        for group in populated:
            assert 0.0 <= group["brier"] <= 1.0
            assert group["can_claim_calibration"] is False, (
                "a handful of outcomes must not be presented as evidence of calibration"
            )
            assert "sample_size_note" in group

        # 7. The append-only chain still verifies after all of it.
        assert app_state.prediction_repo.verify_chain() == made

    def test_the_engine_refuses_when_there_is_too_little_history(self, app_state) -> None:
        """A refusal is a feature, not an outage."""
        from forecaster.service.engine import ForecastRefused
        from forecaster.types import ServiceLevel

        window = app_state.collector.window("BTC-USD", 5 * 60 * NS_PER_SECOND)
        with pytest.raises(ForecastRefused, match="history"):
            app_state.engine.forecast(
                window=window,
                target=79_000.0,
                horizon_s=300,
                service_level=ServiceLevel.FULL,
                feed_age_ns=0,
                now_ns=5 * 60 * NS_PER_SECOND,
            )

    def test_the_engine_refuses_on_an_unhealthy_feed(self, app_state) -> None:
        from forecaster.service.engine import ForecastRefused
        from forecaster.types import ServiceLevel

        window = app_state.collector.window("BTC-USD", NOW_NS)
        for level in (ServiceLevel.STALE, ServiceLevel.DOWN):
            with pytest.raises(ForecastRefused, match="not healthy"):
                app_state.engine.forecast(
                    window=window,
                    target=79_000.0,
                    horizon_s=300,
                    service_level=level,
                    feed_age_ns=99 * NS_PER_SECOND,
                    now_ns=NOW_NS,
                )


class TestQuarantine:
    def test_a_simulator_trained_model_cannot_serve_a_live_forecast(self, app_state) -> None:
        """The rule that stops a simulated result being presented as a real one."""
        from forecaster.models.ml import GradientBoostedCorrection
        from forecaster.models.registry import ModelArtifact

        artifact = ModelArtifact(
            version="lgbm-monotone@test.sim",
            family="lgbm-monotone",
            symbol="BTC-USD",
            horizon_s=300,
            trained_ns=0,
            train_start_ns=0,
            train_end_ns=1,
            train_data_source=DataSource.SIMULATED,
            baseline=app_state.engine.baseline,
            gbm=GradientBoostedCorrection(booster=object()),
        )
        allowed, reason = app_state.engine._learner_allowed(artifact, DataSource.LIVE)
        assert allowed is False
        assert reason is not None and "quarantined" in reason

        # On simulated data it may serve, because everything is labelled simulated.
        allowed, _ = app_state.engine._learner_allowed(artifact, DataSource.SIMULATED)
        assert allowed is True

    def test_the_override_exists_but_still_warns(self, app_state) -> None:
        from dataclasses import replace

        from forecaster.models.ml import GradientBoostedCorrection
        from forecaster.models.registry import ModelArtifact

        app_state.engine.config = replace(app_state.config, allow_ml_live=True)
        artifact = ModelArtifact(
            version="lgbm-monotone@test.sim",
            family="lgbm-monotone",
            symbol="BTC-USD",
            horizon_s=300,
            trained_ns=0,
            train_start_ns=0,
            train_end_ns=1,
            train_data_source=DataSource.SIMULATED,
            baseline=app_state.engine.baseline,
            gbm=GradientBoostedCorrection(booster=object()),
        )
        allowed, reason = app_state.engine._learner_allowed(artifact, DataSource.LIVE)
        assert allowed is True
        assert reason is not None and "FORECASTER_ALLOW_ML_LIVE" in reason
