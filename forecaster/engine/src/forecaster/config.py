"""Configuration, and the reasons behind the numbers.

Every threshold in the system lives here rather than at its use site, so the
tuning surface of the product is one readable file instead of a scavenger hunt.
Values that are guesses are labelled as guesses. Several of them cannot be set
honestly until real market data exists, and those are marked PLACEHOLDER — the
forecaster refuses to describe a placeholder threshold as empirical.

Secrets are never here. Market data from the default venue needs no key at all,
which is why that venue is the default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from forecaster.types import NS_PER_SECOND


def _env_str(name: str, default: str) -> str:
    return os.environ.get(name, default).strip() or default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return float(raw)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class QualityConfig:
    """When data is too poor to forecast on.

    The ladder is deliberately conservative. Refusing to answer is a recoverable
    product failure; answering from a stale book is not.
    """

    quote_stale_degraded_ns: int = 5 * NS_PER_SECOND
    """Past this, the top of book is old enough to distrust the microstructure
    features but not the price. Service drops to DEGRADED (baseline only)."""

    quote_stale_halt_ns: int = 30 * NS_PER_SECOND
    """Past this, nothing is forecast."""

    trade_stale_halt_ns: int = 120 * NS_PER_SECOND
    """Crypto never stops trading. Two minutes without a print on a major pair
    means the feed is broken, not that the market is quiet."""

    min_history_ns: int = 30 * 60 * NS_PER_SECOND
    """Volatility over the last hour cannot be estimated from ten minutes of
    data. Below this, the system says so instead of extrapolating."""

    max_return_sigma: float = 12.0
    """A single print this many robust deviations away is suspect. Real 12-sigma
    moves exist; they also arrive as a sequence of prints, not one.

    Not sufficient on its own — see `min_anomaly_return`."""

    min_anomaly_return: float = 0.004
    """A print must ALSO move the price by at least this fraction (0.4%) before
    it is treated as an error.

    Without this the filter fires constantly. At one-second resolution most
    measured variation is bid-ask bounce, so the robust deviation is tiny and an
    ordinary 0.05% move registers as "50 sigma". A real run discarded 17% of all
    trades that way before this floor was added."""

    max_consecutive_rejections: int = 3
    """After this many rejections in a row, accept and resynchronise.

    A rejected trade leaves the reference price behind, so the next trade is
    measured from a stale price and looks just as extreme — and the filter
    discards the rest of the feed, silently, forever. A filter rejecting
    everything is wrong about the market, not the other way round, so it fails
    open and raises an alarm."""

    max_relative_spread: float = 0.01
    """A 1% spread on BTC-USD means the book is broken or the venue is in
    trouble. Either way the microstructure features are meaningless."""

    eval_staleness_ok_ns: int = 2 * NS_PER_SECOND
    """An evaluation price this fresh resolves cleanly."""

    eval_staleness_max_ns: int = 60 * NS_PER_SECOND
    """Older than fresh but inside this bound resolves as STALE_* — it counts,
    and is reported separately. Beyond it the forecast is VOID, which is a
    selection bias tracked explicitly, because feeds drop when markets move."""


@dataclass(frozen=True)
class ModelConfig:
    """Model and calibration settings."""

    ewma_lambda_fast: float = 0.97
    """One-second returns. Half-life of about 23 seconds."""

    ewma_lambda_slow: float = 0.999
    """Half-life of about 12 minutes, which is the scale the 20-minute forecast
    actually cares about."""

    har_windows_s: tuple[int, ...] = (60, 300, 3600, 86400)
    """Heterogeneous autoregressive volatility components. Realized volatility
    at several horizons beats any single window, and this is the cheapest
    well-evidenced improvement available."""

    residual_pool_min: int = 2_000
    """Standardized residuals needed before the empirical (filtered historical
    simulation) shape is used instead of the Student-t fallback. Pooled across
    all times, so this fills far faster than any per-bucket estimate."""

    gpd_tail_quantile: float = 0.95
    """Beyond this quantile of |standardized residual|, a generalized Pareto
    tail is spliced on. Without it the far tail is either zero (empirical) or an
    assumption (Gaussian), and the far tail is exactly where a user setting an
    ambitious target lands."""

    student_t_df: float = 4.0
    """Fallback tail thickness before enough residuals exist. Crypto returns at
    minute scale are consistently fatter than Gaussian; 4 is conservative and
    widely reported. Replaced by the fitted shape as soon as it is available."""

    min_probability: float = 1e-4
    """Hard floor. A probability of exactly zero is a claim of certainty, and it
    also makes log loss infinite. Enforced again as a database constraint."""

    z_calibrated_max: float = 3.0
    """Beyond this many standard deviations, the calibration set has too few
    events to say anything, so the learner is switched off, the parametric model
    answers, and confidence is forced to LOW with reason EXTRAPOLATION.
    Recomputed from data once a calibration slice exists."""

    display_range_confidence: float = 0.80
    """The "expected range" shown to the user is an 80% interval, and the UI
    says so. An unlabelled range is an invitation to read it as certainty."""


@dataclass(frozen=True)
class ConfidenceConfig:
    """Thresholds for the LOW / MODERATE / HIGH label.

    PLACEHOLDER. These cannot be set honestly without live data: the whole point
    of the label is that the buckets show measurably different Brier scores, and
    that can only be measured. Until then the label is derived from data-quality
    signals only, `MODEL.md` says the thresholds are provisional, and the
    statistics page shows whether the buckets actually separate.
    """

    novelty_moderate: float = 3.0
    novelty_high: float = 6.0
    """Mahalanobis distance of the current features from the training
    distribution. Beyond the high threshold the market does not resemble
    anything the model learned from and the UI says so."""

    disagreement_moderate: float = 0.05
    disagreement_high: float = 0.12
    """Absolute gap between the baseline and the learner. Wide disagreement
    means at least one of them is wrong and the system does not know which."""

    spread_percentile_warn: float = 0.90
    depth_percentile_warn: float = 0.10
    is_placeholder: bool = True


@dataclass(frozen=True)
class Config:
    database_url: str = field(
        default_factory=lambda: _env_str("FORECASTER_DB", "sqlite:///./data/forecaster.db")
    )
    provider: str = field(default_factory=lambda: _env_str("FORECASTER_PROVIDER", "simulated"))
    """Defaults to the simulator, deliberately. A misconfigured deployment that
    silently produced live-looking numbers from an unknown source would be the
    worst possible failure; a simulator that announces itself is the safest."""

    venue: str = field(default_factory=lambda: _env_str("FORECASTER_VENUE", "coinbase"))
    transport: str = field(default_factory=lambda: _env_str("FORECASTER_TRANSPORT", "websocket"))
    """`websocket` or `poll`. The polling transport is not a toy: websocket
    upgrades are blocked on plenty of corporate networks and in this project's
    own build environment."""

    symbols: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            s.strip()
            for s in _env_str("FORECASTER_SYMBOLS", "BTC-USD,ETH-USD").split(",")
            if s.strip()
        )
    )
    data_dir: Path = field(default_factory=lambda: Path(_env_str("FORECASTER_DATA_DIR", "./data")))
    artifact_dir: Path = field(
        default_factory=lambda: Path(_env_str("FORECASTER_ARTIFACT_DIR", "./artifacts"))
    )
    book_depth: int = field(default_factory=lambda: _env_int("FORECASTER_BOOK_DEPTH", 10))
    book_snapshot_interval_ns: int = field(
        default_factory=lambda: _env_int("FORECASTER_BOOK_SNAPSHOT_MS", 1000) * 1_000_000
    )
    bar_resolutions_s: tuple[int, ...] = (1, 5, 15, 60, 300)
    allow_ml_live: bool = field(
        default_factory=lambda: _env_bool("FORECASTER_ALLOW_ML_LIVE", False)
    )
    """The quarantine switch. Off by default: a model trained on simulated data
    must not serve a live forecast just because it exists. Turning this on with
    a simulator-trained model still forces a warning through to the UI."""

    seed: int = field(default_factory=lambda: _env_int("FORECASTER_SEED", 20260909))
    quality: QualityConfig = field(default_factory=QualityConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    confidence: ConfidenceConfig = field(default_factory=ConfidenceConfig)

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.artifact_dir.mkdir(parents=True, exist_ok=True)


def load_config() -> Config:
    return Config()
