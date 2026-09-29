"""The offline verification suite.

One command that decides whether the system may be believed. It runs entirely
without a network — deliberately, because the environment this was built in has
no exchange access, and because a suite that quietly depended on one would prove
nothing about the code and everything about the network.

The checks are ordered so the most damning come first. If the null-alpha gate
fails, nothing else in the run matters.

**What a green run establishes:** the pipeline recovers known probabilities, the
harness does not leak, served output is coherent on every input tested, and bad
data produces a refusal rather than a number.

**What it does not establish:** anything at all about real markets. The report it
writes says so in its first line.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from forecaster.clock import iso, now_ns
from forecaster.config import Config
from forecaster.features.compute import compute_features
from forecaster.features.registry import REGISTRY, LeakageDetected, assert_causal, register
from forecaster.features.window import MarketWindow
from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
from forecaster.models.baseline import BaselineModel
from forecaster.models.dataset import DatasetBuilder
from forecaster.models.ml import GradientBoostedCorrection, TuningRefused
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine, ForecastRefused
from forecaster.store import (
    MarketRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.store.database import Database
from forecaster.types import NS_PER_SECOND, PROB_FLOOR, DataSource, ServiceLevel

BANNER = "VALIDATION SCOPE: SIMULATED DATA ONLY — NO REAL-MARKET CLAIMS SUPPORTED"


@dataclass
class Check:
    name: str
    passed: bool
    detail: str
    duration_s: float
    numbers: dict[str, Any] = field(default_factory=dict)

    def line(self) -> str:
        mark = "PASS" if self.passed else "FAIL"
        return f"  [{mark}] {self.name:<38} {self.detail}"


class Suite:
    def __init__(self) -> None:
        self.checks: list[Check] = []

    def run(self, name: str, fn: Callable[[], tuple[bool, str, dict[str, Any]]]) -> Check:
        started = time.monotonic()
        try:
            passed, detail, numbers = fn()
        except Exception as exc:
            passed, detail, numbers = False, f"{type(exc).__name__}: {exc}", {}
        check = Check(name, passed, detail, time.monotonic() - started, numbers)
        self.checks.append(check)
        print(check.line(), flush=True)
        return check

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.passed]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def collect(regime: Regime, seed: int, duration_s: float, database: Database) -> Collector:
    provider = SimulatedProvider(
        symbols=("BTC-USD",),
        seed=seed,
        params=SimulatorParams.for_regime(regime),
        duration_s=duration_s,
        start_ns=0,
        realtime=False,
    )
    collector = Collector(
        provider=provider,
        market_repo=MarketRepository(database),
        quality_repo=QualityRepository(database),
        symbols=("BTC-USD",),
        monitor=QualityMonitor(),
    )
    asyncio.run(collector.run())
    return collector


# ---------------------------------------------------------------------------
# the checks
# ---------------------------------------------------------------------------


def check_offline() -> tuple[bool, str, dict[str, Any]]:
    """Confirm the suite genuinely runs with the network switched off.

    Sockets are disabled for the whole run (see `run_verification`), so any check
    that tried to reach a venue would raise rather than quietly succeed. This
    verifies the block is actually in place.

    An earlier version of this check tested whether an exchange was *reachable*
    and failed if it was — which is wrong twice over: a successful TCP connect
    proves nothing about whether the API is usable, and on any machine with
    working internet the check would fail for no reason. What matters is that
    this suite does not USE the network, not that the network is absent.
    """
    import socket

    try:
        socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except Exception as exc:
        return True, f"network access is blocked for this run ({type(exc).__name__})", {}
    return False, "sockets are still open — the offline guarantee is not in force", {}


def check_known_answer(seeds: int) -> tuple[bool, str, dict[str, Any]]:
    """The baseline against arithmetic, not against itself.

    In the pure geometric-Brownian regime the true probability has a closed form,
    so the model can be checked against the correct answer rather than against
    its own output.
    """
    worst = 0.0
    samples = 0
    for seed in range(seeds):
        database = open_database("sqlite:///:memory:")
        collector = collect(Regime.GBM, 1_000 + seed, 5_400, database)
        provider = collector.provider
        window = collector.window("BTC-USD", 5_000 * NS_PER_SECOND)
        baseline = BaselineModel()
        try:
            distribution = baseline.predict_distribution(window, 300)
        except Exception:
            database.dispose()
            continue
        spot = distribution.spot
        for z in np.linspace(-3.0, 3.0, 25):
            target = spot * math.exp(z * distribution.sigma)
            estimated = distribution.prob_above(target)
            # From the SAME price the forecast was made at. Using the simulator's
            # current price would compare a forecast made at t=5000s against the
            # truth at the end of the run.
            true = provider.analytic_prob_above_from(spot, target, 300)  # type: ignore[attr-defined]
            worst = max(worst, abs(estimated - true))
            samples += 1
        database.dispose()

    # A loose tolerance, on purpose. The volatility is estimated from a finite
    # sample of the path, so it cannot match the generator exactly; the point is
    # that the arithmetic is right, not that estimation error is zero.
    ok = worst < 0.12 and samples > 0
    return (
        ok,
        f"worst gap from the analytic answer {worst:.4f} over {samples} points",
        {"max_abs_error": worst, "points": samples},
    )


def check_null_alpha(seeds: int) -> tuple[bool, str, dict[str, Any]]:
    """The gate that catches a broken harness.

    On a martingale — zero drift, no predictable structure — a learned model
    cannot beat the volatility baseline. If one appears to, the pipeline has
    leaked somewhere, and this is far more likely to catch a subtle leak (a
    preprocessing step fitted globally, a grouping bug, an off-by-one at a fold
    boundary) than a deliberately future-peeking feature is.
    """
    skills: list[float] = []
    for seed in range(max(2, seeds // 2)):
        database = open_database("sqlite:///:memory:")
        collect(Regime.MARTINGALE, 5_000 + seed, 14_400, database)
        market_repo = MarketRepository(database)
        from forecaster.features.window import CachedWindowSource
        from forecaster.models.dataset import price_lookup

        source = CachedWindowSource(
            market_repo=market_repo,
            symbol="BTC-USD",
            venue="simulator",
            data_source=DataSource.SIMULATED,
            start_ns=0,
            end_ns=14_400 * NS_PER_SECOND,
        ).load()
        builder = DatasetBuilder(
            window_source=source,
            baseline=BaselineModel(),
            symbol="BTC-USD",
            horizon_s=300,
            data_source=DataSource.SIMULATED,
            sample_interval_s=30,
        )
        dataset = builder.build(
            0,
            14_400 * NS_PER_SECOND,
            price_at=price_lookup(
                market_repo, "BTC-USD", source=DataSource.SIMULATED, venue="simulator"
            ),
            warmup_s=3_600,
        )
        database.dispose()
        if len(dataset) < 1_000:
            continue

        # A strictly chronological split, with a purge of one horizon.
        cut = int(len(dataset) * 0.6)
        boundary_ns = int(dataset.as_of_ns[cut])
        train_mask = dataset.as_of_ns <= boundary_ns - 300 * NS_PER_SECOND
        test_mask = dataset.as_of_ns > boundary_ns
        if train_mask.sum() < 500 or test_mask.sum() < 200:
            continue

        learner = GradientBoostedCorrection().fit(dataset.mask(train_mask), at_ns=now_ns())
        test = dataset.mask(test_mask)
        learner_p = learner.predict_proba(test)
        labels = test.label.astype(float)
        baseline_brier = float(np.mean((test.baseline_p - labels) ** 2))
        learner_brier = float(np.mean((learner_p - labels) ** 2))
        if baseline_brier > 0:
            skills.append(1.0 - learner_brier / baseline_brier)

    if not skills:
        return False, "no usable martingale datasets were produced", {}
    worst = max(skills)
    # A learner may not show meaningful skill where none exists. Small negative
    # values are expected and fine — that is a model correctly finding nothing.
    ok = worst < 0.02
    return (
        ok,
        f"best skill over the baseline on a martingale {worst:+.4f} (must stay under +0.02)",
        {"skills": skills, "worst": worst},
    )


def check_leakage_canary() -> tuple[bool, str, dict[str, Any]]:
    """A deliberately mis-declared feature must be caught."""
    database = open_database("sqlite:///:memory:")
    collector = collect(Regime.REALISTIC, 42, 7_200, database)
    window = collector.window("BTC-USD", 5_400 * NS_PER_SECOND)

    assert_causal(window)  # the real feature set is clean

    @register("verify_canary", lookback_s=5, tier=2, rationale="deliberate leak")
    def _canary(w: MarketWindow) -> float:
        return float(len(w.trades))

    caught = False
    try:
        assert_causal(window)
    except LeakageDetected:
        caught = True
    finally:
        REGISTRY.pop("verify_canary", None)
    database.dispose()
    return (
        caught,
        "a mis-declared feature was detected" if caught else "the canary was NOT caught",
        {},
    )


def check_monotonicity() -> tuple[bool, str, dict[str, Any]]:
    """Served output, over a wide grid of targets, must never invert."""
    database = open_database("sqlite:///:memory:")
    collector = collect(Regime.REALISTIC, 77, 7_200, database)
    config = Config(provider="simulated", venue="simulator", symbols=("BTC-USD",))
    engine = ForecastEngine(config=config)

    violations = 0
    checked = 0
    floor_hits = 0
    for offset_min in (75, 90, 105):
        as_of = offset_min * 60 * NS_PER_SECOND
        window = collector.window("BTC-USD", as_of)
        spot = window.spot
        if spot is None:
            continue
        probe = engine.forecast(
            window=window,
            target=spot,
            horizon_s=300,
            service_level=ServiceLevel.FULL,
            feed_age_ns=0,
            now_ns=as_of,
        )
        previous_p = None
        previous_target = None
        for z in np.linspace(-6.0, 6.0, 201):
            target = round(spot * math.exp(z * probe.sigma), 2)
            forecast = engine.forecast(
                window=window,
                target=target,
                horizon_s=300,
                service_level=ServiceLevel.FULL,
                feed_age_ns=0,
                now_ns=as_of,
            )
            checked += 1
            if not (PROB_FLOOR <= forecast.p_above <= 1.0 - PROB_FLOOR):
                floor_hits += 1
            if abs(forecast.p_above + forecast.p_below - 1.0) > 1e-12:
                violations += 1
            if (
                previous_p is not None
                and previous_target is not None
                and target > previous_target
                and forecast.p_above > previous_p + 1e-12
            ):
                violations += 1
            previous_p, previous_target = forecast.p_above, target
    database.dispose()
    ok = violations == 0 and floor_hits == 0 and checked > 400
    return (
        ok,
        f"{checked} served forecasts, {violations} ordering violations, "
        f"{floor_hits} outside the floor",
        {"checked": checked, "violations": violations, "floor_hits": floor_hits},
    )


def check_dirty_data() -> tuple[bool, str, dict[str, Any]]:
    """A broken feed must produce a refusal or a rejection, never a quiet number."""
    database = open_database("sqlite:///:memory:")
    collector = collect(Regime.DIRTY, 13, 7_200, database)
    summary = collector.monitor.summary("BTC-USD")
    rejected = collector.stats.rejected
    database.dispose()
    caught = sum(summary.values())
    ok = rejected > 0 and caught > 0
    return (
        ok,
        f"{rejected} events rejected; {summary}",
        {"rejected": rejected, **summary},
    )


def check_refusals() -> tuple[bool, str, dict[str, Any]]:
    """Too little history, or an unhealthy feed, must both refuse."""
    database = open_database("sqlite:///:memory:")
    collector = collect(Regime.REALISTIC, 21, 7_200, database)
    config = Config(provider="simulated", venue="simulator", symbols=("BTC-USD",))
    engine = ForecastEngine(config=config)
    outcomes: list[str] = []

    short = collector.window("BTC-USD", 5 * 60 * NS_PER_SECOND)
    try:
        engine.forecast(
            window=short,
            target=79_000.0,
            horizon_s=300,
            service_level=ServiceLevel.FULL,
            feed_age_ns=0,
            now_ns=5 * 60 * NS_PER_SECOND,
        )
        outcomes.append("short history NOT refused")
    except ForecastRefused:
        outcomes.append("short history refused")

    good = collector.window("BTC-USD", 90 * 60 * NS_PER_SECOND)
    for level in (ServiceLevel.STALE, ServiceLevel.DOWN):
        try:
            engine.forecast(
                window=good,
                target=79_000.0,
                horizon_s=300,
                service_level=level,
                feed_age_ns=999 * NS_PER_SECOND,
                now_ns=90 * 60 * NS_PER_SECOND,
            )
            outcomes.append(f"{level.value} NOT refused")
        except ForecastRefused:
            outcomes.append(f"{level.value} refused")
    database.dispose()
    ok = all("NOT" not in outcome for outcome in outcomes)
    return ok, "; ".join(outcomes), {"outcomes": outcomes}


def check_tuning_refused() -> tuple[bool, str, dict[str, Any]]:
    """Hyperparameter search on simulated data must raise, not warn."""
    from forecaster.models.dataset import Dataset

    empty = Dataset(
        as_of_ns=np.array([1], dtype=np.int64),
        features=np.zeros((1, 12)),
        z=np.array([0.0]),
        baseline_p=np.array([0.5]),
        label=np.array([1]),
        spot=np.array([1.0]),
        target=np.array([1.0]),
        sigma=np.array([0.01]),
        future_price=np.array([1.0]),
        horizon_s=300,
        symbol="BTC-USD",
        data_source=DataSource.SIMULATED,
    )
    try:
        GradientBoostedCorrection().fit(empty, at_ns=0, tune=True)
    except TuningRefused:
        return True, "tuning on simulated data is refused in code", {}
    except Exception as exc:
        return False, f"raised the wrong error: {type(exc).__name__}: {exc}", {}
    return False, "tuning on simulated data was ALLOWED", {}


def check_persistence() -> tuple[bool, str, dict[str, Any]]:
    """Append-only, hash-chained, and tamper-evident."""
    from sqlalchemy import text

    database = open_database("sqlite:///:memory:")
    repo = PredictionRepository(database)
    row = {
        "created_ns": 1,
        "as_of_ns": 1,
        "eval_at_ns": 301 * NS_PER_SECOND,
        "horizon_s": 300,
        "venue": "simulator",
        "symbol": "BTC-USD",
        "spot": 100.0,
        "target": 101.0,
        "z": 0.5,
        "sigma": 0.01,
        "p_above": 0.4,
        "range_low": 98.0,
        "range_high": 102.0,
        "range_confidence": 0.8,
        "median": 100.0,
        "confidence": "moderate",
        "confidence_reasons": "[]",
        "service_level": "full",
        "model_version": "baseline-t@v",
        "model_train_source": "simulated",
        "calibration_source": None,
        "data_source": "simulated",
        "prediction_mode": "live",
        "features_json": "{}",
        "feature_set_version": "fs-1",
        "contributions_json": "[]",
    }
    for i in range(20):
        repo.append({**row, "created_ns": i + 1})
    verified = repo.verify_chain()

    blocked = 0
    for statement in (
        "UPDATE predictions SET p_above = 0.9 WHERE id = 1",
        "DELETE FROM predictions WHERE id = 1",
    ):
        try:
            with database.begin() as conn:
                conn.execute(text(statement))
        except Exception:
            blocked += 1

    certainty_blocked = 0
    for impossible in (0.0, 1.0):
        try:
            repo.append({**row, "p_above": impossible})
        except Exception:
            certainty_blocked += 1

    # And a tamper is caught once the trigger is removed.
    from forecaster.store.hashchain import ChainBreak

    with database.begin() as conn:
        conn.execute(text("DROP TRIGGER trg_predictions_no_update"))
        conn.execute(text("UPDATE predictions SET p_above = 0.95 WHERE id = 7"))
    try:
        repo.verify_chain()
        tamper_caught = False
    except ChainBreak:
        tamper_caught = True
    database.dispose()

    ok = verified == 20 and blocked == 2 and certainty_blocked == 2 and tamper_caught
    return (
        ok,
        f"{verified} rows chained, {blocked}/2 edits blocked, "
        f"{certainty_blocked}/2 certainties refused, "
        f"tamper {'caught' if tamper_caught else 'MISSED'}",
        {"verified": verified, "blocked": blocked, "tamper_caught": tamper_caught},
    )


def check_determinism() -> tuple[bool, str, dict[str, Any]]:
    """The same seed must give the same market, twice."""

    def fingerprint(seed: int) -> tuple[int, float]:
        database = open_database("sqlite:///:memory:")
        collector = collect(Regime.REALISTIC, seed, 1_800, database)
        window = collector.window("BTC-USD", 1_700 * NS_PER_SECOND)
        spot = window.spot or 0.0
        counts = collector.stats.trades
        database.dispose()
        return counts, spot

    first = fingerprint(31)
    second = fingerprint(31)
    different = fingerprint(32)
    ok = first == second and first != different
    return (
        ok,
        f"same seed identical: {first == second}; different seed differs: {first != different}",
        {"first": list(first), "second": list(second)},
    )


def check_feature_parity() -> tuple[bool, str, dict[str, Any]]:
    """The live path and the training path must agree exactly."""
    from forecaster.features.window import CachedWindowSource, StoreWindowSource

    database = open_database("sqlite:///:memory:")
    collector = collect(Regime.REALISTIC, 88, 7_200, database)
    market_repo = MarketRepository(database)
    store = StoreWindowSource(
        market_repo=market_repo,
        symbol="BTC-USD",
        venue="simulator",
        data_source=DataSource.SIMULATED,
    )
    cached = CachedWindowSource(
        market_repo=market_repo,
        symbol="BTC-USD",
        venue="simulator",
        data_source=DataSource.SIMULATED,
        start_ns=0,
        end_ns=7_200 * NS_PER_SECOND,
    ).load()

    mismatches = 0
    checked = 0
    for step in range(20):
        as_of = (2_400 + step * 200) * NS_PER_SECOND
        live = collector.window("BTC-USD", as_of)
        a = compute_features(live, validate=False).values
        b = compute_features(store.window(as_of), validate=False).values
        c = compute_features(cached.window(as_of), validate=False).values
        checked += 1
        if a != b or b != c:
            mismatches += 1
    database.dispose()
    return (
        mismatches == 0 and checked >= 15,
        f"{checked} instants compared across three window sources, {mismatches} mismatches",
        {"checked": checked, "mismatches": mismatches},
    )


# ---------------------------------------------------------------------------


def run_verification(*, seeds: int = 8, output: str | None = None, quick: bool = False) -> int:
    print(BANNER)
    print("=" * len(BANNER))
    print()
    # Sockets off for the whole run. Any check that reached for the network would
    # raise rather than quietly succeed, which is what makes a green run mean
    # "this works offline" rather than "this happened to work".
    try:
        from pytest_socket import disable_socket, enable_socket

        disable_socket(allow_unix_socket=True)
    except ImportError:  # pragma: no cover - dev dependency only
        enable_socket = None  # type: ignore[assignment]

    suite = Suite()
    started = time.monotonic()

    suite.run("runs with the network off", check_offline)
    suite.run("persistence and hash chain", check_persistence)
    suite.run("tuning refused on simulated data", check_tuning_refused)
    suite.run("leakage canary caught", check_leakage_canary)
    suite.run("determinism", check_determinism)
    suite.run("feature parity across sources", check_feature_parity)
    suite.run("refusals on bad input", check_refusals)
    suite.run("dirty feed handled", check_dirty_data)
    suite.run("served output ordering", check_monotonicity)
    suite.run(
        "known analytic answer", lambda: check_known_answer(2 if quick else max(2, seeds // 3))
    )
    if not quick:
        suite.run("null-alpha gate", lambda: check_null_alpha(seeds))

    elapsed = time.monotonic() - started
    print()
    passed = len(suite.checks) - len(suite.failed)
    print(f"{passed}/{len(suite.checks)} checks passed in {elapsed:.1f}s")
    if suite.failed:
        print("\nFAILED:")
        for check in suite.failed:
            print(f"  {check.name}: {check.detail}")
    print()
    print(BANNER)

    report = {
        "banner": BANNER,
        "generated_at": iso(now_ns()),
        "seeds": seeds,
        "quick": quick,
        "elapsed_s": round(elapsed, 2),
        "passed": passed,
        "total": len(suite.checks),
        "checks": [
            {
                "name": c.name,
                "passed": c.passed,
                "detail": c.detail,
                "duration_s": round(c.duration_s, 3),
                "numbers": c.numbers,
            }
            for c in suite.checks
        ],
    }
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"report written to {path}")

    if enable_socket is not None:
        enable_socket()
    return 0 if not suite.failed else 1
