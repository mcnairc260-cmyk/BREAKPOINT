"""Confidence intervals that account for the data not being independent.

An ordinary bootstrap resamples rows. These rows are not independent — a
twenty-minute label overlaps its neighbour by 1199/1200, and several targets
share a single realised price — so a row bootstrap produces intervals that are
far too narrow and declares differences significant that are not.

A **stationary block bootstrap** resamples contiguous blocks instead, preserving
the correlation inside each block. With a block length of a few horizons, the
resulting interval reflects the real evidence rather than the row count.

The `variance_inflation` function makes the size of the problem visible: it is
the ratio of the honest variance to the naive one. A value of 20 means the
ordinary interval was about 4.5 times too narrow, and it is the number worth
putting in a report.

Model comparisons use `paired_delta`, which resamples the *difference* per
instant rather than each model's score separately. Paired is both correct and
much tighter — the two models saw exactly the same markets, and treating their
scores as independent throws that away.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class BootstrapResult:
    """A statistic with an interval that can be believed."""

    point: float
    ci_low: float
    ci_high: float
    standard_error: float
    n_effective: int
    block_length: int
    n_resamples: int

    @property
    def excludes_zero(self) -> bool:
        return self.ci_low > 0.0 or self.ci_high < 0.0

    @property
    def is_positive(self) -> bool:
        """Confidently greater than zero. The bar a candidate model must clear."""
        return self.ci_low > 0.0

    def describe(self) -> str:
        return (
            f"{self.point:+.5f} (95% CI {self.ci_low:+.5f} to {self.ci_high:+.5f}, "
            f"n={self.n_effective}, block={self.block_length})"
        )

    def to_dict(self) -> dict[str, float | int | bool]:
        return {
            "point": self.point,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "standard_error": self.standard_error,
            "n_effective": self.n_effective,
            "block_length": self.block_length,
            "n_resamples": self.n_resamples,
            "excludes_zero": self.excludes_zero,
        }


def suggested_block_length(n: int, horizon_s: int, interval_s: float) -> int:
    """A block long enough to contain the dependence.

    At least three horizons' worth of samples, because that is the span over
    which labels overlap and features stay correlated. Capped at a fifth of the
    series so there are enough distinct blocks for resampling to mean anything.
    """
    if interval_s <= 0.0:
        return max(1, min(n // 5, 50))
    per_horizon = max(1, round(horizon_s / interval_s))
    return max(1, min(n // 5 if n >= 25 else 1, per_horizon * 3))


def _stationary_blocks(
    values: NDArray[np.float64], block_length: int, rng: np.random.Generator
) -> NDArray[np.float64]:
    """One resample, built from geometrically distributed wrapped blocks.

    Geometric rather than fixed lengths — that is what makes it *stationary*, and
    it removes the artefacts a fixed block size introduces at the joins.
    """
    n = values.size
    if n == 0:
        return values
    p = 1.0 / max(1, block_length)
    out = np.empty(n, dtype=float)
    index = 0
    while index < n:
        start = rng.integers(0, n).item()
        while index < n:
            out[index] = values[start % n]
            index += 1
            start += 1
            if rng.random() < p:
                break
    return out


def block_bootstrap_mean(
    values: Sequence[float] | NDArray[np.float64],
    *,
    horizon_s: int = 300,
    interval_s: float = 1.0,
    n_resamples: int = 2_000,
    confidence: float = 0.95,
    seed: int = 20260909,
    block_length: int | None = None,
) -> BootstrapResult:
    """Mean of a dependent series, with an interval that reflects that."""
    array = np.asarray(
        [float(v) for v in np.asarray(values, dtype=float) if math.isfinite(v)], dtype=float
    )
    if array.size == 0:
        return BootstrapResult(float("nan"), float("nan"), float("nan"), float("nan"), 0, 0, 0)
    if array.size == 1:
        v = float(array[0])
        return BootstrapResult(v, v, v, 0.0, 1, 1, 0)

    block = block_length or suggested_block_length(array.size, horizon_s, interval_s)
    rng = np.random.default_rng(seed)
    means = np.empty(n_resamples, dtype=float)
    for i in range(n_resamples):
        means[i] = float(np.mean(_stationary_blocks(array, block, rng)))

    alpha = (1.0 - confidence) / 2.0
    return BootstrapResult(
        point=float(np.mean(array)),
        ci_low=float(np.quantile(means, alpha)),
        ci_high=float(np.quantile(means, 1.0 - alpha)),
        standard_error=float(np.std(means, ddof=1)),
        n_effective=int(array.size),
        block_length=block,
        n_resamples=n_resamples,
    )


def paired_delta(
    a: Sequence[float] | NDArray[np.float64],
    b: Sequence[float] | NDArray[np.float64],
    *,
    horizon_s: int = 300,
    interval_s: float = 1.0,
    n_resamples: int = 2_000,
    confidence: float = 0.95,
    seed: int = 20260909,
) -> BootstrapResult:
    """Interval for `mean(b − a)`, resampled as one paired series.

    Positive means `b` scored higher than `a`. For Brier scores, where lower is
    better, pass `a=candidate, b=incumbent` so a positive result means the
    candidate improved things.
    """
    left = np.asarray(a, dtype=float)
    right = np.asarray(b, dtype=float)
    if left.shape != right.shape:
        raise ValueError("paired comparison needs series of equal length")
    mask = np.isfinite(left) & np.isfinite(right)
    return block_bootstrap_mean(
        (right[mask] - left[mask]).tolist(),
        horizon_s=horizon_s,
        interval_s=interval_s,
        n_resamples=n_resamples,
        confidence=confidence,
        seed=seed,
    )


def variance_inflation(
    values: Sequence[float] | NDArray[np.float64],
    *,
    horizon_s: int = 300,
    interval_s: float = 1.0,
    seed: int = 20260909,
) -> float:
    """How much narrower a naive interval would wrongly have been.

    The ratio of block-bootstrap variance to the independence-assuming variance.
    A value of 1 means the observations really were independent. Values of 10 to
    40 are normal for overlapping short-horizon labels, and reporting this number
    is the most direct way to make the overlap problem legible.
    """
    array = np.asarray(
        [float(v) for v in np.asarray(values, dtype=float) if math.isfinite(v)], dtype=float
    )
    if array.size < 10:
        return float("nan")
    naive = float(np.var(array, ddof=1) / array.size)
    if naive <= 0.0:
        return float("nan")
    result = block_bootstrap_mean(
        array.tolist(), horizon_s=horizon_s, interval_s=interval_s, n_resamples=800, seed=seed
    )
    return float(result.standard_error**2 / naive)
