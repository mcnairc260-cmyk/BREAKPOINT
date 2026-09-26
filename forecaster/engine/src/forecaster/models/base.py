"""What a model is, in this system.

Every model produces a **distribution over the future price**, not a probability
for one target. That single decision drives most of the architecture:

* The user's target is applied to the distribution afterwards, so one model
  serves every possible target and all the training data trains one thing.
* Raising the target can never raise the probability of clearing it, because the
  distribution is monotone by construction. A per-target classifier gives no such
  guarantee and would eventually print a self-contradicting pair of numbers.
* The median and the expected range come off the same object as the probability,
  so the product cannot say there is a 70% chance of finishing above a price that
  its own predicted range excludes.

`predict_distribution` is therefore the only method a model must implement.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from forecaster.features.window import MarketWindow
from forecaster.models.tails import PROB_FLOOR, ResidualShape
from forecaster.types import DataSource, FeatureVector


class InsufficientData(Exception):
    """Not enough history to forecast responsibly.

    Raised rather than returning a wide guess. A forecast made from ninety
    seconds of data is not a humble forecast, it is a fabricated one, and the
    product says so instead of printing it.
    """


@dataclass(frozen=True)
class ForecastDistribution:
    """The distribution of the price at `spot × exp(r)`, with `r ~ shape(mu, sigma)`.

    `sigma` is the standard deviation of the horizon log return and is where
    essentially all the information lives. `mu` is the expected log return and is
    normally zero: at five and twenty minutes, drift is not forecastable, and the
    honest default is to say so rather than to invent one.
    """

    spot: float
    horizon_s: int
    mu: float
    sigma: float
    shape: ResidualShape
    sigma_source: str
    """How sigma was arrived at, shown in the explanation panel."""

    def z_for(self, target: float) -> float:
        """Distance to the target in standard deviations.

        The single most important number in the product. A probability is far
        from 50% because the target is far away in volatility units — not because
        the model is confident about direction.
        """
        if target <= 0.0 or self.spot <= 0.0:
            raise ValueError("prices must be positive")
        if self.sigma <= 0.0:
            raise InsufficientData("volatility estimate is zero or negative")
        return (math.log(target / self.spot) - self.mu) / self.sigma

    def prob_above(self, target: float) -> float:
        """P(price at expiry > target). Strictly decreasing in `target`."""
        return self.shape.survival(self.z_for(target))

    def quantile(self, q: float) -> float:
        """The price at cumulative probability `q`."""
        return self.spot * math.exp(self.mu + self.sigma * self.shape.quantile(q))

    def median(self) -> float:
        return self.quantile(0.5)

    def interval(self, confidence: float) -> tuple[float, float]:
        """A central interval. `confidence=0.8` gives the 10th to 90th percentile."""
        tail = (1.0 - confidence) / 2.0
        return self.quantile(tail), self.quantile(1.0 - tail)

    def with_probability(self, p_above: float, target: float) -> ForecastDistribution:
        """Return a distribution whose probability at `target` is `p_above`.

        Used when a learner or a calibrator adjusts the probability: rather than
        letting the displayed range and the displayed probability come from two
        different places, the shift is absorbed into `mu`, so every number the
        user sees still comes from one coherent distribution.
        """
        clamped = min(max(p_above, PROB_FLOOR), 1.0 - PROB_FLOOR)
        target_z = self.shape.quantile(1.0 - clamped)
        implied_mu = math.log(target / self.spot) - target_z * self.sigma
        return ForecastDistribution(
            spot=self.spot,
            horizon_s=self.horizon_s,
            mu=implied_mu,
            sigma=self.sigma,
            shape=self.shape,
            sigma_source=self.sigma_source,
        )


@runtime_checkable
class Model(Protocol):
    """Anything that can forecast a distribution."""

    @property
    def version(self) -> str: ...

    @property
    def family(self) -> str: ...

    @property
    def train_source(self) -> DataSource | None:
        """Where the training data came from, or None for an untrained model.

        A model trained on simulated data must never present its output as a
        live-validated result, so this travels with every prediction it makes.
        """
        ...

    def predict_distribution(
        self, window: MarketWindow, horizon_s: int, features: FeatureVector | None = None
    ) -> ForecastDistribution: ...


def clamp_probability(p: float) -> float:
    return min(max(p, PROB_FLOOR), 1.0 - PROB_FLOOR)
