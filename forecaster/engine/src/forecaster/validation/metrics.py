"""Measuring forecast quality.

Accuracy is the least useful number here and is reported last. A forecaster that
says 55% and is right 55% of the time is doing its job perfectly; accuracy calls
that a near-failure. What matters is whether the stated probabilities match
observed frequencies, and by how much they beat the obvious alternative.

So the headline metrics are:

* **Brier score** — mean squared error of the probability. Proper: it cannot be
  improved by shading the number away from what you believe.
* **Brier skill score** — the Brier score against a reference model. This, not
  raw Brier, is the number that means something. A raw Brier of 0.01 sounds
  superb and is trivially achievable by always saying 1% for a target three
  standard deviations away.
* **Expected calibration error** — the average gap between what was promised and
  what happened, across probability buckets.
* **Murphy decomposition** — splits the Brier score into reliability (are the
  probabilities honest), resolution (do they vary usefully) and uncertainty (how
  hard was the problem). A model can have a good Brier score purely because the
  problem was easy; this is how you tell.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np
from numpy.typing import ArrayLike

# The buckets the product reports against, matching the brief.
DEFAULT_BUCKETS: tuple[tuple[float, float], ...] = (
    (0.50, 0.55),
    (0.55, 0.60),
    (0.60, 0.65),
    (0.65, 0.70),
    (0.70, 0.75),
    (0.75, 0.80),
    (0.80, 1.01),
)


def _as_arrays(p: ArrayLike, y: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
    probs = np.asarray(p, dtype=float)
    actual = np.asarray(y, dtype=float)
    if probs.shape != actual.shape:
        raise ValueError("probabilities and outcomes must be the same length")
    return probs, actual


def brier(p: ArrayLike, y: ArrayLike) -> float:
    probs, actual = _as_arrays(p, y)
    if probs.size == 0:
        return float("nan")
    return float(np.mean((probs - actual) ** 2))


def log_loss(p: ArrayLike, y: ArrayLike) -> float:
    probs, actual = _as_arrays(p, y)
    if probs.size == 0:
        return float("nan")
    safe = np.clip(probs, 1e-12, 1.0 - 1e-12)
    return float(-np.mean(actual * np.log(safe) + (1.0 - actual) * np.log(1.0 - safe)))


def accuracy(p: ArrayLike, y: ArrayLike) -> float:
    probs, actual = _as_arrays(p, y)
    if probs.size == 0:
        return float("nan")
    return float(np.mean((probs > 0.5) == (actual > 0.5)))


def brier_skill_score(p: ArrayLike, y: ArrayLike, reference: ArrayLike) -> float:
    """How much better than a reference model, on a 0-to-1 scale.

    Zero means no better. Negative means worse. This is the only fair way to
    compare across target distances: the difficulty of the question varies
    enormously with how far the target is, and a raw score conflates skill with
    difficulty.
    """
    model = brier(p, y)
    baseline = brier(reference, y)
    if not math.isfinite(baseline) or baseline <= 0.0:
        return float("nan")
    return 1.0 - model / baseline


def auc(p: ArrayLike, y: ArrayLike) -> float:
    """Rank discrimination. Reported because it is asked for, and read with care:
    a model can rank perfectly and still be badly calibrated, which for this
    product would be a failure."""
    probs, actual = _as_arrays(p, y)
    positives = probs[actual > 0.5]
    negatives = probs[actual <= 0.5]
    if positives.size == 0 or negatives.size == 0:
        return float("nan")
    order = np.argsort(np.concatenate([positives, negatives]))
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, order.size + 1)
    rank_sum = float(np.sum(ranks[: positives.size]))
    return (rank_sum - positives.size * (positives.size + 1) / 2.0) / (
        positives.size * negatives.size
    )


@dataclass(frozen=True)
class CalibrationBucket:
    low: float
    high: float
    count: int
    mean_predicted: float
    observed_rate: float
    ci_low: float
    ci_high: float

    @property
    def gap(self) -> float:
        return self.observed_rate - self.mean_predicted

    @property
    def is_consistent(self) -> bool:
        """Does the promised probability fall inside the observed interval?

        With small samples this is nearly always true, which is itself the
        message: a handful of forecasts cannot demonstrate calibration, and the
        interval says so honestly.
        """
        return self.ci_low <= self.mean_predicted <= self.ci_high


@dataclass(frozen=True)
class CalibrationCurve:
    buckets: tuple[CalibrationBucket, ...]
    ece: float
    max_error: float

    def to_dict(self) -> dict[str, object]:
        return {
            "ece": self.ece,
            "max_error": self.max_error,
            "buckets": [
                {
                    "low": b.low,
                    "high": b.high,
                    "count": b.count,
                    "mean_predicted": b.mean_predicted,
                    "observed_rate": b.observed_rate,
                    "ci_low": b.ci_low,
                    "ci_high": b.ci_high,
                    "consistent": b.is_consistent,
                }
                for b in self.buckets
            ],
        }


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple[float, float]:
    """A binomial confidence interval that behaves at small counts.

    The textbook normal-approximation interval produces intervals that extend
    below zero and above one when counts are small, which is exactly the regime
    this product lives in early on. Wilson does not.
    """
    if trials == 0:
        return 0.0, 1.0
    phat = successes / trials
    denominator = 1.0 + z * z / trials
    centre = phat + z * z / (2.0 * trials)
    margin = z * math.sqrt(phat * (1.0 - phat) / trials + z * z / (4.0 * trials * trials))
    return max(0.0, (centre - margin) / denominator), min(1.0, (centre + margin) / denominator)


def reliability_curve(p: ArrayLike, y: ArrayLike, *, n_bins: int = 10) -> CalibrationCurve:
    """Predicted probability against observed frequency.

    The diagonal is perfect. Every bucket carries a count and a confidence
    interval, because a point on the curve backed by four forecasts is not
    evidence and should not look like it.
    """
    probs, actual = _as_arrays(p, y)
    if probs.size == 0:
        return CalibrationCurve(buckets=(), ece=float("nan"), max_error=float("nan"))
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    buckets: list[CalibrationBucket] = []
    weighted_error = 0.0
    max_error = 0.0
    for low, high in pairwise(edges):
        mask = (probs >= low) & (probs < high) if high < 1.0 else (probs >= low) & (probs <= high)
        count = int(np.sum(mask))
        if count == 0:
            continue
        mean_predicted = float(np.mean(probs[mask]))
        successes = int(np.sum(actual[mask]))
        observed = successes / count
        ci_low, ci_high = wilson_interval(successes, count)
        buckets.append(
            CalibrationBucket(
                low=float(low),
                high=float(high),
                count=count,
                mean_predicted=mean_predicted,
                observed_rate=observed,
                ci_low=ci_low,
                ci_high=ci_high,
            )
        )
        error = abs(observed - mean_predicted)
        weighted_error += error * count
        max_error = max(max_error, error)
    ece = weighted_error / probs.size if probs.size else float("nan")
    return CalibrationCurve(buckets=tuple(buckets), ece=ece, max_error=max_error)


def expected_calibration_error(p: ArrayLike, y: ArrayLike, *, n_bins: int = 10) -> float:
    return reliability_curve(p, y, n_bins=n_bins).ece


@dataclass(frozen=True)
class MurphyParts:
    """Brier = reliability − resolution + uncertainty."""

    reliability: float
    """How far promises sat from outcomes. Lower is better; zero is perfect
    calibration."""
    resolution: float
    """How much the forecasts varied usefully from the base rate. Higher is
    better; zero means the model always says the same thing."""
    uncertainty: float
    """How hard the problem was. A property of the data, not the model."""

    @property
    def brier(self) -> float:
        return self.reliability - self.resolution + self.uncertainty


def murphy_decomposition(p: ArrayLike, y: ArrayLike, *, n_bins: int = 10) -> MurphyParts:
    """Separate honesty from usefulness from difficulty.

    Worth the extra code: it is how you catch a model whose good Brier score
    comes entirely from the questions being easy, which is the normal situation
    when most sampled targets sit far from the current price.
    """
    probs, actual = _as_arrays(p, y)
    if probs.size == 0:
        return MurphyParts(float("nan"), float("nan"), float("nan"))
    base_rate = float(np.mean(actual))
    uncertainty = base_rate * (1.0 - base_rate)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    reliability = 0.0
    resolution = 0.0
    for low, high in pairwise(edges):
        mask = (probs >= low) & (probs < high) if high < 1.0 else (probs >= low) & (probs <= high)
        count = int(np.sum(mask))
        if count == 0:
            continue
        mean_predicted = float(np.mean(probs[mask]))
        observed = float(np.mean(actual[mask]))
        weight = count / probs.size
        reliability += weight * (mean_predicted - observed) ** 2
        resolution += weight * (observed - base_rate) ** 2
    return MurphyParts(reliability=reliability, resolution=resolution, uncertainty=uncertainty)


def poisson_tail_test(expected: float, observed: int) -> float:
    """Two-sided Poisson p-value for rare-event buckets.

    In the far tail, Brier scores say nothing — every prediction is near zero and
    every outcome is almost always negative. The honest question there is "we
    expected 12.3 of these and saw 19; is that surprising?", which is a Poisson
    question, not a squared-error one.
    """
    from scipy import stats

    if expected <= 0.0:
        return float("nan")
    if observed >= expected:
        return float(min(1.0, 2.0 * stats.poisson.sf(observed - 1, expected)))
    return float(min(1.0, 2.0 * stats.poisson.cdf(observed, expected)))


@dataclass
class MetricSet:
    """Everything measured about one group of forecasts.

    A group is one (symbol, horizon, model version, data source). Metrics are
    never averaged across groups, because a Brier score spanning two models and
    two horizons describes none of them.
    """

    n: int
    brier: float
    log_loss: float
    accuracy: float
    auc: float
    ece: float
    max_calibration_error: float
    base_rate: float
    mean_predicted: float
    murphy: MurphyParts
    curve: CalibrationCurve
    brier_skill: float | None = None
    reference: str | None = None
    buckets: tuple[dict[str, object], ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, object]:
        return {
            "n": self.n,
            "brier": self.brier,
            "log_loss": self.log_loss,
            "accuracy": self.accuracy,
            "auc": self.auc,
            "ece": self.ece,
            "max_calibration_error": self.max_calibration_error,
            "base_rate": self.base_rate,
            "mean_predicted": self.mean_predicted,
            "brier_skill": self.brier_skill,
            "reference": self.reference,
            "murphy": {
                "reliability": self.murphy.reliability,
                "resolution": self.murphy.resolution,
                "uncertainty": self.murphy.uncertainty,
            },
            "calibration": self.curve.to_dict(),
            "probability_buckets": list(self.buckets),
        }


def probability_buckets(
    p: ArrayLike,
    y: ArrayLike,
    buckets: tuple[tuple[float, float], ...] = DEFAULT_BUCKETS,
) -> tuple[dict[str, object], ...]:
    """Performance by confidence band, as the brief asks for.

    Probabilities below 0.5 are folded to their complement, so a 30% ABOVE and a
    70% BELOW land in the same bucket. They are the same statement.
    """
    probs, actual = _as_arrays(p, y)
    folded_p = np.where(probs >= 0.5, probs, 1.0 - probs)
    folded_y = np.where(probs >= 0.5, actual, 1.0 - actual)
    out: list[dict[str, object]] = []
    for low, high in buckets:
        mask = (folded_p >= low) & (folded_p < high)
        count = int(np.sum(mask))
        if count == 0:
            out.append(
                {
                    "low": low,
                    "high": high,
                    "n": 0,
                    "predicted": None,
                    "observed": None,
                    "ci_low": None,
                    "ci_high": None,
                }
            )
            continue
        successes = int(np.sum(folded_y[mask]))
        ci_low, ci_high = wilson_interval(successes, count)
        out.append(
            {
                "low": low,
                "high": high,
                "n": count,
                "predicted": float(np.mean(folded_p[mask])),
                "observed": successes / count,
                "ci_low": ci_low,
                "ci_high": ci_high,
            }
        )
    return tuple(out)


def evaluate(
    p: ArrayLike,
    y: ArrayLike,
    *,
    reference: ArrayLike | None = None,
    reference_name: str | None = None,
    n_bins: int = 10,
) -> MetricSet:
    probs, actual = _as_arrays(p, y)
    return MetricSet(
        n=int(probs.size),
        brier=brier(probs, actual),
        log_loss=log_loss(probs, actual),
        accuracy=accuracy(probs, actual),
        auc=auc(probs, actual),
        ece=expected_calibration_error(probs, actual, n_bins=n_bins),
        max_calibration_error=reliability_curve(probs, actual, n_bins=n_bins).max_error,
        base_rate=float(np.mean(actual)) if actual.size else float("nan"),
        mean_predicted=float(np.mean(probs)) if probs.size else float("nan"),
        murphy=murphy_decomposition(probs, actual, n_bins=n_bins),
        curve=reliability_curve(probs, actual, n_bins=n_bins),
        brier_skill=brier_skill_score(probs, actual, reference) if reference is not None else None,
        reference=reference_name,
        buckets=probability_buckets(probs, actual),
    )
