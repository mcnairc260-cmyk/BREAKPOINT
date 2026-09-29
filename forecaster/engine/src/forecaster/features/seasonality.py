"""Time-of-week volatility patterns.

Crypto trades continuously, but not evenly. Volume and volatility follow a
stable weekly shape driven by when humans in the major financial centres are
awake, and by scheduled events — US equity open, futures settlement, funding
intervals.

This matters more than it sounds. If Sunday 04:00 UTC is reliably a third as
volatile as Wednesday 14:00 UTC, then feeding raw realized volatility to a model
makes it spend its capacity rediscovering the clock. Dividing it out first is
close to free and leaves the model to learn the part that is actually about the
market.

The factors ship as **flat ones** and are estimated from real captured data by
the training pipeline. Shipping invented factors would be shipping a fabricated
empirical result, so the default is explicitly the assumption of no seasonality,
and `is_fitted` says which state the running system is in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from forecaster.clock import to_datetime

HOURS_PER_WEEK = 168


def _as_int(value: object) -> int:
    """A stored count, tolerating whatever JSON round-tripping produced."""
    return int(value) if isinstance(value, (int, float, str)) else 0


@dataclass
class WeeklySeasonality:
    """A multiplicative volatility factor for each hour of the week.

    1.0 means "an average hour". 1.4 means volatility here typically runs 40%
    above average.
    """

    factors: list[float] = field(default_factory=lambda: [1.0] * HOURS_PER_WEEK)
    is_fitted: bool = False
    n_observations: int = 0

    def bucket(self, ns: int) -> int:
        moment = to_datetime(ns)
        return (moment.weekday() * 24 + moment.hour) % HOURS_PER_WEEK

    def factor(self, ns: int) -> float:
        return self.factors[self.bucket(ns)]

    def deseasonalize(self, variance_per_second: float, ns: int) -> float:
        """Remove the typical pattern, leaving what is unusual about right now."""
        f = self.factor(ns)
        return variance_per_second / (f * f) if f > 0.0 else variance_per_second

    @classmethod
    def fit(
        cls, observations: list[tuple[int, float]], *, min_per_bucket: int = 8
    ) -> WeeklySeasonality:
        """Estimate factors from (timestamp, variance-per-second) pairs.

        Buckets with too few observations keep a factor of 1.0 rather than
        adopting a number derived from three data points. A seasonal adjustment
        estimated from noise is worse than none, because it looks like knowledge.
        """
        sums: list[float] = [0.0] * HOURS_PER_WEEK
        counts: list[int] = [0] * HOURS_PER_WEEK
        template = cls()
        for ns, variance in observations:
            if variance <= 0.0:
                continue
            index = template.bucket(ns)
            sums[index] += math.log(variance)
            counts[index] += 1

        usable = [i for i in range(HOURS_PER_WEEK) if counts[i] >= min_per_bucket]
        if not usable:
            return cls(is_fitted=False, n_observations=len(observations))

        grand_mean = sum(sums[i] for i in usable) / sum(counts[i] for i in usable)
        factors = [1.0] * HOURS_PER_WEEK
        for i in usable:
            mean_log_variance = sums[i] / counts[i]
            # Variance ratio to a volatility ratio: sqrt of the exponentiated
            # difference of log variances.
            factors[i] = math.exp(0.5 * (mean_log_variance - grand_mean))
            factors[i] = min(3.0, max(0.33, factors[i]))
        return cls(factors=factors, is_fitted=True, n_observations=len(observations))

    def to_dict(self) -> dict[str, object]:
        return {
            "factors": self.factors,
            "is_fitted": self.is_fitted,
            "n_observations": self.n_observations,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> WeeklySeasonality:
        factors = payload.get("factors")
        if not isinstance(factors, list) or len(factors) != HOURS_PER_WEEK:
            return cls()
        return cls(
            factors=[float(f) for f in factors],
            is_fitted=bool(payload.get("is_fitted", False)),
            n_observations=_as_int(payload.get("n_observations")),
        )
