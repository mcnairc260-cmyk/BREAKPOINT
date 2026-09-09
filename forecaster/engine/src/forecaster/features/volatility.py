"""Volatility estimation.

At a five- or twenty-minute horizon, volatility is essentially the whole answer.
Direction is not forecastable at retail latency; the *width* of the distribution
very much is, and it is what turns "the price might be anywhere" into a usable
probability. So this module gets the most care in the codebase.

Everything is expressed as **variance per second**, which composes trivially
across horizons (`var_h = var_per_second × h`) and keeps a single unit through
the whole system. Annualised figures appear only where a human reads them.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING

from forecaster.types import Bar

if TYPE_CHECKING:
    from forecaster.types import Quote

SECONDS_PER_YEAR = 365.0 * 24.0 * 3600.0

# Below this many observations a variance estimate is noise wearing a number's
# clothing. Callers fall back to a longer window rather than publish it.
MIN_OBSERVATIONS = 12


def log_returns(bars: tuple[Bar, ...] | list[Bar]) -> list[float]:
    out: list[float] = []
    for previous, current in pairwise(bars):
        if previous.close > 0.0 and current.close > 0.0:
            out.append(math.log(current.close / previous.close))
    return out


def realized_variance_per_second(returns: list[float], interval_s: float) -> float | None:
    """Realized variance, normalised to one second.

    Not de-meaned. Over seconds and minutes the sample mean is pure noise, and
    subtracting it removes real variance while adding estimation error. The zero-
    drift assumption is deliberate and is the same one the baseline model makes.
    """
    if len(returns) < MIN_OBSERVATIONS or interval_s <= 0.0:
        return None
    total = sum(r * r for r in returns)
    return total / (len(returns) * interval_s)


def noise_corrected_variance_per_second(
    returns: list[float], interval_s: float, *, floor_fraction: float = 0.25
) -> float | None:
    """Realized variance with microstructure noise removed.

    **This correction matters more than any model in the project.** Without it,
    volatility measured from one-second trade prices comes out roughly 1.7 times
    too large — measured, on data where the true value is known.

    The cause is bid-ask bounce. A traded price is not the "true" price; it is
    the true price plus or minus roughly half the spread, depending on whether
    the trade hit the bid or lifted the offer. Consecutive one-second closes
    therefore bounce across the spread even when nothing has moved, and every one
    of those bounces is counted as volatility.

    The consequence for this product is direct and bad: an inflated volatility
    estimate makes every target look closer in standard deviations than it is,
    so every probability is dragged toward 50%. The system would be
    systematically under-confident, and calibrated on nothing.

    The fix is the first-order autocovariance correction (Zhou; Hansen and
    Lunde). Bounce induces *negative* first-order autocorrelation in returns —
    an up-tick from hitting the offer tends to be followed by a down-tick from
    hitting the bid — while genuine price moves do not. Adding twice the first
    autocovariance therefore removes the noise and leaves the signal:

        corrected  =  sum(r_t^2)  +  2 * sum(r_t * r_{t+1})

    This is standard econometrics, not a fit to this project's simulator. The
    simulator revealed the bias; the correction comes from the literature and
    applies to real trade data for the same reason.

    Floored at `floor_fraction` of the raw estimate, because on a very quiet
    stretch the correction can overshoot into negative territory, and a negative
    variance is worse than a biased one.
    """
    if len(returns) < MIN_OBSERVATIONS + 1 or interval_s <= 0.0:
        return None
    squares = sum(r * r for r in returns)
    autocovariance = sum(a * b for a, b in pairwise(returns))
    corrected = squares + 2.0 * autocovariance
    floor = floor_fraction * squares
    return max(corrected, floor) / (len(returns) * interval_s)


def bipower_variation_per_second(returns: list[float], interval_s: float) -> float | None:
    """Variance with jumps removed.

    Products of adjacent absolute returns: a single large jump contaminates only
    two terms rather than dominating the sum. The ratio of this to realized
    variance says how much of recent movement was jumps.

    That distinction matters commercially, not just academically. Continuous
    volatility persists and is forecastable; jump volatility does not. A model
    that cannot tell them apart will keep predicting wide ranges for the twenty
    minutes after a one-off spike, which is precisely when it should not.
    """
    if len(returns) < MIN_OBSERVATIONS + 1 or interval_s <= 0.0:
        return None
    mu1 = math.sqrt(2.0 / math.pi)
    total = sum(abs(a) * abs(b) for a, b in pairwise(returns))
    scaled = total / (mu1**2)
    return scaled / (len(returns) - 1) / interval_s


def semivariance_ratio(returns: list[float]) -> float | None:
    """Share of variance coming from downward moves, in [0, 1].

    0.5 is symmetric. Persistently above it means downside moves are doing more
    of the work, which shifts the shape of the distribution and therefore the
    probability of clearing a target above the current price.
    """
    if len(returns) < MIN_OBSERVATIONS:
        return None
    down = sum(r * r for r in returns if r < 0.0)
    total = sum(r * r for r in returns)
    if total <= 0.0:
        return None
    return down / total


@dataclass(frozen=True)
class EwmaVariance:
    """Exponentially weighted variance, in per-second units.

    Two decay rates, deliberately. A fast estimator reacts to a volatility burst
    within seconds; a slow one is stable enough to forecast twenty minutes ahead.
    Neither alone is right for both horizons, and averaging them is how the
    baseline gets a usable number for each.
    """

    lambda_: float
    value: float | None = None

    def update(self, ret: float, interval_s: float) -> EwmaVariance:
        if interval_s <= 0.0:
            return self
        observation = (ret * ret) / interval_s
        if self.value is None:
            return EwmaVariance(self.lambda_, observation)
        blended = self.lambda_ * self.value + (1.0 - self.lambda_) * observation
        return EwmaVariance(self.lambda_, blended)

    @classmethod
    def from_returns(cls, lambda_: float, returns: list[float], interval_s: float) -> EwmaVariance:
        state = cls(lambda_)
        for ret in returns:
            state = state.update(ret, interval_s)
        return state


def har_forecast_per_second(
    rv_short: float | None, rv_medium: float | None, rv_long: float | None
) -> float | None:
    """Combine volatility measured over several windows into one forecast.

    A heterogeneous-autoregressive blend. The idea, which is well supported in
    the volatility literature and cheap to implement, is that today's volatility
    depends on activity at several time scales at once, and that a mix of short,
    medium and long windows forecasts better than any single one.

    The weights here are **fixed defaults, not fitted**, because fitting them on
    simulated data would be fitting the simulator. They are refit from real data
    by the training pipeline once a real capture exists, and `MODEL.md` says
    which state the shipped artifact is in.
    """
    parts = [(0.5, rv_short), (0.3, rv_medium), (0.2, rv_long)]
    available = [(w, v) for w, v in parts if v is not None and v > 0.0]
    if not available:
        return None
    total_weight = sum(w for w, _ in available)
    return sum(w * v for w, v in available) / total_weight


def to_annual(variance_per_second: float) -> float:
    return math.sqrt(max(variance_per_second, 0.0) * SECONDS_PER_YEAR)


def horizon_sigma(variance_per_second: float, horizon_s: int) -> float:
    """Standard deviation of the log return over the horizon.

    Square-root-of-time scaling. It assumes returns are roughly uncorrelated
    across the horizon, which is close to true at these scales and is the same
    assumption that makes zero drift the right null. Where it breaks — during a
    trending liquidation cascade — the volatility estimate is already rising, so
    the error is in the safe direction.
    """
    return math.sqrt(max(variance_per_second, 0.0) * horizon_s)


def mid_quote_returns(quotes: Iterable[Quote], floor_ns: int, as_of_ns: int) -> list[float]:
    """Log returns of the quote midpoint, one per second.

    A midpoint sits between the bid and the offer, so it does not jump when a
    trade happens to hit one side rather than the other. That makes it a far
    cleaner input to a volatility estimator than traded prices — most of the
    bias corrected for elsewhere in this module simply is not present.

    Sampled to at most one observation per second: sampling faster adds almost no
    information about volatility and a great deal of noise about quoting.
    """
    import math

    seen: dict[int, float] = {}
    for quote in quotes:
        if quote.received_ns < floor_ns or quote.received_ns > as_of_ns:
            continue
        mid = quote.mid
        if mid <= 0.0:
            continue
        seen[quote.received_ns // 1_000_000_000] = mid
    if len(seen) < 2:
        return []
    ordered = [seen[key] for key in sorted(seen)]
    return [
        math.log(later / earlier)
        for earlier, later in pairwise(ordered)
        if earlier > 0.0 and later > 0.0
    ]
