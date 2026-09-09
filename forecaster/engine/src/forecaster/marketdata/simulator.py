"""A market simulator, and an honest account of what it can and cannot prove.

This exists because the build environment for this project cannot reach any
exchange: every venue and every market-data aggregator is blocked by network
policy. Without a simulator there would be no way to exercise the pipeline at
all, so this module is what makes end-to-end verification possible.

That makes it dangerous, and the danger is worth naming precisely. A simulator
flatters a forecasting system in at least four ways:

1. **The generating process sits inside the model's hypothesis class.** The
   baseline assumes stochastic volatility with fat tails; this module produces
   exactly that. Calibration will look better here than it ever will live.
2. **It is stationary.** Real crypto is not. Purge-and-embargo looks unnecessary
   on data that never changes regime.
3. **Sample size is free.** Ten years generates in a minute, every confidence
   interval shrinks, and every model looks significantly better than every other.
4. **Whatever predictability is coded in gets discovered.** A simulator whose
   order flow predicts direction will "prove" an order-flow edge that does not
   exist in the real world.

The defences are structural, not aspirational:

* **`REALISTIC` contains no directional predictability at all.** Volatility is
  forecastable — that is true of real markets and is the honest source of the
  product's probabilities. Direction at a five-minute horizon is not, so the
  drift is exactly zero and order flow carries no information about the next
  price move. A model that appears to predict direction here has found a bug.
* **`MARTINGALE` is the null-alpha gate.** Zero drift, features that are pure
  noise. Any learner that beats the baseline on this data has leaked, and the
  build fails.
* **`GBM` has an analytic answer**, so the baseline can be checked against
  arithmetic rather than against itself.
* **`ALPHA` injects predictability of a known size**, which is how the minimum
  detectable effect gets measured instead of guessed.
* **`DIRTY` breaks the feed on purpose** — gaps, duplicates, crossed books,
  absurd prints — and the system must degrade rather than produce a number.

Nothing produced here is ever labelled anything but `DataSource.SIMULATED`, and
no aggregate mixes it with live data.
"""

from __future__ import annotations

import asyncio
import math
import random
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum

from forecaster.clock import now_ns  # noqa: F401  (kept for callers passing an explicit start)
from forecaster.marketdata.provider import MarketEvent, ProviderBase
from forecaster.types import (
    NS_PER_SECOND,
    BookLevel,
    BookSnapshot,
    DataSource,
    Quote,
    Side,
    Trade,
)

SECONDS_PER_YEAR = 365.0 * 24.0 * 3600.0

# A fixed anchor for generated timestamps.
#
# The simulator promises that the same seed produces the same market, and that
# promise is what makes the verification suite a regression test. Defaulting the
# start time to the wall clock quietly broke it: identical seeds gave different
# timestamps on every run. Callers that want a run ending at the present ask for
# it explicitly (`simulate --anchor-now`).
DEFAULT_START_NS = 1_788_912_000_000_000_000  # 2026-09-08T00:00:00Z


class Regime(StrEnum):
    """What the simulator is being asked to demonstrate."""

    GBM = "gbm"
    """Constant volatility, zero drift, no jumps. P(above) is analytic, so this
    is the known-answer test for the baseline."""

    REALISTIC = "realistic"
    """Stochastic, clustering volatility with jumps. Volatility is forecastable;
    direction is not, because it is not in real markets either."""

    MARTINGALE = "martingale"
    """The null-alpha gate. Zero drift, uninformative features. A learner that
    wins here has leaked."""

    ALPHA = "alpha"
    """Known predictability injected, for measuring the minimum detectable
    effect. Never used to demonstrate that the product works."""

    DIRTY = "dirty"
    """A deliberately broken feed. The system must refuse, not guess."""


@dataclass
class SimulatorParams:
    """Every knob, with the reasoning attached.

    Defaults sit near where major crypto pairs actually trade so the exercise is
    not trivially easy or trivially hard. They are not fitted to anything, and
    the code says so rather than implying calibration that did not happen.
    """

    regime: Regime = Regime.REALISTIC
    start_price: dict[str, float] = field(
        default_factory=lambda: {"BTC-USD": 79_434.27, "ETH-USD": 3_142.85}
    )
    annual_vol: float = 0.55
    """Roughly where BTC realized volatility has spent much of its life. Higher
    than equities by a wide margin, which is the point of the exercise."""

    vol_of_vol: float = 1.8
    """How much volatility itself moves. Drives the regime changes that make
    volatility forecastable and therefore make the product possible."""

    vol_mean_reversion: float = 4.0
    """Speed at which volatility returns to its long-run level, per year."""

    jump_intensity_per_day: float = 6.0
    jump_size_sigma: float = 0.0035
    """Jumps are a real feature of crypto microstructure and are what make the
    return distribution fat-tailed. Without them a Gaussian baseline would look
    better than it deserves to."""

    tick_interval_ns: int = NS_PER_SECOND
    trades_per_second_base: float = 3.5
    trade_size_mean: float = 0.045
    spread_bps_base: float = 1.2
    """Top-of-book spread in basis points at normal volatility. Widens with
    volatility, as real spreads do."""

    book_depth: int = 10
    book_level_size_mean: float = 1.4
    alpha_strength: float = 0.0
    """Only non-zero in ALPHA. The correlation deliberately planted between an
    observable and the next horizon return."""

    dirty_gap_probability: float = 0.004
    dirty_duplicate_probability: float = 0.004
    dirty_crossed_probability: float = 0.002
    dirty_outlier_probability: float = 0.001

    @classmethod
    def for_regime(cls, regime: Regime, **overrides: float) -> SimulatorParams:
        base = cls(regime=regime)
        if regime is Regime.GBM:
            base = cls(
                regime=regime,
                vol_of_vol=0.0,
                jump_intensity_per_day=0.0,
                vol_mean_reversion=0.0,
            )
        elif regime is Regime.MARTINGALE:
            base = cls(regime=regime, jump_intensity_per_day=0.0)
        elif regime is Regime.ALPHA:
            base = cls(regime=regime, alpha_strength=0.25)
        for key, value in overrides.items():
            setattr(base, key, value)
        return base


@dataclass
class _SymbolState:
    price: float
    log_vol: float
    """Log instantaneous volatility, so the process cannot go negative."""
    signal: float = 0.0
    """A persistent observable. In ALPHA it genuinely predicts the next return;
    in every other regime it is autocorrelated noise, present so that models have
    something plausible-looking to overfit if the harness lets them."""
    last_book_ns: int = 0
    sequence: int = 0


class SimulatedProvider(ProviderBase):
    """A deterministic, seeded market.

    Given the same seed and parameters this produces byte-identical output, which
    is what makes the verification suite a regression test rather than a mood.
    """

    def __init__(
        self,
        *,
        symbols: tuple[str, ...] = ("BTC-USD", "ETH-USD"),
        seed: int = 20260909,
        params: SimulatorParams | None = None,
        start_ns: int | None = None,
        duration_s: float | None = None,
        realtime: bool = False,
        book_snapshot_interval_ns: int = NS_PER_SECOND,
    ) -> None:
        super().__init__(
            venue="simulator",
            data_source=DataSource.SIMULATED,
            stale_after_ns=60 * NS_PER_SECOND,
            seed=seed,
        )
        self.params = params or SimulatorParams()
        self.symbols = symbols
        self.seed = seed
        self.duration_s = duration_s
        self.realtime = realtime
        self.book_snapshot_interval_ns = book_snapshot_interval_ns
        self._start_ns = start_ns if start_ns is not None else DEFAULT_START_NS
        self._rng = random.Random(seed)
        self._trade_counter = 0
        # Arrival times never go backwards. A real feed comes over one
        # connection and is delivered in order; independent per-event latency
        # would emit events out of arrival order, which no venue does and which
        # made the live and stored views of the same instant disagree.
        self._last_received_ns = 0
        long_run_vol = math.log(self.params.annual_vol)
        self._state = {
            sym: _SymbolState(
                price=self.params.start_price.get(sym, 1_000.0),
                log_vol=long_run_vol,
            )
            for sym in symbols
        }
        self._long_run_log_vol = long_run_vol

    # -- the price process ---------------------------------------------------

    def _step_symbol(self, state: _SymbolState, dt_s: float) -> None:
        """Advance one symbol by `dt_s` seconds.

        Volatility follows a mean-reverting process in logs (so it stays
        positive); the price is a driftless diffusion at that volatility, with
        occasional jumps. Zero drift is not a simplification — it is the honest
        null for a five-minute horizon, and building a drift in would let the
        product discover an edge that the simulator itself planted.
        """
        p = self.params
        dt_years = dt_s / SECONDS_PER_YEAR

        if p.vol_of_vol > 0.0:
            reversion = p.vol_mean_reversion * (self._long_run_log_vol - state.log_vol) * dt_years
            shock = p.vol_of_vol * math.sqrt(max(dt_years, 0.0)) * self._rng.gauss(0.0, 1.0)
            state.log_vol += reversion + shock
            state.log_vol = max(math.log(0.05), min(math.log(4.0), state.log_vol))

        vol = math.exp(state.log_vol)
        sigma_step = vol * math.sqrt(max(dt_years, 0.0))

        # The observable. Autocorrelated so it looks like a real market feature.
        decay = math.exp(-dt_s / 120.0)
        state.signal = decay * state.signal + math.sqrt(max(0.0, 1.0 - decay**2)) * self._rng.gauss(
            0.0, 1.0
        )

        drift = 0.0
        if p.regime is Regime.ALPHA:
            # The one regime where an observable genuinely predicts the return.
            # Used to measure what size of edge the harness can detect at all.
            drift = p.alpha_strength * sigma_step * state.signal

        shock = sigma_step * self._rng.gauss(0.0, 1.0)

        jump = 0.0
        if p.jump_intensity_per_day > 0.0:
            per_step = p.jump_intensity_per_day * dt_s / 86_400.0
            if self._rng.random() < per_step:
                jump = self._rng.gauss(0.0, p.jump_size_sigma)

        state.price *= math.exp(drift + shock + jump - 0.5 * sigma_step**2)

    def _spread(self, state: _SymbolState) -> float:
        """Spread widens with volatility, as it does in a real book."""
        vol_ratio = math.exp(state.log_vol) / self.params.annual_vol
        bps = self.params.spread_bps_base * (0.6 + 0.7 * vol_ratio)
        return max(0.01, state.price * bps / 10_000.0)

    def _receipt(self, exchange_ns: int) -> int:
        """Arrival time: exchange time plus latency, never earlier than the last."""
        candidate = exchange_ns + self._rng.randint(1_000_000, 40_000_000)
        self._last_received_ns = max(self._last_received_ns + 1, candidate)
        return self._last_received_ns

    def _make_quote(self, symbol: str, state: _SymbolState, ts: int) -> Quote:
        half = self._spread(state) / 2.0
        # Sizes are noisy and asymmetric, so book imbalance varies. In every
        # regime except ALPHA the asymmetry is unrelated to the next price move,
        # which is the honest position: imbalance predicts volatility and the
        # very next tick, not where price sits in five minutes.
        bid_size = max(
            0.01, self._rng.lognormvariate(math.log(self.params.book_level_size_mean), 0.7)
        )
        ask_size = max(
            0.01, self._rng.lognormvariate(math.log(self.params.book_level_size_mean), 0.7)
        )
        return Quote(
            exchange_ns=ts,
            received_ns=self._receipt(ts),
            symbol=symbol,
            bid=round(state.price - half, 2),
            bid_size=round(bid_size, 6),
            ask=round(state.price + half, 2),
            ask_size=round(ask_size, 6),
        )

    def _make_book(self, symbol: str, state: _SymbolState, ts: int) -> BookSnapshot:
        half = self._spread(state) / 2.0
        step = max(0.01, state.price * 0.00004)
        state.sequence += 1
        bids: list[BookLevel] = []
        asks: list[BookLevel] = []
        for level in range(self.params.book_depth):
            size_b = max(
                0.001,
                self._rng.lognormvariate(
                    math.log(self.params.book_level_size_mean * (1 + level * 0.35)), 0.6
                ),
            )
            size_a = max(
                0.001,
                self._rng.lognormvariate(
                    math.log(self.params.book_level_size_mean * (1 + level * 0.35)), 0.6
                ),
            )
            bids.append(BookLevel(round(state.price - half - level * step, 2), round(size_b, 6)))
            asks.append(BookLevel(round(state.price + half + level * step, 2), round(size_a, 6)))
        return BookSnapshot(
            exchange_ns=ts,
            received_ns=self._receipt(ts),
            symbol=symbol,
            bids=tuple(bids),
            asks=tuple(asks),
            sequence=state.sequence,
        )

    def _make_trades(self, symbol: str, state: _SymbolState, ts: int, dt_s: float) -> list[Trade]:
        """Trades arrive more often when volatility is high, as they do live."""
        vol_ratio = math.exp(state.log_vol) / self.params.annual_vol
        expected = self.params.trades_per_second_base * dt_s * (0.5 + 0.9 * vol_ratio)
        count = self._poisson(expected)
        half = self._spread(state) / 2.0
        out: list[Trade] = []
        for _ in range(count):
            buy = self._rng.random() < 0.5
            price = state.price + (half if buy else -half)
            size = max(0.0001, self._rng.lognormvariate(math.log(self.params.trade_size_mean), 1.1))
            self._trade_counter += 1
            out.append(
                Trade(
                    exchange_ns=ts,
                    received_ns=self._receipt(ts),
                    symbol=symbol,
                    price=round(price, 2),
                    size=round(size, 8),
                    side=Side.BUY if buy else Side.SELL,
                    trade_id=f"sim-{self._trade_counter}",
                )
            )
        return out

    def _poisson(self, lam: float) -> int:
        if lam <= 0.0:
            return 0
        if lam > 30.0:
            # Normal approximation; exact Knuth sampling underflows and is slow
            # at this intensity, and the difference is immaterial here.
            return max(0, round(self._rng.gauss(lam, math.sqrt(lam))))
        target = math.exp(-lam)
        product = 1.0
        count = 0
        while True:
            product *= self._rng.random()
            if product <= target:
                return count
            count += 1
            if count > 400:
                return count

    # -- the stream ----------------------------------------------------------

    async def _connect_and_yield(self, symbols: tuple[str, ...]) -> AsyncIterator[MarketEvent]:
        dt_ns = self.params.tick_interval_ns
        dt_s = dt_ns / NS_PER_SECOND
        ts = self._start_ns
        end_ns = (
            None
            if self.duration_s is None
            else self._start_ns + int(self.duration_s * NS_PER_SECOND)
        )
        dirty = self.params.regime is Regime.DIRTY

        while end_ns is None or ts < end_ns:
            for symbol in symbols:
                state = self._state[symbol]
                self._step_symbol(state, dt_s)

                if dirty and self._rng.random() < self.params.dirty_gap_probability:
                    # A gap: the feed simply stops for a while. Nothing is
                    # emitted, so the staleness clock is what has to catch it.
                    ts += dt_ns * self._rng.randint(30, 120)
                    continue

                quote = self._make_quote(symbol, state, ts)
                if dirty and self._rng.random() < self.params.dirty_crossed_probability:
                    quote = Quote(
                        exchange_ns=quote.exchange_ns,
                        received_ns=quote.received_ns,
                        symbol=symbol,
                        bid=quote.ask + 0.5,
                        bid_size=quote.bid_size,
                        ask=quote.bid - 0.5,
                        ask_size=quote.ask_size,
                    )
                yield quote

                for trade in self._make_trades(symbol, state, ts, dt_s):
                    if dirty and self._rng.random() < self.params.dirty_outlier_probability:
                        trade = Trade(
                            exchange_ns=trade.exchange_ns,
                            received_ns=trade.received_ns,
                            symbol=trade.symbol,
                            price=round(trade.price * self._rng.choice([0.85, 1.15]), 2),
                            size=trade.size,
                            side=trade.side,
                            trade_id=trade.trade_id,
                        )
                    yield trade
                    if dirty and self._rng.random() < self.params.dirty_duplicate_probability:
                        yield trade

                if ts - state.last_book_ns >= self.book_snapshot_interval_ns:
                    state.last_book_ns = ts
                    yield self._make_book(symbol, state, ts)

            ts += dt_ns
            if self.realtime:
                await asyncio.sleep(dt_s)
            else:
                # Yield to the loop periodically so a long generation does not
                # starve the evaluator or the API in the same process.
                if (ts // dt_ns) % 64 == 0:
                    await asyncio.sleep(0)

    def analytic_prob_above(self, symbol: str, target: float, horizon_s: int) -> float:
        """The true probability from the simulator's CURRENT price.

        Only meaningful while the simulation is paused at the instant of
        interest. A forecast made partway through a run must use
        `analytic_prob_above_from` with that instant's price instead — otherwise
        the "true" answer is computed from a price hundreds of seconds later,
        which is not a known-answer test at all.
        """
        return self.analytic_prob_above_from(
            self._state[symbol].price, target, horizon_s, symbol=symbol
        )

    def analytic_prob_above_from(
        self, spot: float, target: float, horizon_s: int, *, symbol: str = "BTC-USD"
    ) -> float:
        """The true probability for a given starting price.

        Available only in the GBM regime, where volatility is constant and the
        answer has a closed form. This is what lets the baseline be checked
        against arithmetic rather than against its own output.
        """
        if self.params.regime is not Regime.GBM:
            raise ValueError("an analytic answer exists only in the GBM regime")
        vol = math.exp(self._state[symbol].log_vol)
        sigma = vol * math.sqrt(horizon_s / SECONDS_PER_YEAR)
        z = (math.log(target / spot) + 0.5 * sigma**2) / sigma
        return 0.5 * math.erfc(z / math.sqrt(2.0))

    def current_price(self, symbol: str) -> float:
        return self._state[symbol].price

    def current_vol(self, symbol: str) -> float:
        return math.exp(self._state[symbol].log_vol)
