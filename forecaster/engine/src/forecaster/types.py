"""The vocabulary of the system.

Every type here is frozen and framework-free. Nothing in this module knows about
an exchange, a database or a model — those layers import this one, never the
reverse. The point is that a `Forecast` produced by the live server and a
`Forecast` produced by the backtester are the same object, so there is exactly
one definition of what a forecast *is* and no room for the two paths to drift.

Time is nanoseconds since the Unix epoch, as an int, everywhere. Floats lose
precision at microsecond scale for present-day epochs, and a forecasting system
that is sloppy about time is a forecasting system that leaks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

NS_PER_SECOND = 1_000_000_000
NS_PER_MINUTE = 60 * NS_PER_SECOND

PROB_FLOOR = 1e-4
"""The closest to certainty this system will ever state.

A probability of exactly zero or one is a claim of knowledge about the future.
It also makes log loss infinite, so one such row would poison an entire
aggregate. Enforced by the models, and again by a database constraint.
"""

# The two horizons the product forecasts, in seconds.
HORIZONS_S: tuple[int, ...] = (300, 1200)

Symbol = Literal["BTC-USD", "ETH-USD"]
SYMBOLS: tuple[Symbol, ...] = ("BTC-USD", "ETH-USD")


class Side(StrEnum):
    """Which side of the book the aggressor took.

    `UNKNOWN` is a real and common state: several venues publish trades without
    an aggressor flag. Guessing from the tick rule would fabricate a feature, so
    order-flow features report their own coverage instead and the confidence
    layer reads it.
    """

    BUY = "buy"
    SELL = "sell"
    UNKNOWN = "unknown"


class DataSource(StrEnum):
    """Where the market data underneath a number came from.

    This is the honesty axis of the whole system. It is stored on every
    prediction, every model artifact and every metric, and aggregates are never
    computed across more than one value of it.
    """

    LIVE = "live"
    REPLAY = "replay"
    SIMULATED = "simulated"


class PredictionMode(StrEnum):
    """Whether a prediction was made in anger or reconstructed after the fact.

    Backfilled predictions are essential for backtesting and worthless as a
    track record. Keeping them in the same table without this flag would let a
    retrospective run quietly inflate the live accuracy figure.
    """

    LIVE = "live"
    BACKFILL = "backfill"


class Outcome(StrEnum):
    """How a prediction resolved.

    `STALE_*` means the evaluation price was older than preferred but inside the
    tolerated bound; it counts toward accuracy and is reported separately.
    `VOID_*` means no defensible price existed and the forecast is excluded —
    which is a selection bias, because feeds drop when volatility spikes, so the
    void rate is reported per volatility decile and accuracy is also reported
    under both worst-case and best-case void assumptions.
    """

    ABOVE = "above"
    BELOW = "below"
    STALE_ABOVE = "stale_above"
    STALE_BELOW = "stale_below"
    VOID_GAP = "void_gap"
    VOID_HALT = "void_halt"

    @property
    def is_resolved(self) -> bool:
        return self in (Outcome.ABOVE, Outcome.BELOW, Outcome.STALE_ABOVE, Outcome.STALE_BELOW)

    @property
    def went_above(self) -> bool:
        return self in (Outcome.ABOVE, Outcome.STALE_ABOVE)


class Confidence(StrEnum):
    """How much the system trusts its own number.

    Deliberately does NOT change the probability. A LOW-confidence 62% must
    still be right 62% of the time, and shrinking it toward 50% would break both
    calibration and the guarantee that probability falls as the target rises.
    Confidence changes the label and the warnings, never the number.
    """

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class ServiceLevel(StrEnum):
    """The degradation ladder.

    Automatic, not a human decision. A bad feed must reduce what the system
    claims rather than silently producing a number from stale inputs.
    """

    FULL = "full"
    DEGRADED = "degraded"
    STALE = "stale"
    DOWN = "down"


@dataclass(frozen=True, slots=True)
class Trade:
    """One executed trade.

    Two timestamps, always. `exchange_ns` is when the venue says it happened and
    is what outcomes are resolved against; `received_ns` is when this process saw
    it and is what feature windows close on. Mixing them creates a leak that is
    negligible for a 20-minute outcome and very much not negligible for a
    microstructure feature measured over the last two seconds.
    """

    exchange_ns: int
    received_ns: int
    symbol: str
    price: float
    size: float
    side: Side
    trade_id: str


@dataclass(frozen=True, slots=True)
class Quote:
    """Top of book at a point in time."""

    exchange_ns: int
    received_ns: int
    symbol: str
    bid: float
    bid_size: float
    ask: float
    ask_size: float

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2.0

    @property
    def spread(self) -> float:
        return self.ask - self.bid

    @property
    def microprice(self) -> float:
        """Size-weighted mid.

        Leans toward the side with less size behind it, which is the side price
        is more likely to move to. Degrades to the plain mid when both sides are
        empty rather than dividing by zero.
        """
        total = self.bid_size + self.ask_size
        if total <= 0.0:
            return self.mid
        return (self.bid * self.ask_size + self.ask * self.bid_size) / total


@dataclass(frozen=True, slots=True)
class BookLevel:
    price: float
    size: float


@dataclass(frozen=True, slots=True)
class BookSnapshot:
    """Top N levels of the order book.

    Sampled rather than streamed. A full level-2 delta stream for one pair is
    of the order of a gigabyte a day, which SQLite should not be asked to hold;
    a periodic top-N snapshot carries almost all of the signal available at a
    five-minute horizon for a tiny fraction of the volume. `ARCHITECTURE.md`
    records this trade-off and what it would take to reverse it.
    """

    exchange_ns: int
    received_ns: int
    symbol: str
    bids: tuple[BookLevel, ...]
    asks: tuple[BookLevel, ...]
    sequence: int | None = None

    @property
    def is_crossed(self) -> bool:
        """A crossed book is corrupt data, not an arbitrage."""
        if not self.bids or not self.asks:
            return False
        return self.bids[0].price >= self.asks[0].price


@dataclass(frozen=True, slots=True)
class Bar:
    """An OHLCV bar with the flow breakdown the features need."""

    open_ns: int
    resolution_s: int
    symbol: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    buy_volume: float
    sell_volume: float
    trade_count: int
    vwap: float


@dataclass(frozen=True, slots=True)
class FeatureVector:
    """Features as of an instant, with the instant attached.

    `as_of_ns` is the information cutoff: no input to any value in `values` may
    postdate it. `lookback_ns` is the oldest data any feature consulted, which
    the leakage checker uses to prove the window is closed, and the data-quality
    layer uses to know how much history a forecast actually rested on.
    """

    as_of_ns: int
    symbol: str
    values: dict[str, float]
    lookback_ns: int
    feature_set_version: str

    def vector(self, names: tuple[str, ...]) -> list[float]:
        """Order values by an explicit name tuple.

        Never `dict.values()`. Feature order is part of a model's identity, and
        relying on insertion order is how a model silently starts reading
        volatility out of the spread column.
        """
        return [self.values[name] for name in names]


@dataclass(frozen=True, slots=True)
class Distribution:
    """A forecast of where the price will be, as a distribution.

    Everything the product shows is read off this one object: the probability
    for the user's target, the median, and the expected range. That is
    deliberate. Deriving the probability and the range from two different models
    is how a system ends up telling the user there is a 70% chance of being above
    a price that sits outside its own predicted range.
    """

    as_of_ns: int
    horizon_s: int
    spot: float
    mu: float
    """Mean of the horizon log return. Very close to zero at these horizons, and
    the system is suspicious of anything else."""
    sigma: float
    """Standard deviation of the horizon log return."""

    def prob_above(self, target: float) -> float:
        raise NotImplementedError  # supplied by the model layer

    def quantile(self, q: float) -> float:
        raise NotImplementedError  # supplied by the model layer


@dataclass(frozen=True, slots=True)
class SignalContribution:
    """One line of the "why" shown under a forecast.

    `direction` is which way this signal pushes the ABOVE probability, and
    `weight` is how hard, on a 0-1 scale relative to the other contributions
    shown. Both are derived from the model, never written by hand.
    """

    name: str
    label: str
    direction: Literal["above", "below", "neutral"]
    weight: float
    detail: str


@dataclass(frozen=True, slots=True)
class Forecast:
    """A single answer to a single question, with everything needed to score it.

    Deliberately carries the full feature snapshot and the model version. A
    forecast that cannot be reproduced from what was stored alongside it is a
    forecast that cannot be audited, and an unauditable track record is
    marketing.
    """

    as_of_ns: int
    eval_at_ns: int
    horizon_s: int
    symbol: str
    venue: str
    spot: float
    target: float
    p_above: float
    z: float
    """Distance to target in standard deviations of the horizon return. The
    single most important number in the system: it, not the model, is what makes
    a probability far from 50%."""
    sigma: float
    range_low: float
    range_high: float
    range_confidence: float
    median: float
    confidence: Confidence
    confidence_reasons: tuple[str, ...]
    service_level: ServiceLevel
    model_version: str
    model_train_source: DataSource
    calibration_source: DataSource | None
    data_source: DataSource
    prediction_mode: PredictionMode
    features: FeatureVector
    contributions: tuple[SignalContribution, ...] = field(default_factory=tuple)

    @property
    def p_below(self) -> float:
        """Always exactly one minus the above probability.

        Never a second model output. Two independently produced numbers that are
        supposed to sum to one will eventually not sum to one, and the day they
        do not is the day the product stops being believable.
        """
        return 1.0 - self.p_above

    @property
    def distance(self) -> float:
        return self.target - self.spot

    @property
    def distance_pct(self) -> float:
        return (self.target / self.spot - 1.0) * 100.0
