"""The baseline model: volatility, zero drift, and honest tails.

This is the model that ships on day one and serves every live forecast until a
learner has genuinely earned the right to replace it. It is not a placeholder.
At a five-minute horizon a well-estimated volatility with a correct tail shape is
a strong forecaster, and beating it is hard for a reason: there is very little
directional information in short-horizon crypto prices to find.

The construction, in three steps:

1. **Estimate volatility.** Realized variance over one minute, five minutes and
   one hour, blended in the manner of a heterogeneous-autoregressive model, with
   an exponentially weighted estimate mixed in for responsiveness. Divided by the
   time-of-week seasonal factor when one has been fitted from real data.
2. **Scale it to the horizon** by the square root of time.
3. **Apply the shape** — empirical residuals with generalised Pareto tails once
   enough exist, Student-t before that.

Drift is zero. Not "small", not "estimated and usually near zero" — exactly zero.
That is the honest null at these horizons, and it means every probability the
baseline produces comes from the distance to the target measured in volatility
units. Nothing else. A user asking for a target $26 away on a $79,000 asset gets
roughly 42% at five minutes, and no amount of model sophistication should move
that far, because there is nothing there to know.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from forecaster.config import ModelConfig
from forecaster.features.seasonality import WeeklySeasonality
from forecaster.features.volatility import (
    MIN_OBSERVATIONS,
    EwmaVariance,
    har_forecast_per_second,
    horizon_sigma,
    log_returns,
    mid_quote_returns,
    noise_corrected_variance_per_second,
    realized_variance_per_second,
)
from forecaster.features.window import MarketWindow
from forecaster.models.base import ForecastDistribution, InsufficientData
from forecaster.models.tails import ResidualShape
from forecaster.types import NS_PER_SECOND, DataSource, FeatureVector

BASELINE_FAMILY = "baseline-t"

# A five-minute forecast needs enough history for the one-hour volatility
# component to mean something. Thirty minutes is the floor; below it the model
# refuses rather than extrapolating from a handful of bars.
MIN_HISTORY_NS = 30 * 60 * NS_PER_SECOND


@dataclass
class BaselineModel:
    """Volatility-driven, zero-drift, fat-tailed.

    Untrained by default and fully functional in that state — which is the point.
    `fit_shape` and `fit_seasonality` sharpen it from real data when real data
    exists, without either being required for it to work.
    """

    config: ModelConfig = field(default_factory=ModelConfig)
    shape: ResidualShape = field(default_factory=ResidualShape)
    seasonality: WeeklySeasonality = field(default_factory=WeeklySeasonality)
    train_data_source: DataSource | None = None
    trained_ns: int | None = None
    version_suffix: str = "untrained"

    @property
    def family(self) -> str:
        return BASELINE_FAMILY

    @property
    def version(self) -> str:
        return f"{BASELINE_FAMILY}@{self.version_suffix}"

    @property
    def train_source(self) -> DataSource | None:
        return self.train_data_source

    @property
    def is_trained(self) -> bool:
        return self.shape.is_empirical or self.seasonality.is_fitted

    # -- volatility ----------------------------------------------------------

    def variance_per_second(self, window: MarketWindow) -> tuple[float, str]:
        """Blend the volatility estimates into one number, and say which won.

        Returns variance per second plus a short description of where it came
        from, because "why is the range this wide" is the second question every
        user asks after seeing a probability.
        """
        if window.history_ns < MIN_HISTORY_NS:
            raise InsufficientData(
                f"only {window.history_ns / NS_PER_SECOND:.0f}s of history; "
                f"{MIN_HISTORY_NS / NS_PER_SECOND:.0f}s required"
            )

        def rv(seconds: int) -> float | None:
            """Realized variance over a trailing window, corrected for noise.

            Mid-quote returns are preferred where enough quotes exist, because a
            mid does not bounce across the spread at all. Trade prices are the
            fallback, and get the autocovariance correction — which they need
            badly: uncorrected, they overstate volatility by about 70%.
            """
            floor_ns = window.as_of_ns - seconds * NS_PER_SECOND
            mids = mid_quote_returns(window.quotes, floor_ns, window.as_of_ns)
            if len(mids) >= max(MIN_OBSERVATIONS, seconds // 4):
                # No autocovariance correction here. The correction exists to
                # remove bid-ask bounce, and a midpoint does not bounce —
                # applying it anyway would strip out real price movement and
                # leave the estimate too low.
                return realized_variance_per_second(mids, 1.0)
            bars = [b for b in window.bars_1s if b.open_ns >= floor_ns]
            return noise_corrected_variance_per_second(log_returns(bars), 1.0)

        rv_1m, rv_5m, rv_60m = rv(60), rv(300), rv(3600)
        har = har_forecast_per_second(rv_1m, rv_5m, rv_60m)

        recent_floor = window.as_of_ns - 900 * NS_PER_SECOND
        recent = mid_quote_returns(window.quotes, recent_floor, window.as_of_ns) or log_returns(
            [b for b in window.bars_1s if b.open_ns >= recent_floor]
        )
        ewma = EwmaVariance.from_returns(self.config.ewma_lambda_slow, recent, 1.0).value

        candidates = [v for v in (har, ewma) if v is not None and v > 0.0]
        if not candidates:
            raise InsufficientData("no usable volatility estimate from the available bars")

        # Averaged rather than either alone: the HAR blend is steadier, the EWMA
        # reacts faster, and at these horizons both errors are costly in
        # different directions.
        blended = sum(candidates) / len(candidates)
        source = "HAR + EWMA" if len(candidates) == 2 else ("HAR" if har else "EWMA")

        if self.seasonality.is_fitted:
            blended = self.seasonality.deseasonalize(blended, window.as_of_ns)
            factor = self.seasonality.factor(window.as_of_ns)
            blended *= factor * factor
            source += " (seasonally adjusted)"

        return blended, source

    # -- the forecast --------------------------------------------------------

    def predict_distribution(
        self, window: MarketWindow, horizon_s: int, features: FeatureVector | None = None
    ) -> ForecastDistribution:
        spot = window.spot
        if spot is None or spot <= 0.0:
            raise InsufficientData("no traded price available")
        variance, source = self.variance_per_second(window)
        sigma = horizon_sigma(variance, horizon_s)
        if sigma <= 0.0:
            raise InsufficientData("volatility estimate collapsed to zero")
        return ForecastDistribution(
            spot=spot,
            horizon_s=horizon_s,
            mu=0.0,  # deliberate: see the module docstring
            sigma=sigma,
            shape=self.shape,
            sigma_source=source,
        )

    # -- training ------------------------------------------------------------

    def fit_shape(self, residuals: list[float] | object, *, source: DataSource, at_ns: int) -> None:
        """Fit the residual shape from realised standardised returns."""
        import numpy as np

        array = np.asarray(residuals, dtype=float)
        self.shape = ResidualShape.fit(
            array,
            student_t_df=self.config.student_t_df,
            tail_quantile=self.config.gpd_tail_quantile,
        )
        self.train_data_source = source
        self.trained_ns = at_ns
        self._refresh_version(source, at_ns)

    def fit_seasonality(
        self, observations: list[tuple[int, float]], *, source: DataSource, at_ns: int
    ) -> None:
        self.seasonality = WeeklySeasonality.fit(observations)
        self.train_data_source = source
        self.trained_ns = at_ns
        self._refresh_version(source, at_ns)

    def _refresh_version(self, source: DataSource, at_ns: int) -> None:
        from forecaster.clock import to_datetime

        stamp = to_datetime(at_ns).strftime("%Y%m%dT%H%M")
        # The data source is part of the version string, not a footnote. A model
        # trained on the simulator carries `.sim.` in its name everywhere it is
        # written down, so a simulated result can never be quietly reported as a
        # live one.
        tag = {"live": "live", "replay": "replay", "simulated": "sim"}[source.value]
        self.version_suffix = f"{stamp}.{tag}"

    def describe(self) -> dict[str, object]:
        return {
            "family": self.family,
            "version": self.version,
            "shape": self.shape.source,
            "shape_residuals": self.shape.n_residuals,
            "seasonality_fitted": self.seasonality.is_fitted,
            "train_data_source": self.train_data_source.value if self.train_data_source else None,
            "drift": "zero by design",
        }


def standardized_residual(spot: float, future_price: float, sigma: float) -> float:
    """The quantity the shape is fitted on."""
    if sigma <= 0.0 or spot <= 0.0 or future_price <= 0.0:
        raise ValueError("residual needs positive prices and volatility")
    return math.log(future_price / spot) / sigma
