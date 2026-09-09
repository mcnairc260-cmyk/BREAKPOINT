"""What actually happened, decided by one rule applied everywhere.

The rule, stated once and never varied:

    ABOVE  if  evaluation_price >  target
    BELOW  if  evaluation_price <= target

Equality resolves to BELOW. Any consistent choice works; an inconsistent one
does not, and equality is not rare — users pick round numbers and prices pin to
round numbers, so exact ties happen far more often than a continuous model of
prices would suggest. Ties are counted and reported so that if the rate ever
becomes material, the choice can be revisited with evidence.

The evaluation price is the last trade at or before `eval_at_ns`, taken from the
**recorded feed**, never re-queried from the venue. Re-querying would make a
resolved outcome depend on when the resolver happened to run, and a history that
changes depending on when you look at it is not a history.

Staleness is graded rather than binary:

* fresh — resolves normally.
* stale but inside the tolerated bound — resolves, and is flagged. A thirty-
  second-old print is a perfectly good answer to "where was the price twenty
  minutes after the forecast".
* nothing inside the bound — VOID.

VOID is not neutral. Feeds drop when markets move, so voided forecasts are
disproportionately the volatile ones, and quietly excluding them flatters the
accuracy figure exactly where it should not. The void rate is therefore reported
per volatility decile, and accuracy is also reported under the assumptions that
every void was a loss and that every void was a win. The truth is between those
bounds, and showing both is the honest way to say so.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from forecaster.types import Outcome, Trade

RESOLVER_VERSION = "resolver-1"


def label_from_price(price: float, target: float) -> bool:
    """True means ABOVE. The single definition; everything else calls this."""
    return price > target


@dataclass(frozen=True)
class Resolution:
    """The result of trying to score one prediction."""

    outcome: Outcome
    eval_price: float | None
    eval_price_ns: int | None
    staleness_ns: int | None
    tie: bool
    correct: bool | None
    brier: float | None
    log_loss: float | None

    @property
    def is_scored(self) -> bool:
        return self.outcome.is_resolved


def resolve_outcome(
    *,
    p_above: float,
    target: float,
    eval_at_ns: int,
    last_trade: Trade | None,
    fresh_bound_ns: int,
    max_bound_ns: int,
    feed_had_gap: bool = False,
) -> Resolution:
    """Score one prediction against the recorded feed."""
    if last_trade is None:
        return Resolution(
            outcome=Outcome.VOID_GAP,
            eval_price=None,
            eval_price_ns=None,
            staleness_ns=None,
            tie=False,
            correct=None,
            brier=None,
            log_loss=None,
        )

    staleness_ns = eval_at_ns - last_trade.exchange_ns
    if staleness_ns > max_bound_ns:
        return Resolution(
            outcome=Outcome.VOID_HALT if feed_had_gap else Outcome.VOID_GAP,
            eval_price=last_trade.price,
            eval_price_ns=last_trade.exchange_ns,
            staleness_ns=staleness_ns,
            tie=False,
            correct=None,
            brier=None,
            log_loss=None,
        )

    went_above = label_from_price(last_trade.price, target)
    tie = last_trade.price == target
    stale = staleness_ns > fresh_bound_ns

    if went_above:
        outcome = Outcome.STALE_ABOVE if stale else Outcome.ABOVE
    else:
        outcome = Outcome.STALE_BELOW if stale else Outcome.BELOW

    return _score(outcome, went_above, p_above, last_trade, staleness_ns, tie)


def _score(
    outcome: Outcome,
    went_above: bool,
    p_above: float,
    last_trade: Trade,
    staleness_ns: int,
    tie: bool,
) -> Resolution:
    actual = 1.0 if went_above else 0.0
    brier = (p_above - actual) ** 2
    # The probability is already clamped away from 0 and 1 by the model layer and
    # by a database constraint; clamping again here means a corrupted stored row
    # cannot produce an infinite log loss that poisons an entire aggregate.
    safe = min(max(p_above, 1e-9), 1.0 - 1e-9)
    log_loss = -(math.log(safe) if went_above else math.log(1.0 - safe))
    # "Correct" means the side the forecast leaned toward was the side that
    # happened. It is deliberately secondary to the Brier score: a well
    # calibrated 55% forecast is right 55% of the time and is doing its job,
    # while an accuracy figure alone would call that mediocre.
    predicted_above = p_above > 0.5
    correct = predicted_above == went_above
    return Resolution(
        outcome=outcome,
        eval_price=last_trade.price,
        eval_price_ns=last_trade.exchange_ns,
        staleness_ns=staleness_ns,
        tie=tie,
        correct=correct,
        brier=brier,
        log_loss=log_loss,
    )


def horizon_log_return(spot: float, future_price: float) -> float:
    """The quantity every model is really trying to describe."""
    if spot <= 0.0 or future_price <= 0.0:
        raise ValueError("prices must be positive")
    return math.log(future_price / spot)
