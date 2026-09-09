"""The shape of the return distribution, especially its tails.

The baseline splits the forecasting problem in two: **how wide** the distribution
is (volatility, which is forecastable) and **what shape** it has (which is
stable). This module owns the shape.

Three layers, in order of preference:

1. **Empirical.** Standardised residuals pooled across the whole training set,
   used directly. This is filtered historical simulation: it makes no
   distributional assumption at all in the region where data exists.
2. **Generalised Pareto tail.** Beyond roughly the 95th percentile the empirical
   quantiles run out — and that is exactly where a user setting an ambitious
   target lands. Extreme value theory says exceedances over a high threshold
   converge to a generalised Pareto distribution, so one is fitted there.
3. **Student-t fallback.** Before enough residuals exist, a Student-t with four
   degrees of freedom. Crypto returns at minute scale are reliably fatter-tailed
   than Gaussian, and a Gaussian assumption would produce confidently tiny
   probabilities for moves that happen most weeks.

Why this is not a detail: without a tail model, an empirical distribution
returns **exactly zero** for a target beyond anything in the training data. Zero
is a claim of impossibility, it makes log loss infinite, and it is the single
most embarrassing thing a probability product can print.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import stats

# Below this many pooled residuals, the empirical shape is noise and Student-t
# is used instead. Pooled across all times and both directions, so it fills far
# faster than any per-bucket estimate ever could.
MIN_RESIDUALS = 2_000

from forecaster.types import PROB_FLOOR as PROB_FLOOR  # re-exported for the model layer


@dataclass(frozen=True)
class GPDTail:
    """A generalised Pareto fit to one tail's exceedances."""

    threshold: float
    shape: float
    """The tail index. Positive means heavy-tailed, which is what crypto shows."""
    scale: float
    exceedance_rate: float
    """Fraction of observations beyond the threshold, so the tail can be glued
    onto the empirical body at the right height."""
    n_exceedances: int

    def survival(self, x: float) -> float:
        """P(residual > x) for x beyond the threshold."""
        if x <= self.threshold:
            raise ValueError("GPD tail queried inside the body of the distribution")
        excess = x - self.threshold
        return self.exceedance_rate * float(
            stats.genpareto.sf(excess, c=self.shape, scale=self.scale)
        )

    def quantile(self, upper_tail_prob: float) -> float:
        """The x with P(residual > x) = `upper_tail_prob`."""
        if upper_tail_prob <= 0.0:
            return math.inf
        ratio = min(1.0, upper_tail_prob / self.exceedance_rate)
        excess = float(stats.genpareto.isf(ratio, c=self.shape, scale=self.scale))
        return self.threshold + excess

    def to_dict(self) -> dict[str, float | int]:
        return {
            "threshold": self.threshold,
            "shape": self.shape,
            "scale": self.scale,
            "exceedance_rate": self.exceedance_rate,
            "n_exceedances": self.n_exceedances,
        }

    @classmethod
    def fit(cls, residuals: np.ndarray, quantile: float = 0.95) -> GPDTail | None:
        """Fit the upper tail of `residuals`.

        The lower tail is fitted by passing negated residuals, so one
        implementation covers both and the two tails are free to differ — which
        they do: crypto sells off faster than it rallies.
        """
        if residuals.size < MIN_RESIDUALS // 4:
            return None
        threshold = float(np.quantile(residuals, quantile))
        exceedances = residuals[residuals > threshold] - threshold
        if exceedances.size < 50:
            return None
        try:
            shape, _loc, scale = stats.genpareto.fit(exceedances, floc=0.0)
        except Exception:
            return None
        if not math.isfinite(shape) or not math.isfinite(scale) or scale <= 0.0:
            return None
        # A shape at or above 1 implies infinite mean, which is not a credible
        # description of a five-minute crypto return and is usually a sign the
        # fit latched onto a handful of outliers.
        shape = float(min(shape, 0.7))
        return cls(
            threshold=threshold,
            shape=shape,
            scale=float(scale),
            exceedance_rate=float(exceedances.size / residuals.size),
            n_exceedances=int(exceedances.size),
        )


@dataclass
class ResidualShape:
    """The standardised return distribution: empirical body, modelled tails.

    A residual is `(log return over the horizon − mu) / sigma`. If the volatility
    model is any good these are roughly mean-zero, unit-variance, and stable
    across regimes — which is the whole reason the shape can be pooled across the
    entire training set while the width is forecast fresh each time.
    """

    student_t_df: float = 4.0
    body_quantiles: np.ndarray | None = None
    """Sorted residuals forming the empirical body."""
    upper_tail: GPDTail | None = None
    lower_tail: GPDTail | None = None
    tail_quantile: float = 0.95
    n_residuals: int = 0
    source: str = "student_t"
    """`student_t` or `empirical`. Reported to the user, because which one is in
    use is a real statement about how much the system knows."""

    @property
    def is_empirical(self) -> bool:
        return self.source == "empirical" and self.body_quantiles is not None

    @classmethod
    def fit(
        cls, residuals: np.ndarray, *, student_t_df: float = 4.0, tail_quantile: float = 0.95
    ) -> ResidualShape:
        clean = residuals[np.isfinite(residuals)]
        if clean.size < MIN_RESIDUALS:
            return cls(student_t_df=student_t_df, n_residuals=int(clean.size), source="student_t")
        ordered = np.sort(clean)
        return cls(
            student_t_df=student_t_df,
            body_quantiles=ordered,
            upper_tail=GPDTail.fit(clean, tail_quantile),
            lower_tail=GPDTail.fit(-clean, tail_quantile),
            tail_quantile=tail_quantile,
            n_residuals=int(clean.size),
            source="empirical",
        )

    # -- the two operations everything else needs ---------------------------

    def survival(self, z: float) -> float:
        """P(residual > z). Strictly decreasing in z, which is what guarantees
        that raising the target never raises the probability of clearing it."""
        if not math.isfinite(z):
            return PROB_FLOOR if z > 0 else 1.0 - PROB_FLOOR
        if self.is_empirical:
            value = self._empirical_survival(z)
        else:
            value = float(stats.t.sf(z * self._t_scale(), df=self.student_t_df))
        return min(max(value, PROB_FLOOR), 1.0 - PROB_FLOOR)

    def quantile(self, q: float) -> float:
        """The residual z with P(residual <= z) = q."""
        q = min(max(q, PROB_FLOOR), 1.0 - PROB_FLOOR)
        if self.is_empirical:
            return self._empirical_quantile(q)
        return float(stats.t.ppf(q, df=self.student_t_df) / self._t_scale())

    def _t_scale(self) -> float:
        """Rescale Student-t to unit variance.

        Without this a t(4) has variance 2, so the model would forecast ranges
        41% too wide and every probability would drift toward 50%. A subtle bug
        that makes a system look pleasingly humble while being wrong.
        """
        df = self.student_t_df
        if df <= 2.0:
            return 1.0
        return math.sqrt(df / (df - 2.0))

    def _empirical_survival(self, z: float) -> float:
        body = self.body_quantiles
        assert body is not None
        if self.upper_tail is not None and z > self.upper_tail.threshold:
            return self.upper_tail.survival(z)
        if self.lower_tail is not None and -z > self.lower_tail.threshold:
            # The lower tail was fitted on negated residuals, so its survival at
            # -z is P(residual < z), and the answer is one minus that.
            return 1.0 - self.lower_tail.survival(-z)
        rank = float(np.searchsorted(body, z, side="right"))
        return 1.0 - rank / body.size

    def _empirical_quantile(self, q: float) -> float:
        body = self.body_quantiles
        assert body is not None
        upper_prob = 1.0 - q
        if self.upper_tail is not None and upper_prob < self.upper_tail.exceedance_rate:
            return self.upper_tail.quantile(upper_prob)
        if self.lower_tail is not None and q < self.lower_tail.exceedance_rate:
            return -self.lower_tail.quantile(q)
        return float(np.quantile(body, q))

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "student_t_df": self.student_t_df,
            "n_residuals": self.n_residuals,
            "tail_quantile": self.tail_quantile,
            "upper_tail": self.upper_tail.to_dict() if self.upper_tail else None,
            "lower_tail": self.lower_tail.to_dict() if self.lower_tail else None,
            # The body is stored thinned to 512 quantiles. Full precision would
            # bloat every artifact for a difference far below the noise floor of
            # the volatility forecast that scales it.
            "body": (
                np.quantile(self.body_quantiles, np.linspace(0.0, 1.0, 512)).tolist()
                if self.body_quantiles is not None
                else None
            ),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ResidualShape:
        body = payload.get("body")
        return cls(
            student_t_df=float(payload.get("student_t_df", 4.0)),
            body_quantiles=np.asarray(body, dtype=float) if body else None,
            upper_tail=GPDTail(**payload["upper_tail"]) if payload.get("upper_tail") else None,
            lower_tail=GPDTail(**payload["lower_tail"]) if payload.get("lower_tail") else None,
            tail_quantile=float(payload.get("tail_quantile", 0.95)),
            n_residuals=int(payload.get("n_residuals", 0)),
            source=str(payload.get("source", "student_t")),
        )
