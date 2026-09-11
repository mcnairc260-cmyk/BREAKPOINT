"""The five statements that must be true of any honest distributional forecast.

Section 9 of the brief asks for these as automated invariants rather than as
things a person eyeballs once. That is the right instinct: each of them is
obvious, each of them would be violated silently by a plausible bug, and none of
them would make a test suite fail unless somebody wrote the test.

They are properties of the *baseline*, which is what serves every live forecast
today. They are asserted on the model directly rather than through the HTTP
layer, so a failure points at the mathematics rather than at the plumbing.
"""

from __future__ import annotations

import math

import pytest

from forecaster.models.base import ForecastDistribution
from forecaster.models.tails import ResidualShape

HORIZONS = (300, 1200)
SPOT = 79_434.21


def distribution(
    sigma: float, *, mu: float = 0.0, horizon_s: int = 300
) -> ForecastDistribution:
    """A baseline-shaped distribution at a given horizon volatility.

    Student-t tails with four degrees of freedom: the shipped default until
    enough real residuals exist to fit an empirical body, which is a decision
    recorded in `ModelConfig`, not one made here.
    """
    return ForecastDistribution(
        spot=SPOT,
        horizon_s=horizon_s,
        mu=mu,
        sigma=sigma,
        shape=ResidualShape(student_t_df=4.0, source="student_t"),
        sigma_source="test fixture",
    )


@pytest.mark.parametrize("horizon_s", HORIZONS)
def test_target_at_the_money_is_near_a_coin_flip(horizon_s: int) -> None:
    """A target at today's price, with no drift, is a coin flip. Anything else is a claim.

    This is the invariant that catches an accidental drift term. A model that
    quietly learned a positive mean return would put this at 55% or 60% and look
    impressive, which is exactly how a short-horizon forecaster fools its author.
    """
    sigma = 0.0015 * math.sqrt(horizon_s / 300.0)
    p = distribution(sigma, horizon_s=horizon_s).prob_above(SPOT)
    assert 0.45 <= p <= 0.55, f"at-the-money probability {p:.4f} implies a drift claim"


@pytest.mark.parametrize("horizon_s", HORIZONS)
def test_a_higher_target_is_always_less_likely_to_be_exceeded(horizon_s: int) -> None:
    """The product's central guarantee, checked across the whole useful range."""
    sigma = 0.0015 * math.sqrt(horizon_s / 300.0)
    dist = distribution(sigma, horizon_s=horizon_s)
    targets = [SPOT * math.exp(z * sigma) for z in [x / 4.0 for x in range(-16, 17)]]
    probs = [dist.prob_above(t) for t in targets]
    for lower, higher in zip(probs, probs[1:], strict=False):
        assert higher <= lower + 1e-12, "raising the target raised P(above)"
    assert probs[0] > probs[-1], "the curve is flat: raising the target changed nothing"


@pytest.mark.parametrize("horizon_s", HORIZONS)
def test_a_lower_target_is_always_more_likely_to_be_exceeded(horizon_s: int) -> None:
    """The same statement from the other side, because the brief asks for both."""
    sigma = 0.0015 * math.sqrt(horizon_s / 300.0)
    dist = distribution(sigma, horizon_s=horizon_s)
    at_money = dist.prob_above(SPOT)
    for z in (0.25, 1.0, 2.5):
        below = dist.prob_above(SPOT * math.exp(-z * sigma))
        above = dist.prob_above(SPOT * math.exp(z * sigma))
        assert below > at_money > above


def test_rising_volatility_widens_the_distribution() -> None:
    """More uncertainty must mean a wider interval, never a narrower one."""
    previous_width = 0.0
    for sigma in (0.0005, 0.001, 0.002, 0.005, 0.01):
        low, high = distribution(sigma).interval(0.80)
        width = high - low
        assert width > previous_width, f"sigma {sigma} did not widen the interval"
        previous_width = width
        assert low < SPOT < high, "the interval does not contain the current price"


def test_rising_volatility_pulls_extreme_probabilities_toward_a_coin_flip() -> None:
    """A fixed target gets less certain as the market gets wilder.

    The subtle one, and the one a bug is most likely to invert. If volatility
    rises and a far-out target's probability moves *away* from 50%, the model is
    saying a more chaotic market makes it more certain — which is backwards, and
    would show up in production as suspiciously confident forecasts during
    exactly the conditions where confidence is least warranted.
    """
    for direction in (1.0, -1.0):
        # A target fixed in dollars, then volatility raised underneath it.
        target = SPOT * math.exp(direction * 0.005)
        gaps = []
        for sigma in (0.0005, 0.001, 0.002, 0.004, 0.008):
            p = distribution(sigma).prob_above(target)
            gaps.append(abs(p - 0.5))
        for wider, narrower in zip(gaps, gaps[1:], strict=False):
            assert narrower <= wider + 1e-9, (
                "higher volatility moved a fixed target away from 50%"
            )
        assert gaps[-1] < gaps[0], "volatility had no effect on the probability"


def test_probabilities_stay_strictly_inside_zero_and_one() -> None:
    """No forecast may ever be a certainty, however far the target is."""
    dist = distribution(0.0015)
    for z in (-50.0, -12.0, 0.0, 12.0, 50.0):
        p = dist.prob_above(SPOT * math.exp(z * 0.0015))
        assert 0.0 < p < 1.0, f"z={z} produced {p}, which claims certainty"


def test_the_median_of_a_driftless_distribution_is_the_current_price() -> None:
    """Zero drift means the best guess is 'where it is now'. Anything else is a forecast."""
    for sigma in (0.0005, 0.0015, 0.005):
        assert distribution(sigma).median() == pytest.approx(SPOT, rel=1e-6)
