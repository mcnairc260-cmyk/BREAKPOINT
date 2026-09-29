"""The feature set.

Eleven numbers, chosen against a hard constraint: overlapping labels mean the
effective sample size is far smaller than the row count. One day of one-second
sampling gives 288 genuinely independent five-minute observations and 72
twenty-minute ones. With sample sizes like that, a wide feature set does not find
more signal — it finds more noise, more convincingly.

So the set is small, and every member is here for a stated reason. Notably
absent: RSI, MACD, Bollinger bands, stochastics. Not out of snobbery — they are
deterministic functions of a price path that realized volatility and returns
already summarise, so they add parameters without adding information, and the
brief explicitly warns against dumping indicators in because they exist.

The twelfth input, `z`, is not here. It depends on the user's target price and so
is not a property of the market; it is added at prediction time.
"""

from __future__ import annotations

import math

from forecaster.features.registry import REGISTRY, register
from forecaster.features.volatility import (
    MIN_OBSERVATIONS,
    bipower_variation_per_second,
    log_returns,
    realized_variance_per_second,
    semivariance_ratio,
)
from forecaster.features.window import MarketWindow
from forecaster.marketdata.book import imbalance, microprice_deviation
from forecaster.types import NS_PER_SECOND, Bar, FeatureVector, Side

FEATURE_SET_VERSION = "fs-1"

# A sentinel for "this could not be computed", distinct from any plausible real
# value. Models see it as a genuine category — data was missing — rather than as
# a zero that means something else.
MISSING = -99.0


def _bars_in(window: MarketWindow, seconds: int) -> list[Bar]:
    floor_ns = window.as_of_ns - seconds * NS_PER_SECOND
    return [b for b in window.bars_1s if b.open_ns >= floor_ns]


def _log_rv(window: MarketWindow, seconds: int) -> float:
    """Log realized variance per second over a trailing window.

    Logged because volatility is roughly log-normal: in logs the feature is
    near-symmetric and a tree does not have to spend splits on the scale.
    """
    returns = log_returns(_bars_in(window, seconds))
    variance = realized_variance_per_second(returns, 1.0)
    if variance is None or variance <= 0.0:
        return MISSING
    return math.log(variance)


@register(
    "log_rv_1m",
    lookback_s=60,
    tier=1,
    rationale="Volatility right now. Reacts within seconds to a burst, which is what "
    "makes the five-minute forecast responsive.",
)
def log_rv_1m(window: MarketWindow) -> float:
    return _log_rv(window, 60)


@register(
    "log_rv_5m",
    lookback_s=300,
    tier=1,
    rationale="Volatility at the five-minute horizon's own scale. The single most "
    "important input to the shorter forecast.",
)
def log_rv_5m(window: MarketWindow) -> float:
    return _log_rv(window, 300)


@register(
    "log_rv_60m",
    lookback_s=3600,
    tier=1,
    rationale="The stable component. Noisy short-window estimates get pulled toward "
    "this, which is most of why the twenty-minute forecast is usable at all.",
)
def log_rv_60m(window: MarketWindow) -> float:
    return _log_rv(window, 3600)


@register(
    "rv_ratio_1m_60m",
    lookback_s=3600,
    tier=1,
    rationale="Is volatility expanding or contracting? The level says how wide the "
    "distribution is; this says which way it is heading.",
)
def rv_ratio_1m_60m(window: MarketWindow) -> float:
    fast = _log_rv(window, 60)
    slow = _log_rv(window, 3600)
    if fast == MISSING or slow == MISSING:
        return MISSING
    return max(-4.0, min(4.0, fast - slow))


@register(
    "bipower_ratio_60m",
    lookback_s=3600,
    tier=1,
    rationale="Share of recent movement that was continuous rather than jumps. "
    "Continuous volatility persists; jump volatility does not, so a model that "
    "cannot separate them over-forecasts width right after a spike.",
)
def bipower_ratio_60m(window: MarketWindow) -> float:
    returns = log_returns(_bars_in(window, 3600))
    total = realized_variance_per_second(returns, 1.0)
    continuous = bipower_variation_per_second(returns, 1.0)
    if total is None or continuous is None or total <= 0.0:
        return MISSING
    return max(0.0, min(1.5, continuous / total))


@register(
    "semivar_ratio_60m",
    lookback_s=3600,
    tier=2,
    rationale="How much of the variance came from downward moves. Asymmetry shifts "
    "the shape of the distribution, which matters when the target sits on one side.",
)
def semivar_ratio_60m(window: MarketWindow) -> float:
    ratio = semivariance_ratio(log_returns(_bars_in(window, 3600)))
    return MISSING if ratio is None else ratio


@register(
    "ret_1m",
    lookback_s=60,
    tier=2,
    rationale="Recent return in volatility units. Expected to carry almost no "
    "directional signal at these horizons — it is kept as a control, so the "
    "validation harness has an honest chance to report that momentum does nothing.",
)
def ret_1m(window: MarketWindow) -> float:
    bars = _bars_in(window, 60)
    if len(bars) < MIN_OBSERVATIONS:
        return MISSING
    first, last = bars[0].close, bars[-1].close
    if first <= 0.0 or last <= 0.0:
        return MISSING
    variance = realized_variance_per_second(log_returns(bars), 1.0)
    if variance is None or variance <= 0.0:
        return MISSING
    sigma = math.sqrt(variance * 60.0)
    if sigma <= 0.0:
        return MISSING
    return max(-6.0, min(6.0, math.log(last / first) / sigma))


@register(
    "rel_spread_bps",
    lookback_s=60,
    tier=1,
    rationale="Bid-ask spread in basis points, averaged over a minute. Proxies both "
    "volatility and liquidity, and a widening spread is often the first sign that "
    "the next few minutes will be rougher than the last few.",
)
def rel_spread_bps(window: MarketWindow) -> float:
    floor_ns = window.as_of_ns - 60 * NS_PER_SECOND
    quotes = [q for q in window.quotes if q.received_ns >= floor_ns and q.mid > 0.0]
    if not quotes:
        return MISSING
    values = [q.spread / q.mid * 10_000.0 for q in quotes if q.spread > 0.0]
    if not values:
        return MISSING
    return max(0.0, min(500.0, sum(values) / len(values)))


@register(
    "book_imbalance_top5",
    lookback_s=5,
    tier=2,
    rationale="Depth imbalance over the top five levels. Genuinely predictive over "
    "seconds; expected to fade to nothing by five minutes. Included so the harness "
    "can measure that decay rather than assume it either way.",
)
def book_imbalance_top5(window: MarketWindow) -> float:
    if window.book is None or window.book.is_crossed:
        return MISSING
    return imbalance(window.book, levels=5)


@register(
    "microprice_dev_bps",
    lookback_s=5,
    tier=2,
    rationale="Where the size-weighted price sits relative to the mid. The cleanest "
    "single read of immediate pressure at the touch.",
)
def microprice_dev_bps(window: MarketWindow) -> float:
    if window.book is None or window.book.is_crossed:
        return MISSING
    return max(-50.0, min(50.0, microprice_deviation(window.book)))


@register(
    "signed_flow_5m",
    lookback_s=300,
    tier=2,
    rationale="Net aggressive buying minus selling, as a share of volume. Real "
    "information about who is impatient. Reports MISSING rather than zero when the "
    "venue does not publish an aggressor flag, because 'balanced' and 'unknown' are "
    "not the same thing.",
)
def signed_flow_5m(window: MarketWindow) -> float:
    floor_ns = window.as_of_ns - 300 * NS_PER_SECOND
    trades = [t for t in window.trades if t.received_ns >= floor_ns]
    if len(trades) < MIN_OBSERVATIONS:
        return MISSING
    known = [t for t in trades if t.side is not Side.UNKNOWN]
    if len(known) < len(trades) * 0.5:
        return MISSING
    buys = sum(t.size for t in known if t.side is Side.BUY)
    sells = sum(t.size for t in known if t.side is Side.SELL)
    total = buys + sells
    if total <= 0.0:
        return MISSING
    return (buys - sells) / total


@register(
    "rel_volume_5m",
    lookback_s=3600,
    tier=2,
    rationale="Volume over the last five minutes against the last hour's typical "
    "five minutes. Activity leads volatility, so an unusual surge is a warning that "
    "the trailing volatility estimate is about to be too low.",
)
def rel_volume_5m(window: MarketWindow) -> float:
    recent = _bars_in(window, 300)
    baseline = _bars_in(window, 3600)
    if len(recent) < MIN_OBSERVATIONS or len(baseline) < 300:
        return MISSING
    recent_volume = sum(b.volume for b in recent)
    baseline_volume = sum(b.volume for b in baseline)
    if baseline_volume <= 0.0:
        return MISSING
    expected = baseline_volume * (len(recent) / len(baseline))
    if expected <= 0.0:
        return MISSING
    return max(0.0, min(10.0, recent_volume / expected))


# Order is fixed and is part of every model's identity. Appending is safe;
# reordering silently feeds a trained model the wrong columns.
FEATURE_NAMES: tuple[str, ...] = (
    "log_rv_1m",
    "log_rv_5m",
    "log_rv_60m",
    "rv_ratio_1m_60m",
    "bipower_ratio_60m",
    "semivar_ratio_60m",
    "ret_1m",
    "rel_spread_bps",
    "book_imbalance_top5",
    "microprice_dev_bps",
    "signed_flow_5m",
    "rel_volume_5m",
)


def compute_features(window: MarketWindow, *, validate: bool = True) -> FeatureVector:
    """The one feature function.

    Called identically by the live server and by the training pipeline. There is
    no batch variant and no vectorised shortcut, because two implementations of
    "what the model sees" is how training-serving skew gets in.
    """
    if validate:
        window.validate_causality()
    values = {name: REGISTRY[name].fn(window) for name in FEATURE_NAMES}
    return FeatureVector(
        as_of_ns=window.as_of_ns,
        symbol=window.symbol,
        values=values,
        lookback_ns=window.as_of_ns - window.oldest_ns(),
        feature_set_version=FEATURE_SET_VERSION,
    )


def coverage(vector: FeatureVector) -> float:
    """Share of features that were actually computable.

    Read by the confidence layer. A forecast resting on four of twelve features
    is a weaker forecast, and the product should say so rather than present it
    identically to one resting on all twelve.
    """
    if not vector.values:
        return 0.0
    present = sum(1 for v in vector.values.values() if v != MISSING)
    return present / len(vector.values)
