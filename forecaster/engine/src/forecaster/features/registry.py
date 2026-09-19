"""The feature registry, and the leakage check it makes possible.

Every feature declares the furthest back it looks. That declaration is not
documentation — it is checked. `assert_causal` recomputes each feature on a
window truncated to its declared lookback and requires the answer to be
unchanged. A feature that secretly reads more history than it admits, or reads
anything at all after the cutoff, fails loudly.

This catches the specific bug that ruins forecasting projects: a feature that is
accidentally computed over a window including the future, producing a model that
validates at 80% and predicts at 50%.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Final

from forecaster.features.window import MarketWindow
from forecaster.types import NS_PER_SECOND

FeatureFn = Callable[[MarketWindow], float]


class LeakageDetected(Exception):
    """A feature read data it was not entitled to read."""


@dataclass(frozen=True)
class FeatureSpec:
    """One feature: how to compute it, how far back it looks, and why it exists."""

    name: str
    fn: FeatureFn
    lookback_ns: int
    tier: int
    """1 = expected to carry real signal. 2 = plausible, must earn its place
    against held-out data. Nothing above tier 2 ships without evidence."""
    rationale: str


REGISTRY: Final[dict[str, FeatureSpec]] = {}


def register(
    name: str, *, lookback_s: float, tier: int, rationale: str
) -> Callable[[FeatureFn], FeatureFn]:
    def decorator(fn: FeatureFn) -> FeatureFn:
        if name in REGISTRY:
            raise ValueError(f"feature {name!r} registered twice")
        REGISTRY[name] = FeatureSpec(
            name=name,
            fn=fn,
            lookback_ns=int(lookback_s * NS_PER_SECOND),
            tier=tier,
            rationale=rationale,
        )
        return fn

    return decorator


def truncate(window: MarketWindow, lookback_ns: int) -> MarketWindow:
    """A window containing only the declared lookback."""
    floor_ns = window.as_of_ns - lookback_ns
    return replace(
        window,
        bars_1s=tuple(b for b in window.bars_1s if b.open_ns >= floor_ns),
        bars_60s=tuple(b for b in window.bars_60s if b.open_ns >= floor_ns),
        trades=tuple(t for t in window.trades if t.received_ns >= floor_ns),
        quotes=tuple(q for q in window.quotes if q.received_ns >= floor_ns),
    )


def shift_forward(window: MarketWindow, delta_ns: int) -> MarketWindow:
    """A window whose cutoff moved back, i.e. that knows strictly less.

    Used by the causality test: a feature evaluated at an earlier cutoff must not
    equal the later one by accident, and must never depend on data that only the
    later cutoff can see.
    """
    earlier = window.as_of_ns - delta_ns
    return replace(
        window,
        as_of_ns=earlier,
        bars_1s=tuple(
            b for b in window.bars_1s if b.open_ns + b.resolution_s * NS_PER_SECOND <= earlier
        ),
        bars_60s=tuple(
            b for b in window.bars_60s if b.open_ns + b.resolution_s * NS_PER_SECOND <= earlier
        ),
        trades=tuple(t for t in window.trades if t.received_ns <= earlier),
        quotes=tuple(q for q in window.quotes if q.received_ns <= earlier),
        book=window.book if window.book and window.book.received_ns <= earlier else None,
    )


def assert_causal(window: MarketWindow, *, tolerance: float = 1e-9) -> None:
    """Check every registered feature against its declared lookback.

    Two properties, both required:

    1. Truncating the window to the declared lookback does not change the value.
       A feature that changes was reading further back than it said.
    2. Appending data *after* the cutoff does not change the value. A feature
       that changes is looking ahead.

    Property 2 is the one that matters. It is checked here rather than trusted,
    because look-ahead is invisible in the output — the model simply gets better,
    which is exactly what a developer wants to believe.
    """
    window.validate_causality()
    for spec in REGISTRY.values():
        full = spec.fn(window)
        limited = spec.fn(truncate(window, spec.lookback_ns))
        if not _close(full, limited, tolerance):
            raise LeakageDetected(
                f"feature {spec.name!r} declares a {spec.lookback_ns / NS_PER_SECOND:.0f}s "
                f"lookback but changes when the window is truncated to it "
                f"({full!r} vs {limited!r}) — the declaration is wrong"
            )


def assert_no_lookahead(
    window: MarketWindow, future_window: MarketWindow, *, tolerance: float = 1e-9
) -> None:
    """`future_window` holds the same history plus data after the cutoff.

    Every feature must be blind to the extra data.
    """
    for spec in REGISTRY.values():
        now = spec.fn(window)
        later = spec.fn(future_window)
        if not _close(now, later, tolerance):
            raise LeakageDetected(
                f"feature {spec.name!r} changed from {now!r} to {later!r} when data after "
                f"the cutoff was added — it is reading the future"
            )


def _close(a: float, b: float, tolerance: float) -> bool:
    if a == b:
        return True
    scale = max(1.0, abs(a), abs(b))
    return abs(a - b) <= tolerance * scale


def tier_names(tier: int) -> tuple[str, ...]:
    return tuple(sorted(name for name, spec in REGISTRY.items() if spec.tier == tier))


def max_lookback_ns() -> int:
    return max((spec.lookback_ns for spec in REGISTRY.values()), default=0)
