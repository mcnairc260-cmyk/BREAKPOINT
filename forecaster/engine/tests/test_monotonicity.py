"""The probability must never rise as the target rises.

This is the single most important property in the product. If P(above $80,000)
ever came out higher than P(above $79,000), the system would be visibly
self-contradicting, and every number it produces would rightly be doubted.

It is tested on the **fully served output** — after the model, after any learned
correction, after calibration, after the distribution is re-centred, and after
display rounding. Testing the raw model would prove nothing about what a user
actually sees, and every one of those stages is a place the ordering could break.
"""

from __future__ import annotations

import math
from itertools import pairwise

import numpy as np
import pytest

from forecaster.calibration import (
    BetaCalibrator,
    IdentityCalibrator,
    IsotonicCalibrator,
    TemperatureCalibrator,
)
from forecaster.config import Config
from forecaster.models.base import ForecastDistribution
from forecaster.models.tails import ResidualShape
from forecaster.service.engine import ForecastEngine
from forecaster.types import PROB_FLOOR, ServiceLevel

# Targets spanning six standard deviations either side of spot, which covers
# every question a user could sensibly ask and a good many they could not.
Z_GRID = np.linspace(-6.0, 6.0, 241)


def distribution(sigma: float = 0.0017, shape: ResidualShape | None = None) -> ForecastDistribution:
    return ForecastDistribution(
        spot=79_434.27,
        horizon_s=300,
        mu=0.0,
        sigma=sigma,
        shape=shape or ResidualShape(),
        sigma_source="test",
    )


class TestDistributionOrdering:
    def test_probability_falls_as_the_target_rises(self) -> None:
        dist = distribution()
        targets = [dist.spot * math.exp(z * dist.sigma) for z in Z_GRID]
        probabilities = [dist.prob_above(t) for t in targets]
        assert all(a >= b for a, b in pairwise(probabilities))

    def test_it_holds_for_an_empirical_shape_too(self) -> None:
        rng = np.random.default_rng(3)
        residuals = rng.standard_t(df=4, size=40_000)
        shape = ResidualShape.fit(residuals / residuals.std())
        assert shape.is_empirical
        dist = distribution(shape=shape)
        targets = [dist.spot * math.exp(z * dist.sigma) for z in Z_GRID]
        probabilities = [dist.prob_above(t) for t in targets]
        assert all(a >= b for a, b in pairwise(probabilities))

    def test_probabilities_never_reach_zero_or_one(self) -> None:
        """Certainty is never claimed, however far away the target is."""
        dist = distribution()
        for z in (-40.0, -12.0, 12.0, 40.0):
            p = dist.prob_above(dist.spot * math.exp(z * dist.sigma))
            assert PROB_FLOOR <= p <= 1.0 - PROB_FLOOR

    def test_the_range_contains_the_median(self) -> None:
        dist = distribution()
        low, high = dist.interval(0.8)
        assert low < dist.median() < high

    def test_a_wider_interval_contains_a_narrower_one(self) -> None:
        dist = distribution()
        narrow = dist.interval(0.5)
        wide = dist.interval(0.95)
        assert wide[0] <= narrow[0] and wide[1] >= narrow[1]

    def test_the_range_agrees_with_the_probability(self) -> None:
        """The 90th percentile price must have about a 10% chance of being beaten.

        This is the check that the range and the probability come from one
        object rather than two, which is what stops the product claiming a 70%
        chance of finishing above a price outside its own predicted range.
        """
        dist = distribution()
        assert dist.prob_above(dist.quantile(0.9)) == pytest.approx(0.1, abs=1e-6)
        assert dist.prob_above(dist.quantile(0.5)) == pytest.approx(0.5, abs=1e-6)


class TestCalibrationPreservesOrdering:
    """Every calibrator must be strictly increasing in the probability.

    Composed with a distribution that is decreasing in the target, that is what
    keeps the ordering guarantee alive after calibration. A calibrator that read
    the target instead of only the probability would break it — which is why the
    calibration layer is forbidden from seeing anything else.
    """

    @pytest.mark.parametrize(
        "calibrator",
        [
            IdentityCalibrator(),
            TemperatureCalibrator(temperature=1.8),
            TemperatureCalibrator(temperature=0.6),
            BetaCalibrator(a=1.3, b=-0.2),
            BetaCalibrator(a=0.4, b=0.5),
        ],
    )
    def test_strictly_increasing(self, calibrator: object) -> None:
        grid = np.linspace(0.001, 0.999, 2_000)
        out = calibrator.transform_array(grid)  # type: ignore[attr-defined]
        assert np.all(np.diff(out) > 0), f"{calibrator.name} is not strictly increasing"  # type: ignore[attr-defined]

    def test_isotonic_is_smoothed_so_it_never_flattens(self) -> None:
        """Raw isotonic returns the same value across wide input ranges.

        That shows up as a target price the user can drag without the number
        moving, which reads as a broken product. The interpolated form keeps a
        small slope so distinct inputs always give distinct outputs.
        """
        rng = np.random.default_rng(11)
        p = rng.uniform(0.05, 0.95, 5_000)
        y = (rng.uniform(size=5_000) < p).astype(float)
        calibrator = IsotonicCalibrator.fit(p, y)
        grid = np.linspace(0.001, 0.999, 2_000)
        out = calibrator.transform_array(grid)
        assert np.all(np.diff(out) > 0)

    def test_the_composition_is_still_decreasing_in_the_target(self) -> None:
        dist = distribution()
        calibrator = BetaCalibrator(a=1.4, b=-0.35)
        targets = [dist.spot * math.exp(z * dist.sigma) for z in Z_GRID]
        probabilities = [calibrator.transform(dist.prob_above(t)) for t in targets]
        assert all(a >= b for a, b in pairwise(probabilities))


class TestServedOutputOrdering:
    """The end-to-end check, through the real engine."""

    def test_full_engine_output_is_ordered_and_coherent(self, collected, config: Config) -> None:
        from forecaster.types import NS_PER_SECOND

        engine = ForecastEngine(config=config)
        as_of = 90 * 60 * NS_PER_SECOND
        window = collected.window("BTC-USD", as_of)
        spot = window.spot
        assert spot is not None

        probe = engine.forecast(
            window=window,
            target=spot,
            horizon_s=300,
            service_level=ServiceLevel.FULL,
            feed_age_ns=0,
            now_ns=as_of,
        )
        results = []
        for z in np.linspace(-5.0, 5.0, 121):
            target = round(spot * math.exp(z * probe.sigma), 2)
            forecast = engine.forecast(
                window=window,
                target=target,
                horizon_s=300,
                service_level=ServiceLevel.FULL,
                feed_age_ns=0,
                now_ns=as_of,
            )
            results.append((target, forecast))

        # Rounded to two decimals, distinct targets can collide; compare only
        # strictly increasing target prices.
        for (t1, f1), (t2, f2) in pairwise(results):
            if t2 > t1:
                assert f2.p_above <= f1.p_above + 1e-12, (
                    f"raising the target from {t1} to {t2} raised the probability "
                    f"from {f1.p_above} to {f2.p_above}"
                )

        for _, forecast in results:
            # Above and below are one subtraction apart, never two model calls.
            assert forecast.p_above + forecast.p_below == pytest.approx(1.0, abs=1e-12)
            assert 0.0 < forecast.p_above < 1.0
            assert forecast.range_low < forecast.range_high
