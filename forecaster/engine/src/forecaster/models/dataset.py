"""Building training rows from recorded market data.

One row is: features observed at an instant, a target price, and whether the
price finished above it. The subtlety is in choosing the target prices, because
the user picks theirs and the training set has to cover the range they might ask
for without distorting what the model learns.

Targets are sampled in **volatility units**, not dollars. A grid of z values
spanning roughly ±3 standard deviations covers everything a user realistically
asks about, adapts automatically to quiet and violent markets, and keeps the
class balance stable — a dollar grid would produce all-ABOVE rows in a calm hour
and all-BELOW rows in a crash.

Two properties are preserved carefully:

* Every row from one instant carries the same `as_of_ns`, so the splitter can
  keep them together and the sample-size accounting can collapse them to one
  observation. They resolve from a single realised price; they are one piece of
  evidence, not thirty.
* Each row carries the baseline's probability. Learners are fitted as
  *corrections* to it, which makes "does the model add anything" a directly
  testable question rather than a comparison of two numbers that both mostly
  encode the same volatility estimate.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from forecaster.features.compute import FEATURE_NAMES, compute_features
from forecaster.features.window import MarketWindow
from forecaster.labels.resolve import label_from_price
from forecaster.models.base import InsufficientData
from forecaster.models.baseline import BaselineModel
from forecaster.types import NS_PER_SECOND, DataSource

# Targets sampled per instant, in standard deviations from the current price.
# Asymmetric on purpose? No — symmetric, so the base rate stays near 50% and an
# accuracy figure cannot be inflated by a lopsided grid.
DEFAULT_Z_GRID: tuple[float, ...] = (
    -3.0,
    -2.0,
    -1.5,
    -1.0,
    -0.6,
    -0.3,
    -0.1,
    0.1,
    0.3,
    0.6,
    1.0,
    1.5,
    2.0,
    3.0,
)


@dataclass
class Dataset:
    """Training rows, with everything needed to split and weight them honestly."""

    as_of_ns: np.ndarray
    features: np.ndarray
    """Shape (n_rows, n_features). Column order is `FEATURE_NAMES`."""
    z: np.ndarray
    """Distance to target in standard deviations. The one input that varies
    within an instant."""
    baseline_p: np.ndarray
    """The baseline's probability, used as the offset for every learner."""
    label: np.ndarray
    """1 if the price finished above the target."""
    spot: np.ndarray
    target: np.ndarray
    sigma: np.ndarray
    future_price: np.ndarray
    horizon_s: int
    symbol: str
    data_source: DataSource
    feature_names: tuple[str, ...] = FEATURE_NAMES

    def __len__(self) -> int:
        return int(self.as_of_ns.size)

    @property
    def n_instants(self) -> int:
        return int(np.unique(self.as_of_ns).size)

    def instant_weights(self) -> np.ndarray:
        """Weight each row by 1/(rows at its instant).

        Without this, an instant that produced fourteen sampled targets counts
        fourteen times as much as one that produced four, and the model learns
        the sampling scheme rather than the market.
        """
        _, inverse, counts = np.unique(self.as_of_ns, return_inverse=True, return_counts=True)
        return 1.0 / counts[inverse]

    def mask(self, selector: np.ndarray) -> Dataset:
        return Dataset(
            as_of_ns=self.as_of_ns[selector],
            features=self.features[selector],
            z=self.z[selector],
            baseline_p=self.baseline_p[selector],
            label=self.label[selector],
            spot=self.spot[selector],
            target=self.target[selector],
            sigma=self.sigma[selector],
            future_price=self.future_price[selector],
            horizon_s=self.horizon_s,
            symbol=self.symbol,
            data_source=self.data_source,
            feature_names=self.feature_names,
        )

    def design_matrix(self) -> np.ndarray:
        """Features plus z, in a fixed column order.

        z is last, deliberately: it is the column a monotonic constraint is
        applied to, and putting it in a known position keeps that wiring
        explicit rather than looked up by name at fit time.
        """
        return np.column_stack([self.features, self.z])

    @property
    def design_names(self) -> tuple[str, ...]:
        return (*self.feature_names, "z")

    def summary(self) -> dict[str, object]:
        return {
            "n_rows": len(self),
            "n_instants": self.n_instants,
            "symbol": self.symbol,
            "horizon_s": self.horizon_s,
            "data_source": self.data_source.value,
            "base_rate": float(np.mean(self.label)) if len(self) else float("nan"),
            "mean_sigma": float(np.mean(self.sigma)) if len(self) else float("nan"),
        }


@dataclass
class DatasetBuilder:
    """Walks recorded data and produces training rows.

    The window source is the same one the live server uses, so features here are
    computed by the same code path that will compute them in production. That is
    the whole defence against training-serving skew, and it is worth the small
    performance cost of not vectorising.
    """

    window_source: object
    baseline: BaselineModel
    symbol: str
    horizon_s: int
    data_source: DataSource
    z_grid: tuple[float, ...] = DEFAULT_Z_GRID
    sample_interval_s: int = 15
    """How often to take a training instant. Sampling every second would produce
    sixty times the rows and almost no extra information, because consecutive
    windows are nearly identical. Fifteen seconds keeps the file sizes sane
    without materially reducing the independent evidence."""

    def build(
        self,
        start_ns: int,
        end_ns: int,
        *,
        price_at: object,
        warmup_s: int = 3600,
    ) -> Dataset:
        """Generate rows between two instants.

        `price_at(ns)` must return the realised price at a future instant, read
        from the recorded feed. Rows whose outcome falls outside the captured
        range are dropped rather than resolved against the last available price,
        which would systematically mislabel the end of every capture.
        """
        horizon_ns = self.horizon_s * NS_PER_SECOND
        step_ns = self.sample_interval_s * NS_PER_SECOND
        first_ns = start_ns + warmup_s * NS_PER_SECOND
        last_ns = end_ns - horizon_ns

        rows_as_of: list[int] = []
        rows_features: list[list[float]] = []
        rows_z: list[float] = []
        rows_p: list[float] = []
        rows_label: list[int] = []
        rows_spot: list[float] = []
        rows_target: list[float] = []
        rows_sigma: list[float] = []
        rows_future: list[float] = []

        as_of = first_ns
        while as_of <= last_ns:
            window: MarketWindow = self.window_source.window(as_of)  # type: ignore[attr-defined]
            try:
                distribution = self.baseline.predict_distribution(window, self.horizon_s)
            except InsufficientData:
                as_of += step_ns
                continue

            future_price = price_at(as_of + horizon_ns)  # type: ignore[operator]
            if future_price is None or future_price <= 0.0:
                as_of += step_ns
                continue

            vector = compute_features(window, validate=False)
            feature_row = [vector.values[name] for name in FEATURE_NAMES]
            spot = distribution.spot
            sigma = distribution.sigma

            for z in self.z_grid:
                target = spot * math.exp(z * sigma)
                rows_as_of.append(as_of)
                rows_features.append(feature_row)
                rows_z.append(z)
                rows_p.append(distribution.prob_above(target))
                rows_label.append(1 if label_from_price(future_price, target) else 0)
                rows_spot.append(spot)
                rows_target.append(target)
                rows_sigma.append(sigma)
                rows_future.append(future_price)

            as_of += step_ns

        return Dataset(
            as_of_ns=np.asarray(rows_as_of, dtype=np.int64),
            features=np.asarray(rows_features, dtype=float).reshape(len(rows_as_of), -1)
            if rows_as_of
            else np.empty((0, len(FEATURE_NAMES))),
            z=np.asarray(rows_z, dtype=float),
            baseline_p=np.asarray(rows_p, dtype=float),
            label=np.asarray(rows_label, dtype=int),
            spot=np.asarray(rows_spot, dtype=float),
            target=np.asarray(rows_target, dtype=float),
            sigma=np.asarray(rows_sigma, dtype=float),
            future_price=np.asarray(rows_future, dtype=float),
            horizon_s=self.horizon_s,
            symbol=self.symbol,
            data_source=self.data_source,
        )

    def residuals(
        self, start_ns: int, end_ns: int, *, price_at: object, warmup_s: int = 3600
    ) -> tuple[list[float], list[tuple[int, float]]]:
        """Standardised residuals and (timestamp, variance) pairs.

        These fit the baseline itself — the residual shape and the weekly
        seasonal factors — and are collected separately from the target grid
        because they are one observation per instant, not one per target.
        """
        horizon_ns = self.horizon_s * NS_PER_SECOND
        step_ns = self.sample_interval_s * NS_PER_SECOND
        residual_values: list[float] = []
        variance_points: list[tuple[int, float]] = []

        as_of = start_ns + warmup_s * NS_PER_SECOND
        while as_of <= end_ns - horizon_ns:
            window = self.window_source.window(as_of)  # type: ignore[attr-defined]
            try:
                variance, _ = self.baseline.variance_per_second(window)
                distribution = self.baseline.predict_distribution(window, self.horizon_s)
            except InsufficientData:
                as_of += step_ns
                continue
            future_price = price_at(as_of + horizon_ns)  # type: ignore[operator]
            if future_price and future_price > 0.0 and distribution.sigma > 0.0:
                residual_values.append(
                    math.log(future_price / distribution.spot) / distribution.sigma
                )
                variance_points.append((as_of, variance))
            as_of += step_ns
        return residual_values, variance_points


def price_lookup(
    market_repo: object, symbol: str, *, source: DataSource, venue: str
) -> Callable[[int], float | None]:
    """A `price_at` function backed by the recorded feed.

    Deliberately a closure over the repository rather than a live call, so a
    dataset built today and one built next month from the same capture are
    identical.
    """

    def at(ns: int) -> float | None:
        trade = market_repo.last_trade_at_or_before(  # type: ignore[attr-defined]
            symbol, ns, source=source, venue=venue
        )
        return trade.price if trade is not None else None

    return at
