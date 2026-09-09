"""Replaying history as if it were live.

The rule the backtester exists to enforce: **every historical forecast is made
from exactly what the live system would have known at that instant**. Not the
day's data, not the fold's data — the window ending at that moment, built by the
same `MarketWindow` code the server uses, and passed to the same
`ForecastEngine`.

That is why the engine takes a window rather than a database handle. A backtester
with its own forecasting path is a backtester that measures its own path, and the
gap between it and production is invisible until the product is live.

Results are written to the same tables as live predictions, tagged
`prediction_mode = backfill`, so they can be analysed with the same tooling and
can never be mistaken for a live track record.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from forecaster.clock import now_ns
from forecaster.config import Config
from forecaster.features.window import CachedWindowSource
from forecaster.labels.resolve import label_from_price
from forecaster.service.engine import ForecastEngine, ForecastRefused
from forecaster.store import MarketRepository, PredictionRepository
from forecaster.types import NS_PER_SECOND, DataSource, PredictionMode, ServiceLevel
from forecaster.validation.bootstrap import paired_delta
from forecaster.validation.metrics import evaluate, probability_buckets
from forecaster.validation.splits import effective_sample_size

DEFAULT_Z_TARGETS: tuple[float, ...] = (-2.0, -1.0, -0.5, -0.25, 0.25, 0.5, 1.0, 2.0)


@dataclass
class BacktestResult:
    n_forecasts: int
    n_refused: int
    n_unresolved: int
    metrics: dict[str, Any]
    by_horizon: dict[int, dict[str, Any]]
    by_distance: list[dict[str, Any]]
    by_volatility: list[dict[str, Any]]
    sample_size: dict[str, Any]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_forecasts": self.n_forecasts,
            "n_refused": self.n_refused,
            "n_unresolved": self.n_unresolved,
            "metrics": self.metrics,
            "by_horizon": {str(k): v for k, v in self.by_horizon.items()},
            "by_distance": self.by_distance,
            "by_volatility": self.by_volatility,
            "sample_size": self.sample_size,
            "warnings": self.warnings,
        }

    def summary(self) -> str:
        lines = [
            f"forecasts   {self.n_forecasts:,} "
            f"({self.n_refused} refused, {self.n_unresolved} unresolved)",
            f"evidence    {self.sample_size.get('n_non_overlapping')} independent observations",
        ]
        for horizon, metrics in sorted(self.by_horizon.items()):
            lines.append(
                f"{horizon:>5}s      Brier {metrics['brier']:.5f}  ECE {metrics['ece']:.5f}  "
                f"accuracy {metrics['accuracy']:.1%}  n={metrics['n']:,}"
            )
        for warning in self.warnings:
            lines.append(f"warning     {warning}")
        return "\n".join(lines)


def run_backtest(
    *,
    config: Config,
    engine: ForecastEngine,
    market_repo: MarketRepository,
    prediction_repo: PredictionRepository | None,
    symbol: str,
    venue: str,
    data_source: DataSource,
    start_ns: int,
    end_ns: int,
    horizons_s: tuple[int, ...] = (300, 1200),
    step_s: int = 60,
    z_targets: tuple[float, ...] = DEFAULT_Z_TARGETS,
    warmup_s: int = 3600,
    persist: bool = False,
) -> BacktestResult:
    """Walk forward through recorded data, forecasting and scoring as we go."""
    window_source = CachedWindowSource(
        market_repo=market_repo,
        symbol=symbol,
        venue=venue,
        data_source=data_source,
        start_ns=start_ns,
        end_ns=end_ns,
    ).load()

    def price_at(ns: int) -> float | None:
        trade = market_repo.last_trade_at_or_before(symbol, ns, source=data_source, venue=venue)
        return trade.price if trade is not None else None

    records: list[dict[str, Any]] = []
    refused = 0
    unresolved = 0
    step_ns = step_s * NS_PER_SECOND
    longest_ns = max(horizons_s) * NS_PER_SECOND

    as_of = start_ns + warmup_s * NS_PER_SECOND
    while as_of <= end_ns - longest_ns:
        window = window_source.window(as_of)
        if window.spot is None:
            as_of += step_ns
            continue
        spot = window.spot

        for horizon_s in horizons_s:
            future_price = price_at(as_of + horizon_s * NS_PER_SECOND)
            if future_price is None:
                unresolved += 1
                continue
            for z_target in z_targets:
                # The target is set in volatility units so the difficulty of the
                # question is comparable across quiet and violent periods. A
                # fixed dollar grid would make the backtest mostly a report on
                # which days were calm.
                try:
                    probe = engine.forecast(
                        window=window,
                        target=spot,
                        horizon_s=horizon_s,
                        service_level=ServiceLevel.FULL,
                        feed_age_ns=0,
                        now_ns=as_of,
                        prediction_mode=PredictionMode.BACKFILL,
                    )
                except ForecastRefused:
                    refused += 1
                    break
                target = spot * float(np.exp(z_target * probe.sigma))
                try:
                    forecast = engine.forecast(
                        window=window,
                        target=target,
                        horizon_s=horizon_s,
                        service_level=ServiceLevel.FULL,
                        feed_age_ns=0,
                        now_ns=as_of,
                        prediction_mode=PredictionMode.BACKFILL,
                    )
                except ForecastRefused:
                    refused += 1
                    continue

                outcome = 1.0 if label_from_price(future_price, target) else 0.0
                # The comparison every result is measured against. Without it, a
                # Brier score is a number with no scale.
                baseline_p = engine.baseline_probability(window, horizon_s, target)
                records.append(
                    {
                        "as_of_ns": as_of,
                        "horizon_s": horizon_s,
                        "z": forecast.z,
                        "sigma": forecast.sigma,
                        "p_above": forecast.p_above,
                        "baseline_p": baseline_p,
                        "label": outcome,
                        "spot": spot,
                        "target": target,
                        "future_price": future_price,
                        "confidence": forecast.confidence.value,
                    }
                )
                if persist and prediction_repo is not None:
                    _persist_backfill(prediction_repo, forecast)

        as_of += step_ns

    return _summarise(records, refused, unresolved, horizons_s, step_s)


def _persist_backfill(repo: PredictionRepository, forecast: Any) -> None:
    repo.append(
        {
            "created_ns": now_ns(),
            "as_of_ns": forecast.as_of_ns,
            "eval_at_ns": forecast.eval_at_ns,
            "horizon_s": forecast.horizon_s,
            "venue": forecast.venue,
            "symbol": forecast.symbol,
            "spot": forecast.spot,
            "target": forecast.target,
            "z": forecast.z,
            "sigma": forecast.sigma,
            "p_above": forecast.p_above,
            "range_low": forecast.range_low,
            "range_high": forecast.range_high,
            "range_confidence": forecast.range_confidence,
            "median": forecast.median,
            "confidence": forecast.confidence.value,
            "confidence_reasons": json.dumps(list(forecast.confidence_reasons)),
            "service_level": forecast.service_level.value,
            "model_version": forecast.model_version,
            "model_train_source": forecast.model_train_source.value,
            "calibration_source": (
                forecast.calibration_source.value if forecast.calibration_source else None
            ),
            "data_source": forecast.data_source.value,
            "prediction_mode": PredictionMode.BACKFILL.value,
            "features_json": json.dumps(forecast.features.values),
            "feature_set_version": forecast.features.feature_set_version,
            "contributions_json": "[]",
        }
    )


def _summarise(
    records: list[dict[str, Any]],
    refused: int,
    unresolved: int,
    horizons_s: tuple[int, ...],
    step_s: int,
) -> BacktestResult:
    warnings: list[str] = []
    if not records:
        return BacktestResult(0, refused, unresolved, {}, {}, [], [], {}, ["no forecasts produced"])

    p = np.asarray([r["p_above"] for r in records])
    base = np.asarray([r["baseline_p"] for r in records])
    y = np.asarray([r["label"] for r in records])
    timestamps = [int(r["as_of_ns"]) for r in records]

    sample = effective_sample_size(timestamps, max(horizons_s), len(records))
    if sample.n_non_overlapping < 200:
        warnings.append(
            f"only {sample.n_non_overlapping} independent observations behind these figures; "
            "treat every number here as indicative, not established"
        )

    overall = evaluate(p, y, reference=base, reference_name="baseline-t").to_dict()
    delta = paired_delta(
        ((p - y) ** 2).tolist(),
        ((base - y) ** 2).tolist(),
        horizon_s=max(horizons_s),
        interval_s=float(step_s),
    )
    overall["vs_baseline"] = {**delta.to_dict(), "description": delta.describe()}

    by_horizon: dict[int, dict[str, Any]] = {}
    for horizon_s in horizons_s:
        mask = np.asarray([r["horizon_s"] == horizon_s for r in records])
        if not mask.any():
            continue
        metrics = evaluate(p[mask], y[mask], reference=base[mask], reference_name="baseline-t")
        by_horizon[horizon_s] = metrics.to_dict()

    by_distance: list[dict[str, Any]] = []
    for low, high in ((0.0, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 99.0)):
        mask = np.asarray([low <= abs(r["z"]) < high for r in records])
        if not mask.any():
            by_distance.append({"low": low, "high": high, "n": 0})
            continue
        by_distance.append(
            {
                "low": low,
                "high": high,
                "n": int(mask.sum()),
                "brier": float(np.mean((p[mask] - y[mask]) ** 2)),
                "baseline_brier": float(np.mean((base[mask] - y[mask]) ** 2)),
                "mean_predicted": float(np.mean(p[mask])),
                "observed_rate": float(np.mean(y[mask])),
                "accuracy": float(np.mean((p[mask] > 0.5) == (y[mask] > 0.5))),
            }
        )

    sigmas = np.asarray([r["sigma"] for r in records])
    terciles = np.quantile(sigmas, [1 / 3, 2 / 3]) if sigmas.size else np.array([0.0, 0.0])
    by_volatility: list[dict[str, Any]] = []
    for name, mask in (
        ("low", sigmas <= terciles[0]),
        ("medium", (sigmas > terciles[0]) & (sigmas <= terciles[1])),
        ("high", sigmas > terciles[1]),
    ):
        if not mask.any():
            by_volatility.append({"regime": name, "n": 0})
            continue
        by_volatility.append(
            {
                "regime": name,
                "n": int(mask.sum()),
                "brier": float(np.mean((p[mask] - y[mask]) ** 2)),
                "baseline_brier": float(np.mean((base[mask] - y[mask]) ** 2)),
                "ece": float(evaluate(p[mask], y[mask]).ece),
                "mean_sigma_pct": float(np.mean(sigmas[mask]) * 100.0),
            }
        )

    overall["probability_buckets"] = list(probability_buckets(p, y))

    return BacktestResult(
        n_forecasts=len(records),
        n_refused=refused,
        n_unresolved=unresolved,
        metrics=overall,
        by_horizon=by_horizon,
        by_distance=by_distance,
        by_volatility=by_volatility,
        sample_size=sample.to_dict(),
        warnings=warnings,
    )
