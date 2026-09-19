"""Splitting time series without lying to yourself.

Three problems have to be solved together, and solving only the first — which is
what "use a chronological split" usually means in practice — leaves the other two
open.

**1. Order.** Training data must precede validation data. Obvious, and not
sufficient.

**2. Overlap.** A twenty-minute label sampled every second shares 1199/1200 of
its outcome window with its neighbour. A training row immediately before the
validation boundary has an outcome that extends *into* the validation period, so
the model is fitted on the answer it is about to be tested on. The fix is to
**purge** every training row whose outcome window reaches past the boundary, and
then to **embargo** a further full horizon, because features are also serially
correlated across that span.

**3. Multiplicity.** Several targets are evaluated at the same instant. They all
resolve from one realised price, so they are one observation dressed as many.
They must never be split across folds, and they must not be counted as
independent evidence.

The third is the one that quietly ruins things. Ignore it and the row count looks
like 500,000 when the real evidence is 288 independent observations a day, every
confidence interval is roughly twenty times too narrow, and every model looks
significantly better than every other.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from forecaster.types import NS_PER_SECOND


@dataclass(frozen=True)
class Fold:
    """One train/test division, with the purged region made explicit."""

    index: int
    train_start_ns: int
    train_end_ns: int
    test_start_ns: int
    test_end_ns: int
    embargo_ns: int

    def contains_train(self, as_of_ns: int, horizon_s: int) -> bool:
        """Is this row usable for training?

        A row qualifies only if its *outcome* also lands before the boundary.
        Checking the feature timestamp alone is the classic overlap leak.
        """
        outcome_ns = as_of_ns + horizon_s * NS_PER_SECOND
        return as_of_ns >= self.train_start_ns and outcome_ns <= self.train_end_ns

    def contains_test(self, as_of_ns: int) -> bool:
        return self.test_start_ns <= as_of_ns < self.test_end_ns

    @property
    def purged_ns(self) -> int:
        return self.test_start_ns - self.train_end_ns

    def describe(self) -> str:
        span = (self.test_end_ns - self.test_start_ns) / NS_PER_SECOND
        return (
            f"fold {self.index}: train ends {self.purged_ns / NS_PER_SECOND:.0f}s "
            f"before a {span:.0f}s test window"
        )


def walk_forward_folds(
    start_ns: int,
    end_ns: int,
    *,
    horizon_s: int,
    n_folds: int = 5,
    embargo_multiple: float = 1.0,
    min_train_fraction: float = 0.35,
) -> list[Fold]:
    """Expanding-window walk-forward folds with purge and embargo.

    Expanding rather than rolling: more history is genuinely better for a
    volatility model, and discarding the early part of an already small sample to
    keep the window a fixed size costs more than it buys.

    The gap between the end of training and the start of testing is one full
    horizon (the purge) plus `embargo_multiple` more horizons (the embargo).
    """
    total_ns = end_ns - start_ns
    horizon_ns = horizon_s * NS_PER_SECOND
    embargo_ns = int(horizon_ns * (1.0 + embargo_multiple))
    if total_ns <= embargo_ns * (n_folds + 1):
        raise ValueError(
            f"span of {total_ns / NS_PER_SECOND:.0f}s is too short for {n_folds} folds "
            f"at a {horizon_s}s horizon with purge and embargo; "
            f"need more than {embargo_ns * (n_folds + 1) / NS_PER_SECOND:.0f}s"
        )

    first_train_ns = int(total_ns * min_train_fraction)
    remaining_ns = total_ns - first_train_ns
    test_span_ns = remaining_ns // n_folds

    folds: list[Fold] = []
    for i in range(n_folds):
        test_start = start_ns + first_train_ns + i * test_span_ns
        test_end = test_start + test_span_ns if i < n_folds - 1 else end_ns
        train_end = test_start - embargo_ns
        if train_end <= start_ns:
            continue
        folds.append(
            Fold(
                index=i,
                train_start_ns=start_ns,
                train_end_ns=train_end,
                test_start_ns=test_start,
                test_end_ns=test_end,
                embargo_ns=embargo_ns,
            )
        )
    if not folds:
        raise ValueError("purge and embargo consumed the entire span; capture more data")
    return folds


@dataclass(frozen=True)
class SampleSize:
    """How much evidence there really is.

    Deliberately not a single number. A single "effective sample size" invites
    the reader to plug it into a formula that assumes independence, and the whole
    point is that these observations are not independent in several different
    ways at once.
    """

    n_rows: int
    """Rows in the dataset. The largest and least meaningful figure."""

    n_timestamps: int
    """Distinct instants. Several targets per instant collapse to one, because
    they all resolve from the same realised price."""

    n_non_overlapping: int
    """Timestamps spaced at least one horizon apart. A hard ceiling on the
    independent evidence available."""

    n_days: float
    """Regimes matter more than rows. A model validated across two days has been
    validated against two days of market conditions, however many rows that was."""

    horizon_s: int

    @property
    def headline(self) -> int:
        """The number any claim should be judged against."""
        return self.n_non_overlapping

    def describe(self) -> str:
        return (
            f"{self.n_rows:,} rows across {self.n_timestamps:,} instants — but only "
            f"{self.n_non_overlapping:,} non-overlapping {self.horizon_s}s observations "
            f"over {self.n_days:.1f} days. Judge every claim against the smallest number."
        )

    def is_sufficient_for_learning(self, minimum: int = 2_000) -> bool:
        return self.n_non_overlapping >= minimum

    def to_dict(self) -> dict[str, float | int]:
        return {
            "n_rows": self.n_rows,
            "n_timestamps": self.n_timestamps,
            "n_non_overlapping": self.n_non_overlapping,
            "n_days": round(self.n_days, 3),
            "horizon_s": self.horizon_s,
        }


def effective_sample_size(timestamps_ns: Sequence[int], horizon_s: int, n_rows: int) -> SampleSize:
    """Count the evidence four ways."""
    if not timestamps_ns:
        return SampleSize(
            n_rows=n_rows, n_timestamps=0, n_non_overlapping=0, n_days=0.0, horizon_s=horizon_s
        )
    ordered = sorted(set(timestamps_ns))
    horizon_ns = horizon_s * NS_PER_SECOND

    independent = 0
    last_used = None
    for ts in ordered:
        if last_used is None or ts - last_used >= horizon_ns:
            independent += 1
            last_used = ts

    span_ns = ordered[-1] - ordered[0]
    return SampleSize(
        n_rows=n_rows,
        n_timestamps=len(ordered),
        n_non_overlapping=independent,
        n_days=span_ns / NS_PER_SECOND / 86_400.0,
        horizon_s=horizon_s,
    )


def group_weights(timestamps_ns: Sequence[int]) -> list[float]:
    """Weight rows by 1/(rows sharing their instant).

    Without this, an instant that happened to generate thirty target samples
    outvotes one that generated five, and the model quietly learns to fit
    whichever market conditions produced more sampled targets.
    """
    counts: dict[int, int] = {}
    for ts in timestamps_ns:
        counts[ts] = counts.get(ts, 0) + 1
    return [1.0 / counts[ts] for ts in timestamps_ns]
