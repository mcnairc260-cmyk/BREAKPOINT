"""How much the system should trust its own number.

The temptation is to derive confidence from the probability — call 75% "high
confidence" and 55% "low". That would be wrong twice over. A well-calibrated 55%
is a perfectly good forecast, and a 75% produced from a stale feed and four
working features is not a good one. Probability and confidence answer different
questions: *how likely* versus *how much do we know*.

So confidence is computed from things that genuinely bear on reliability:

* how fresh the feed is
* how many features could actually be computed
* whether the order book is present and sane
* how far the current market sits from anything in the training data
* how much the baseline and the learner disagree
* whether the target is beyond the range where calibration has evidence

**Confidence never changes the probability.** A LOW-confidence 62% must still be
right 62% of the time. Shrinking it toward 50% would destroy calibration and,
because the shrinkage would vary with the target, would break the guarantee that
probability falls as the target rises. Confidence changes the label and the
warnings, and nothing else.

The thresholds are **provisional**. Making them empirical requires showing that
the three buckets have measurably different Brier scores, which needs live
outcomes that do not exist yet. Until then the system says they are provisional
rather than implying a calibration that has not happened, and the statistics page
reports whether the buckets actually separate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from forecaster.config import ConfidenceConfig
from forecaster.features.compute import MISSING, coverage
from forecaster.types import NS_PER_SECOND, Confidence, FeatureVector, ServiceLevel


@dataclass
class NoveltyModel:
    """How unusual current conditions are, against the training distribution.

    A Mahalanobis distance over the feature vector. This is the concrete form of
    the brief's "market conditions significantly outside historical training
    distributions" warning: a model asked about a market unlike anything it
    learned from is extrapolating, and the user should be told.

    Uses a diagonal covariance. The full matrix needs far more independent
    observations than this system will have for months, and a badly conditioned
    inverse produces wild distances that would trip the warning at random.
    """

    mean: np.ndarray | None = None
    std: np.ndarray | None = None
    feature_names: tuple[str, ...] = ()
    n_observations: int = 0

    @property
    def is_fitted(self) -> bool:
        return self.mean is not None and self.std is not None

    @classmethod
    def fit(cls, features: np.ndarray, feature_names: tuple[str, ...]) -> NoveltyModel:
        if features.size == 0:
            return cls()
        usable = np.where(features == MISSING, np.nan, features)
        mean = np.nanmean(usable, axis=0)
        std = np.nanstd(usable, axis=0)
        std = np.where(np.isfinite(std) & (std > 1e-9), std, 1.0)
        mean = np.where(np.isfinite(mean), mean, 0.0)
        return cls(
            mean=mean,
            std=std,
            feature_names=feature_names,
            n_observations=int(features.shape[0]),
        )

    def distance(self, vector: FeatureVector) -> float | None:
        """Root-mean-square standardised deviation. Roughly "how many sigmas
        unusual is today", averaged across features."""
        if not self.is_fitted or not self.feature_names:
            return None
        assert self.mean is not None and self.std is not None
        deviations: list[float] = []
        for i, name in enumerate(self.feature_names):
            value = vector.values.get(name, MISSING)
            if value == MISSING:
                continue
            deviations.append(((value - self.mean[i]) / self.std[i]) ** 2)
        if not deviations:
            return None
        return math.sqrt(sum(deviations) / len(deviations))

    def to_dict(self) -> dict[str, Any]:
        return {
            "mean": self.mean.tolist() if self.mean is not None else None,
            "std": self.std.tolist() if self.std is not None else None,
            "feature_names": list(self.feature_names),
            "n_observations": self.n_observations,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> NoveltyModel:
        mean = payload.get("mean")
        std = payload.get("std")
        return cls(
            mean=np.asarray(mean, dtype=float) if mean else None,
            std=np.asarray(std, dtype=float) if std else None,
            feature_names=tuple(payload.get("feature_names", ())),
            n_observations=int(payload.get("n_observations", 0)),
        )


@dataclass
class ConfidenceAssessment:
    """The verdict, plus every reason behind it."""

    level: Confidence
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]
    unusual_conditions: bool
    novelty: float | None
    feature_coverage: float
    feed_age_s: float | None
    disagreement: float | None
    beyond_calibrated_range: bool
    thresholds_are_provisional: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level.value,
            "reasons": list(self.reasons),
            "warnings": list(self.warnings),
            "unusual_conditions": self.unusual_conditions,
            "novelty": self.novelty,
            "feature_coverage": self.feature_coverage,
            "feed_age_s": self.feed_age_s,
            "disagreement": self.disagreement,
            "beyond_calibrated_range": self.beyond_calibrated_range,
            "thresholds_are_provisional": self.thresholds_are_provisional,
        }


def assess_confidence(
    *,
    features: FeatureVector,
    config: ConfidenceConfig,
    service_level: ServiceLevel,
    z: float,
    z_calibrated_max: float,
    feed_age_ns: int | None,
    novelty_model: NoveltyModel | None = None,
    baseline_p: float | None = None,
    model_p: float | None = None,
    is_calibrated: bool = False,
    history_ns: int = 0,
    min_history_ns: int = 0,
) -> ConfidenceAssessment:
    """Weigh everything that bears on reliability and return a label.

    Starts at HIGH and demotes. A forecast is trusted only when nothing argues
    against it, which is the right default for a product whose main risk is
    sounding more certain than it is.
    """
    reasons: list[str] = []
    warnings: list[str] = []
    level = Confidence.HIGH

    def demote(to: Confidence, reason: str) -> None:
        nonlocal level
        order = {Confidence.HIGH: 2, Confidence.MODERATE: 1, Confidence.LOW: 0}
        if order[to] < order[level]:
            level = to
        reasons.append(reason)

    # -- data quality --------------------------------------------------------

    cover = coverage(features)
    if cover < 0.5:
        demote(Confidence.LOW, f"only {cover:.0%} of signals could be computed")
    elif cover < 0.85:
        demote(Confidence.MODERATE, f"{cover:.0%} of signals available")

    feed_age_s = feed_age_ns / NS_PER_SECOND if feed_age_ns is not None else None
    if feed_age_s is None:
        demote(Confidence.LOW, "feed age unknown")
    elif feed_age_s > 30.0:
        demote(Confidence.LOW, f"market data is {feed_age_s:.0f}s old")
        warnings.append("STALE DATA")
    elif feed_age_s > 5.0:
        demote(Confidence.MODERATE, f"market data is {feed_age_s:.0f}s old")

    if service_level is ServiceLevel.DEGRADED:
        demote(Confidence.MODERATE, "running on the baseline model only")
    elif service_level in (ServiceLevel.STALE, ServiceLevel.DOWN):
        demote(Confidence.LOW, "market data feed is not healthy")

    if min_history_ns and history_ns < min_history_ns * 2:
        demote(
            Confidence.MODERATE,
            f"only {history_ns / NS_PER_SECOND / 60:.0f} minutes of history "
            "behind the volatility estimate",
        )

    # -- how far this is from what the model knows ---------------------------

    novelty = novelty_model.distance(features) if novelty_model else None
    unusual = False
    if novelty is not None:
        if novelty > config.novelty_high:
            demote(Confidence.LOW, f"market conditions {novelty:.1f} sigma from the training range")
            warnings.append("UNUSUAL MARKET CONDITIONS")
            unusual = True
        elif novelty > config.novelty_moderate:
            demote(Confidence.MODERATE, f"market conditions unusual ({novelty:.1f} sigma)")
            unusual = True

    # -- how far the target is ----------------------------------------------

    beyond = abs(z) > z_calibrated_max
    if beyond:
        demote(
            Confidence.LOW,
            f"target is {abs(z):.1f} standard deviations away, beyond the calibrated range",
        )
        warnings.append("BEYOND CALIBRATED RANGE")

    # -- do the models agree -------------------------------------------------

    disagreement = (
        abs(baseline_p - model_p) if baseline_p is not None and model_p is not None else None
    )
    if disagreement is not None:
        if disagreement > config.disagreement_high:
            demote(
                Confidence.LOW,
                f"baseline and learned model disagree by {disagreement:.0%}",
            )
        elif disagreement > config.disagreement_moderate:
            demote(Confidence.MODERATE, f"models disagree by {disagreement:.0%}")

    if not is_calibrated:
        demote(Confidence.MODERATE, "probabilities have not been calibrated against outcomes yet")

    if not reasons:
        reasons.append("feed healthy, all signals available, conditions within the training range")

    return ConfidenceAssessment(
        level=level,
        reasons=tuple(reasons),
        warnings=tuple(warnings),
        unusual_conditions=unusual,
        novelty=novelty,
        feature_coverage=cover,
        feed_age_s=feed_age_s,
        disagreement=disagreement,
        beyond_calibrated_range=beyond,
    )
