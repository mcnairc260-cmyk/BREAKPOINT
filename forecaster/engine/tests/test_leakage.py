"""Proving the system cannot see the future.

Three independent checks, because look-ahead is invisible in the output. A
leaking model does not crash or produce nonsense; it simply gets better, which
is exactly what everyone involved wants to believe.

1. **Declared lookback.** Every feature says how far back it reads. Truncating
   the window to that declaration must not change the value.
2. **No look-ahead.** Adding data *after* the cutoff must not change any feature.
3. **Split hygiene.** A training row whose outcome window crosses into the test
   period must be excluded, not merely one whose features do.
"""

from __future__ import annotations

import pytest

from forecaster.features.compute import compute_features
from forecaster.features.registry import (
    REGISTRY,
    LeakageDetected,
    assert_causal,
    assert_no_lookahead,
    register,
)
from forecaster.features.window import MarketWindow
from forecaster.store import open_database
from forecaster.types import NS_PER_SECOND
from forecaster.validation.splits import walk_forward_folds


def test_every_feature_respects_its_declared_lookback(sim_window: MarketWindow) -> None:
    assert_causal(sim_window)


def test_knowing_the_future_does_not_change_the_answer(sim_events) -> None:
    """The check the whole design exists to pass.

    Two collectors, fed the same events up to instant T. One then receives ten
    more minutes of market; the other does not. Both are asked for the window at
    T, and every feature must come out identical.

    If any feature reads past its cutoff, the collector that has seen the future
    will produce a different number, and this fails. It is the strongest
    statement the project can make about look-ahead, because it compares two real
    ingestion histories rather than a hand-constructed window.
    """
    from tests.conftest import collector_for

    cutoff_ns = 90 * 60 * NS_PER_SECOND
    before = [e for e in sim_events if e.received_ns <= cutoff_ns]
    after = [e for e in sim_events if e.received_ns <= cutoff_ns + 600 * NS_PER_SECOND]
    assert len(after) > len(before), "the second collector must genuinely see more"

    blind_db = open_database("sqlite:///:memory:")
    seeing_db = open_database("sqlite:///:memory:")
    try:
        blind = collector_for(before, blind_db)
        seeing = collector_for(after, seeing_db)

        blind_window = blind.window("BTC-USD", cutoff_ns)
        seeing_window = seeing.window("BTC-USD", cutoff_ns)

        assert blind_window.spot == seeing_window.spot
        assert blind_window.trades == seeing_window.trades
        assert blind_window.quotes == seeing_window.quotes
        assert blind_window.bars_1s == seeing_window.bars_1s
        assert blind_window.book == seeing_window.book

        blind_features = compute_features(blind_window).values
        seeing_features = compute_features(seeing_window).values
        for name, value in blind_features.items():
            assert value == seeing_features[name], (
                f"feature {name!r} changed from {value} to {seeing_features[name]} "
                "when the collector was shown data after the cutoff — it reads the future"
            )
    finally:
        blind_db.dispose()
        seeing_db.dispose()


def test_the_canary_catches_a_feature_that_peeks(sim_window: MarketWindow) -> None:
    """A deliberately leaking feature must be detected, not tolerated.

    Registered temporarily: it claims a five-second lookback while reading an
    hour, which is precisely the mistake the declaration exists to catch.
    """

    @register("canary_peek", lookback_s=5, tier=2, rationale="deliberate leak, test only")
    def _canary(window: MarketWindow) -> float:
        return float(len(window.trades))

    try:
        with pytest.raises(LeakageDetected, match="canary_peek"):
            assert_causal(sim_window)
    finally:
        REGISTRY.pop("canary_peek", None)

    # And with it removed, the real feature set is clean again.
    assert_causal(sim_window)


def test_a_window_containing_post_cutoff_data_is_rejected(collected) -> None:
    """The guarantee is enforced by the window, not by each feature.

    Features read whatever the window hands them — that is deliberate, because
    twelve separate re-implementations of "ignore anything after T" is twelve
    chances to get it wrong. Instead the window itself is the single checkpoint,
    and it refuses to be built wrong.

    This constructs an illegal window by hand (cutoff at T, contents from T+5
    minutes) and asserts that both the window and the feature computation reject
    it rather than quietly producing a leaked number.
    """
    early_ns = 60 * 60 * NS_PER_SECOND
    legal = collected.window("BTC-USD", early_ns)
    later = collected.window("BTC-USD", early_ns + 300 * NS_PER_SECOND)

    illegal = MarketWindow(
        symbol=legal.symbol,
        as_of_ns=early_ns,
        bars_1s=later.bars_1s,
        bars_60s=later.bars_60s,
        trades=later.trades,
        quotes=later.quotes,
        book=later.book,
        data_source=legal.data_source,
        venue=legal.venue,
    )

    with pytest.raises(ValueError, match="after the cutoff"):
        illegal.validate_causality()
    with pytest.raises(ValueError, match="after the cutoff"):
        compute_features(illegal)

    # The properly built window at the same instant is accepted.
    legal.validate_causality()
    assert compute_features(legal).as_of_ns == early_ns


def test_lookahead_helper_flags_a_feature_that_reads_more_than_it_should(collected) -> None:
    """`assert_no_lookahead` compares two windows and names the offender."""
    early_ns = 60 * 60 * NS_PER_SECOND
    now = collected.window("BTC-USD", early_ns)
    future = collected.window("BTC-USD", early_ns + 300 * NS_PER_SECOND)
    with pytest.raises(LeakageDetected):
        assert_no_lookahead(now, future)


class TestSplitHygiene:
    """Purge and embargo, checked on the outcome window rather than the features."""

    def test_training_rows_whose_outcome_crosses_the_boundary_are_excluded(self) -> None:
        folds = walk_forward_folds(0, 12 * 3600 * NS_PER_SECOND, horizon_s=1200, n_folds=3)
        fold = folds[0]
        # A row sampled just before the training cut-off, whose twenty-minute
        # outcome lands after it. Its label is contaminated by the test period.
        just_inside = fold.train_end_ns - 60 * NS_PER_SECOND
        assert not fold.contains_train(just_inside, 1200)
        # The same instant is fine for a short horizon that resolves in time.
        assert fold.contains_train(fold.train_end_ns - 400 * NS_PER_SECOND, 300)

    def test_there_is_always_a_gap_of_two_horizons(self) -> None:
        horizon_s = 300
        folds = walk_forward_folds(0, 12 * 3600 * NS_PER_SECOND, horizon_s=horizon_s, n_folds=4)
        for fold in folds:
            assert fold.purged_ns == 2 * horizon_s * NS_PER_SECOND
            assert fold.train_end_ns < fold.test_start_ns

    def test_too_short_a_span_is_refused_rather_than_squeezed(self) -> None:
        with pytest.raises(ValueError, match="too short"):
            walk_forward_folds(0, 3600 * NS_PER_SECOND, horizon_s=1200, n_folds=5)
