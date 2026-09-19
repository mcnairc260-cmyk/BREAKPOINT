"""The definitions everything else depends on."""

from __future__ import annotations

import math

import pytest

from forecaster.labels import label_from_price, resolve_outcome
from forecaster.types import NS_PER_SECOND, Outcome, Quote, Side, Trade

FRESH = 2 * NS_PER_SECOND
MAX = 60 * NS_PER_SECOND


def trade_at(price: float, ns: int) -> Trade:
    return Trade(
        exchange_ns=ns,
        received_ns=ns,
        symbol="BTC-USD",
        price=price,
        size=1.0,
        side=Side.BUY,
        trade_id=f"t{ns}",
    )


class TestEqualityRule:
    """ABOVE is strictly greater. Equality resolves BELOW, everywhere, always."""

    def test_strictly_above(self) -> None:
        assert label_from_price(100.01, 100.0) is True

    def test_equality_is_below(self) -> None:
        assert label_from_price(100.0, 100.0) is False

    def test_below(self) -> None:
        assert label_from_price(99.99, 100.0) is False

    def test_resolution_agrees_with_the_rule(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.5,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(100.0, eval_ns),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.outcome is Outcome.BELOW
        assert result.tie is True


class TestStaleness:
    def test_fresh_resolves_cleanly(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.6,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(101.0, eval_ns - NS_PER_SECOND),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.outcome is Outcome.ABOVE

    def test_slightly_stale_still_counts_but_is_flagged(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.6,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(101.0, eval_ns - 30 * NS_PER_SECOND),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.outcome is Outcome.STALE_ABOVE
        assert result.is_scored

    def test_too_stale_is_void_not_a_guess(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.6,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(101.0, eval_ns - 120 * NS_PER_SECOND),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.outcome is Outcome.VOID_GAP
        assert not result.is_scored
        assert result.correct is None

    def test_no_trade_is_void(self) -> None:
        result = resolve_outcome(
            p_above=0.6,
            target=100.0,
            eval_at_ns=1_000 * NS_PER_SECOND,
            last_trade=None,
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.outcome is Outcome.VOID_GAP


class TestScoring:
    def test_brier_and_log_loss(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.8,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(101.0, eval_ns),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.brier == pytest.approx((0.8 - 1.0) ** 2)
        assert result.log_loss == pytest.approx(-math.log(0.8))
        assert result.correct is True

    def test_a_confident_miss_is_penalised_hard(self) -> None:
        eval_ns = 1_000 * NS_PER_SECOND
        result = resolve_outcome(
            p_above=0.95,
            target=100.0,
            eval_at_ns=eval_ns,
            last_trade=trade_at(99.0, eval_ns),
            fresh_bound_ns=FRESH,
            max_bound_ns=MAX,
        )
        assert result.brier == pytest.approx(0.9025)
        assert result.correct is False


class TestQuoteMaths:
    def test_microprice_leans_toward_the_thin_side(self) -> None:
        # More size on the bid means the ask is thinner, so price is more likely
        # to move up. The microprice must sit above the mid.
        quote = Quote(1, 1, "BTC-USD", bid=100.0, bid_size=10.0, ask=101.0, ask_size=1.0)
        assert quote.microprice > quote.mid

    def test_microprice_falls_back_to_mid_when_sizes_are_unknown(self) -> None:
        quote = Quote(1, 1, "BTC-USD", bid=100.0, bid_size=0.0, ask=101.0, ask_size=0.0)
        assert quote.microprice == quote.mid
