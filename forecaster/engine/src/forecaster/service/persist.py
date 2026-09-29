"""Turning a forecast into the row that records it.

One function, in one place, because there are now two callers — the HTTP service
and the unattended live runner — and two copies of a thirty-field dictionary is
two places for a provenance field to go missing. The append-only log is the
product's evidence; a forecast recorded without `data_source` or without
`model_train_source` is a forecast that cannot later be separated from the ones
that count.
"""

from __future__ import annotations

import json
from typing import Any

from forecaster.clock import now_ns
from forecaster.types import Forecast


def prediction_row(forecast: Forecast, *, created_ns: int | None = None) -> dict[str, Any]:
    """The database row for one forecast, provenance fields included."""
    return {
        "created_ns": created_ns if created_ns is not None else now_ns(),
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
        "prediction_mode": forecast.prediction_mode.value,
        "features_json": json.dumps(forecast.features.values),
        "feature_set_version": forecast.features.feature_set_version,
        "contributions_json": json.dumps(
            [
                {
                    "name": c.name,
                    "label": c.label,
                    "direction": c.direction,
                    "weight": c.weight,
                    "detail": c.detail,
                }
                for c in forecast.contributions
            ]
        ),
    }
