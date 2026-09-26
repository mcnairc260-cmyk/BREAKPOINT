"""Turning recorded outcomes into a performance report.

The grouping rule matters more than any individual number. Metrics are computed
per (symbol, horizon, data source) and never pooled across them, because:

* a Brier score averaged over five- and twenty-minute forecasts describes
  neither,
* simulated and live results are not the same kind of evidence, and
* two model versions averaged together hide the moment one replaced the other.

Every figure carries its sample size, and small samples say so in words. Twelve
forecasts cannot demonstrate calibration, and a report that renders twelve
outcomes the same way it renders twelve thousand is misleading by layout.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from forecaster.store import PredictionRepository
from forecaster.validation.metrics import evaluate
from forecaster.validation.splits import effective_sample_size

# Below this many resolved outcomes, no calibration claim is made at all.
MIN_FOR_CALIBRATION_CLAIM = 100
ROLLING_WINDOWS = (20, 50, 100)


def json_safe(value: Any) -> Any:
    """Replace values JSON cannot represent with null.

    Metrics legitimately come out as NaN — the area under the ROC curve is
    undefined when every outcome went the same way, and calibration error is
    undefined with no outcomes at all. Python's json module emits bare `NaN`
    for those, which is not valid JSON: browsers reject the response and the
    whole statistics page fails rather than one figure showing as blank.

    So a metric that could not be computed is reported as `null`, which the
    interface already renders as an em dash.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, np.floating):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def _rows_to_arrays(rows: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray]:
    p = np.asarray([float(r["p_above"]) for r in rows], dtype=float)
    y = np.asarray([1.0 if str(r["outcome"]).endswith("above") else 0.0 for r in rows], dtype=float)
    return p, y


def _group_report(rows: list[dict[str, Any]], horizon_s: int) -> dict[str, Any]:
    if not rows:
        return {"n": 0, "note": "no resolved forecasts yet"}
    p, y = _rows_to_arrays(rows)
    # The reference every skill score is measured against: an uninformative 50%.
    # Beating it is necessary, not sufficient — the volatility baseline is the
    # real bar, and the backtest compares against that.
    reference = np.full(p.size, 0.5)
    metrics = evaluate(p, y, reference=reference, reference_name="always-50%")
    timestamps = [int(r["as_of_ns"]) for r in rows]
    sample = effective_sample_size(timestamps, horizon_s, len(rows))

    payload = metrics.to_dict()
    payload["sample_size"] = sample.to_dict()
    payload["sample_size_note"] = sample.describe()
    payload["rolling"] = _rolling(p, y)
    payload["can_claim_calibration"] = len(rows) >= MIN_FOR_CALIBRATION_CLAIM
    if len(rows) < MIN_FOR_CALIBRATION_CLAIM:
        payload["calibration_note"] = (
            f"{len(rows)} resolved forecasts is far too few to say anything about "
            f"calibration. At least {MIN_FOR_CALIBRATION_CLAIM} are needed before the "
            "reliability curve means much, and several thousand before it is solid."
        )
    return payload


def _rolling(p: np.ndarray, y: np.ndarray) -> dict[str, Any]:
    """Recent performance, as the brief asks — with the caveat attached.

    A twenty-forecast window has a standard error on accuracy of about eleven
    percentage points. It is shown because it is useful for spotting something
    breaking, and labelled because it cannot establish quality.
    """
    out: dict[str, Any] = {}
    for window in ROLLING_WINDOWS:
        if p.size < window:
            out[f"last_{window}"] = None
            continue
        recent_p, recent_y = p[-window:], y[-window:]
        out[f"last_{window}"] = {
            "n": window,
            "accuracy": float(np.mean((recent_p > 0.5) == (recent_y > 0.5))),
            "brier": float(np.mean((recent_p - recent_y) ** 2)),
            "note": "too small a sample to establish quality" if window <= 50 else None,
        }
    out["all_time"] = {
        "n": int(p.size),
        "accuracy": float(np.mean((p > 0.5) == (y > 0.5))) if p.size else None,
        "brier": float(np.mean((p - y) ** 2)) if p.size else None,
    }
    return out


def performance_report(
    repo: PredictionRepository,
    *,
    data_source: str | None = None,
    prediction_mode: str = "live",
) -> dict[str, Any]:
    """The statistics page, grouped so nothing misleading can be read off it."""
    from forecaster.types import HORIZONS_S, SYMBOLS

    groups: dict[str, Any] = {}
    total_resolved = 0
    for symbol in SYMBOLS:
        for horizon_s in HORIZONS_S:
            rows = repo.scored(
                symbol=symbol,
                horizon_s=horizon_s,
                prediction_mode=prediction_mode,
                data_source=data_source,
            )
            total_resolved += len(rows)
            groups[f"{symbol}|{horizon_s}"] = {
                "symbol": symbol,
                "horizon_s": horizon_s,
                **_group_report(rows, horizon_s),
            }

    all_rows = repo.scored(prediction_mode=prediction_mode, data_source=data_source)
    by_distance = _by_distance_bucket(all_rows)
    by_confidence = _by_confidence(all_rows)

    return json_safe(
        {
            "data_source": data_source,
            "prediction_mode": prediction_mode,
            "total_resolved": total_resolved,
            "groups": groups,
            "by_target_distance": by_distance,
            "by_confidence": by_confidence,
            "void_analysis": _void_analysis(repo, data_source, prediction_mode),
            "honesty_note": (
                "Metrics are never pooled across symbol, horizon or data source. "
                "A number computed across two of anything describes neither."
            ),
        }
    )


def _by_distance_bucket(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Performance by how far the target was, in volatility units.

    The single most informative breakdown. A model can look excellent overall
    purely because most sampled targets were far away and therefore easy.
    """
    buckets = ((0.0, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 99.0))
    out: list[dict[str, Any]] = []
    for low, high in buckets:
        selected = [r for r in rows if low <= abs(float(r["z"])) < high]
        if not selected:
            out.append({"low": low, "high": high, "n": 0})
            continue
        p, y = _rows_to_arrays(selected)
        out.append(
            {
                "low": low,
                "high": high,
                "n": len(selected),
                "brier": float(np.mean((p - y) ** 2)),
                "accuracy": float(np.mean((p > 0.5) == (y > 0.5))),
                "mean_predicted": float(np.mean(p)),
                "observed_rate": float(np.mean(y)),
            }
        )
    return out


def _by_confidence(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Do the confidence labels separate?

    The honest test of the confidence system. If HIGH, MODERATE and LOW show
    indistinguishable Brier scores, the label is decoration and the report says
    so rather than letting it stand.
    """
    out: list[dict[str, Any]] = []
    for level in ("high", "moderate", "low"):
        selected = [r for r in rows if str(r["confidence"]) == level]
        if not selected:
            out.append({"confidence": level, "n": 0})
            continue
        p, y = _rows_to_arrays(selected)
        out.append(
            {
                "confidence": level,
                "n": len(selected),
                "brier": float(np.mean((p - y) ** 2)),
                "accuracy": float(np.mean((p > 0.5) == (y > 0.5))),
            }
        )
    scored = [b for b in out if b.get("n", 0) >= 50 and "brier" in b]
    if len(scored) >= 2:
        spread = max(b["brier"] for b in scored) - min(b["brier"] for b in scored)
        separates = spread > 0.01
    else:
        separates = None
    return [
        *out,
        {
            "buckets_separate": separates,
            "note": (
                "The confidence label is only meaningful if these buckets show different "
                "Brier scores. Until they demonstrably do, the thresholds are provisional."
            ),
        },
    ]


def _void_analysis(
    repo: PredictionRepository, data_source: str | None, prediction_mode: str
) -> dict[str, Any]:
    """How many forecasts could not be scored, and what that does to accuracy.

    Voids are not neutral: feeds drop when markets move, so unscored forecasts
    are disproportionately the volatile ones. Excluding them flatters accuracy
    exactly where it should not, so bounds are reported under the assumption that
    every void was wrong and that every void was right. The truth is between.
    """
    all_rows = repo.history(limit=100_000, prediction_mode=prediction_mode)
    resolved = [
        r for r in all_rows if r.get("outcome") and not str(r["outcome"]).startswith("void")
    ]
    voided = [r for r in all_rows if r.get("outcome") and str(r["outcome"]).startswith("void")]
    pending = [r for r in all_rows if not r.get("outcome")]
    if not resolved:
        return {"resolved": 0, "voided": len(voided), "pending": len(pending)}
    correct = sum(1 for r in resolved if r.get("correct"))
    n_scored = len(resolved)
    n_void = len(voided)
    return {
        "resolved": n_scored,
        "voided": n_void,
        "pending": len(pending),
        "void_rate": n_void / (n_scored + n_void) if (n_scored + n_void) else 0.0,
        "accuracy": correct / n_scored,
        "accuracy_if_all_voids_wrong": correct / (n_scored + n_void)
        if (n_scored + n_void)
        else None,
        "accuracy_if_all_voids_right": (
            (correct + n_void) / (n_scored + n_void) if (n_scored + n_void) else None
        ),
    }
