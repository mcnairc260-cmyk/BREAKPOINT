"""The live path and the training path must see exactly the same thing.

Training-serving skew is the failure mode that does not announce itself. A model
validates beautifully, goes live, and quietly performs worse — because the
features it is served differ in some small way from the ones it learned on.

Three window sources exist: the in-memory one the collector feeds, the
database-backed one, and the cached database-backed one used for training and
backtesting. All three must produce identical `MarketWindow` objects, and
therefore identical feature vectors, for the same instant.

Asserted field by field on real generated data, not asserted in a comment.
"""

from __future__ import annotations

import pytest

from forecaster.features.compute import FEATURE_NAMES, compute_features
from forecaster.features.window import CachedWindowSource, StoreWindowSource
from forecaster.types import NS_PER_SECOND, DataSource


@pytest.fixture
def sources(fresh_collected, repos):
    start = 30 * 60 * NS_PER_SECOND
    end = 115 * 60 * NS_PER_SECOND
    store = StoreWindowSource(
        market_repo=repos["market"],
        symbol="BTC-USD",
        venue="simulator",
        data_source=DataSource.SIMULATED,
    )
    cached = CachedWindowSource(
        market_repo=repos["market"],
        symbol="BTC-USD",
        venue="simulator",
        data_source=DataSource.SIMULATED,
        start_ns=start,
        end_ns=end,
    ).load()
    return fresh_collected, store, cached, start, end


def test_store_and_cached_sources_agree_exactly(sources) -> None:
    _, store, cached, start, end = sources
    checked = 0
    for step in range(0, 40):
        as_of = start + step * 120 * NS_PER_SECOND
        if as_of > end:
            break
        left = store.window(as_of)
        right = cached.window(as_of)
        assert left.as_of_ns == right.as_of_ns
        assert left.trades == right.trades, f"trades differ at {as_of}"
        assert left.quotes == right.quotes, f"quotes differ at {as_of}"
        assert left.bars_1s == right.bars_1s, f"1s bars differ at {as_of}"
        assert left.bars_60s == right.bars_60s, f"60s bars differ at {as_of}"
        assert left.book == right.book, f"book differs at {as_of}"
        assert compute_features(left).values == compute_features(right).values
        checked += 1
    assert checked >= 20


def test_the_live_window_matches_the_stored_one(sources) -> None:
    """The in-memory window the server uses against the one training reads.

    Quote coverage is the one place they can legitimately differ: the collector
    keeps a bounded rolling buffer while the database keeps everything, so a
    window near the start of a capture can hold slightly different history. The
    features that matter — everything derived from bars and trades — must agree.
    """
    collector, store, _, start, end = sources
    compared = 0
    for step in range(0, 30):
        as_of = start + step * 150 * NS_PER_SECOND
        if as_of > end:
            break
        live = collector.window("BTC-USD", as_of)
        stored = store.window(as_of)
        assert live.spot == stored.spot, f"spot differs at {as_of}"
        assert live.bars_1s == stored.bars_1s, f"1s bars differ at {as_of}"
        assert live.trades == stored.trades, f"trades differ at {as_of}"

        live_features = compute_features(live).values
        stored_features = compute_features(stored).values
        for name in FEATURE_NAMES:
            assert live_features[name] == pytest.approx(stored_features[name], abs=1e-9), (
                f"feature {name} differs between the live and stored paths at {as_of}"
            )
        compared += 1
    assert compared >= 15


def test_features_are_stable_for_a_repeated_call(sim_window) -> None:
    """The same window must always give the same numbers.

    Guards against a feature that reads a clock, a random value, or mutable
    state — any of which would make a stored prediction irreproducible from its
    own recorded inputs.
    """
    first = compute_features(sim_window).values
    for _ in range(5):
        assert compute_features(sim_window).values == first


def test_every_declared_feature_is_produced(sim_window) -> None:
    values = compute_features(sim_window).values
    assert set(values) == set(FEATURE_NAMES)
    assert all(isinstance(v, float) for v in values.values())


def test_feature_coverage_is_reported(sim_window) -> None:
    from forecaster.features.compute import coverage

    vector = compute_features(sim_window)
    # Two hours of dense simulated data should compute essentially everything.
    assert coverage(vector) > 0.9
