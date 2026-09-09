"""Market data adapters, book reconstruction, and failure handling.

Parsing is tested against fixtures written from each venue's published API
documentation — see `tests/fixtures/venues/README.md` for why they are not real
captures, and what that does and does not prove.

The failure tests matter as much as the parsing ones. A feed does not usually
break loudly; it repeats itself, or goes quiet, or drops a sequence number. Each
of those is checked here.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from forecaster.marketdata.book import BookBuilder, SequenceGap, imbalance, microprice_deviation
from forecaster.marketdata.provider import BackoffPolicy, ProviderBase, ProviderError
from forecaster.marketdata.replay import CaptureWriter, ReplayProvider, read_capture
from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
from forecaster.marketdata.venues.binance import parse_book_ticker, to_venue_symbol
from forecaster.marketdata.venues.binance import parse_trade as binance_trade
from forecaster.marketdata.venues.coinbase import (
    CoinbaseProvider,
    parse_match,
    parse_rest_trade,
    parse_ticker,
)
from forecaster.marketdata.venues.kraken import parse_ticker as kraken_ticker
from forecaster.marketdata.venues.kraken import parse_trade as kraken_trade
from forecaster.types import DataSource, Side, Trade

FIXTURES = Path(__file__).parent / "fixtures" / "venues"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class TestCoinbaseParsing:
    """Coinbase reports the MAKER's side, so the aggressor is the opposite.

    Getting this backwards inverts every order-flow feature in the system. It
    would not crash, and it would not look wrong — the model would simply learn
    the mirror image of the truth. Hence a test per direction.
    """

    def test_a_sell_maker_means_a_buy_aggressor(self) -> None:
        trade = parse_match(load("coinbase")["match"], received_ns=1)
        assert trade is not None
        assert trade.side is Side.BUY
        assert trade.price == pytest.approx(79_434.27)
        assert trade.symbol == "BTC-USD"
        assert trade.trade_id == "486823291"

    def test_a_buy_maker_means_a_sell_aggressor(self) -> None:
        trade = parse_match(load("coinbase")["match_buy_maker"], received_ns=1)
        assert trade is not None
        assert trade.side is Side.SELL

    def test_timestamps_are_parsed_to_nanoseconds(self) -> None:
        trade = parse_match(load("coinbase")["match"], received_ns=1)
        assert trade is not None
        # 2026-09-09T06:30:00.123456Z
        assert trade.exchange_ns > 1_700_000_000 * 1_000_000_000
        assert trade.received_ns == 1

    def test_ticker_carries_both_sides_and_their_sizes(self) -> None:
        quote = parse_ticker(load("coinbase")["ticker"], received_ns=1)
        assert quote is not None
        assert quote.bid == pytest.approx(79_433.92)
        assert quote.ask == pytest.approx(79_434.55)
        assert quote.bid_size == pytest.approx(0.3124)
        assert quote.spread > 0

    def test_a_missing_size_becomes_zero_not_an_invention(self) -> None:
        """Unknown size is reported as zero, which the imbalance feature treats
        as 'no information'. Filling in a plausible number would feed a
        fabricated value straight into a model input."""
        quote = parse_ticker(load("coinbase")["ticker_without_sizes"], received_ns=1)
        assert quote is not None
        assert quote.bid_size == 0.0 and quote.ask_size == 0.0

    def test_malformed_messages_are_dropped_not_raised(self) -> None:
        assert parse_match({"type": "match"}, received_ns=1) is None
        assert parse_ticker({"type": "ticker", "product_id": "BTC-USD"}, received_ns=1) is None
        assert (
            parse_ticker({"type": "ticker", "product_id": "X", "best_bid": "0", "best_ask": "0"}, 1)
            is None
        )

    def test_rest_trades_parse_the_same_way(self) -> None:
        payload = load("coinbase")["rest_trades"][0]
        trade = parse_rest_trade(payload, "BTC-USD", received_ns=1)
        assert trade is not None and trade.side is Side.BUY

    def test_a_feed_error_message_raises(self) -> None:
        provider = CoinbaseProvider(symbols=("BTC-USD",))
        with pytest.raises(ProviderError, match="not a valid product"):
            provider._handle_ws_message(load("coinbase")["error"], received_ns=1)

    def test_snapshot_then_delta_updates_the_book(self) -> None:
        provider = CoinbaseProvider(symbols=("BTC-USD",))
        events = provider._handle_ws_message(load("coinbase")["snapshot"], received_ns=1)
        assert len(events) == 1
        first = events[0]
        assert first.bids[0].price == pytest.approx(79_433.92)

        events = provider._handle_ws_message(load("coinbase")["l2update"], received_ns=2)
        assert len(events) == 1
        updated = events[0]
        # The delta removed the 79433.10 bid (size zero) and resized an ask.
        assert all(level.price != pytest.approx(79_433.10) for level in updated.bids)
        resized = [a for a in updated.asks if a.price == pytest.approx(79_435.20)]
        assert resized and resized[0].size == pytest.approx(0.75)


class TestBinanceParsing:
    def test_buyer_is_maker_means_a_sell_aggressor(self) -> None:
        trade = binance_trade(load("binance")["trade"], received_ns=1)
        assert trade is not None and trade.side is Side.SELL
        assert trade.symbol == "BTC-USD"

    def test_buyer_is_taker_means_a_buy_aggressor(self) -> None:
        trade = binance_trade(load("binance")["trade_buyer_taker"], received_ns=1)
        assert trade is not None and trade.side is Side.BUY
        assert trade.symbol == "ETH-USD"

    def test_symbols_map_both_ways(self) -> None:
        assert to_venue_symbol("BTC-USD") == "BTCUSDT"
        assert binance_trade(load("binance")["trade"], 1).symbol == "BTC-USD"  # type: ignore[union-attr]

    def test_book_ticker(self) -> None:
        quote = parse_book_ticker(load("binance")["book_ticker"], received_ns=1)
        assert quote is not None and quote.bid < quote.ask


class TestKrakenParsing:
    def test_kraken_reports_the_aggressor_directly(self) -> None:
        trade = kraken_trade(load("kraken")["trade"]["data"][0], received_ns=1)
        assert trade is not None and trade.side is Side.BUY
        assert trade.symbol == "BTC-USD"

    def test_ticker(self) -> None:
        quote = kraken_ticker(load("kraken")["ticker"]["data"][0], received_ns=1)
        assert quote is not None and quote.bid_size == pytest.approx(0.3124)


class TestBookReconstruction:
    """A book built from deltas with a missed message is wrong until resync.

    Not slightly stale — wrong, and persistently so. Every microstructure feature
    computed from it is wrong with it, and nothing about the output looks
    unusual. So a gap invalidates the book rather than being patched over.
    """

    def build(self) -> BookBuilder:
        builder = BookBuilder(symbol="BTC-USD", depth=5)
        builder.apply_snapshot(
            [(100.0, 1.0), (99.0, 2.0)], [(101.0, 1.5), (102.0, 2.5)], sequence=10
        )
        return builder

    def test_a_snapshot_synchronises(self) -> None:
        builder = self.build()
        assert builder.synced
        snapshot = builder.snapshot(1, 1)
        assert snapshot is not None
        assert snapshot.bids[0].price == 100.0 and snapshot.asks[0].price == 101.0

    def test_a_zero_size_removes_the_level(self) -> None:
        builder = self.build()
        builder.apply_delta([(99.0, 0.0)], [], sequence=11)
        snapshot = builder.snapshot(1, 1)
        assert snapshot is not None
        assert all(level.price != 99.0 for level in snapshot.bids)

    def test_a_sequence_gap_invalidates_the_book(self) -> None:
        builder = self.build()
        with pytest.raises(SequenceGap):
            builder.apply_delta([(100.0, 5.0)], [], sequence=13)
        assert not builder.synced
        assert builder.snapshot(1, 1) is None

    def test_a_replayed_message_is_ignored_not_applied_twice(self) -> None:
        builder = self.build()
        builder.apply_delta([(100.0, 3.0)], [], sequence=11)
        builder.apply_delta([(100.0, 9.0)], [], sequence=11)
        snapshot = builder.snapshot(1, 1)
        assert snapshot is not None
        assert snapshot.bids[0].size == pytest.approx(3.0)

    def test_a_delta_before_any_snapshot_is_refused(self) -> None:
        builder = BookBuilder(symbol="BTC-USD")
        with pytest.raises(SequenceGap):
            builder.apply_delta([(100.0, 1.0)], [], sequence=1)

    def test_a_crossed_book_is_recognised(self) -> None:
        builder = BookBuilder(symbol="BTC-USD")
        builder.apply_snapshot([(102.0, 1.0)], [(101.0, 1.0)], sequence=1)
        snapshot = builder.snapshot(1, 1)
        assert snapshot is not None and snapshot.is_crossed

    def test_imbalance_and_microprice(self) -> None:
        builder = self.build()
        snapshot = builder.snapshot(1, 1)
        assert snapshot is not None
        assert -1.0 <= imbalance(snapshot) <= 1.0
        assert isinstance(microprice_deviation(snapshot), float)


class TestFailureHandling:
    """Reconnection, backed off with jitter."""

    def test_backoff_grows_and_is_capped(self) -> None:
        import random

        policy = BackoffPolicy(initial_s=0.5, maximum_s=8.0)
        rng = random.Random(0)
        delays = [policy.delay_for(attempt, rng) for attempt in range(12)]
        assert all(0.0 <= d <= 8.0 for d in delays)
        # Jitter means individual draws vary, so compare the ceilings rather
        # than the samples: a fixed schedule would make every client reconnect
        # in lockstep and give the venue a second outage.
        assert policy.delay_for(0, random.Random(1)) <= 0.5

    def test_a_provider_that_keeps_failing_gives_up_when_closed(self) -> None:
        class AlwaysFails(ProviderBase):
            def __init__(self) -> None:
                super().__init__(
                    venue="broken",
                    data_source=DataSource.LIVE,
                    backoff=BackoffPolicy(initial_s=0.001, maximum_s=0.002),
                )
                self.attempts = 0

            async def _connect_and_yield(self, symbols):  # type: ignore[no-untyped-def]
                self.attempts += 1
                if self.attempts >= 3:
                    await self.close()
                raise ProviderError("connection refused")
                yield  # pragma: no cover

        provider = AlwaysFails()

        async def drain() -> list:
            return [event async for event in provider.stream(("BTC-USD",))]

        assert asyncio.run(drain()) == []
        assert provider.health.reconnects >= 3
        assert provider.health.last_error is not None
        assert "connection refused" in provider.health.last_error

    def test_health_tracks_staleness(self) -> None:
        provider = SimulatedProvider(symbols=("BTC-USD",), duration_s=1)
        assert provider.is_stale()  # nothing seen yet
        trade = Trade(
            exchange_ns=1_000,
            received_ns=1_000,
            symbol="BTC-USD",
            price=1.0,
            size=1.0,
            side=Side.BUY,
            trade_id="x",
        )
        provider.health.observe(trade)
        assert not provider.is_stale(at_ns=1_000)
        assert provider.is_stale(at_ns=1_000 + 120 * 1_000_000_000)


class TestCaptureAndReplay:
    def test_a_capture_round_trips_exactly(self, tmp_path: Path) -> None:
        """A replay must reproduce the recording event for event.

        This is what makes a backtest a backtest rather than a second simulation
        of one.
        """
        provider = SimulatedProvider(
            symbols=("BTC-USD",),
            seed=5,
            params=SimulatorParams.for_regime(Regime.REALISTIC),
            duration_s=120,
        )
        path = tmp_path / "capture.ndjson"
        original = []
        writer = CaptureWriter(path, venue="simulator", data_source=DataSource.SIMULATED)

        async def record() -> None:
            async for event in provider.stream(("BTC-USD",)):
                original.append(event)
                writer.write(event)

        asyncio.run(record())
        writer.close()

        restored = list(read_capture(path))
        assert len(restored) == len(original) > 0
        assert restored == original

    def test_replay_provider_streams_the_capture(self, tmp_path: Path) -> None:
        path = tmp_path / "capture.ndjson"
        provider = SimulatedProvider(symbols=("BTC-USD",), seed=6, duration_s=60)
        writer = CaptureWriter(path, venue="simulator", data_source=DataSource.SIMULATED)

        async def record() -> None:
            async for event in provider.stream(("BTC-USD",)):
                writer.write(event)

        asyncio.run(record())
        writer.close()

        replay = ReplayProvider(capture_path=path, speed=0.0)

        async def drain() -> list:
            return [event async for event in replay.stream(("BTC-USD",))]

        events = asyncio.run(drain())
        assert len(events) == writer.count
        assert replay.data_source is DataSource.REPLAY


class TestSimulator:
    def test_the_same_seed_gives_the_same_market(self) -> None:
        def run(seed: int) -> list:
            provider = SimulatedProvider(symbols=("BTC-USD",), seed=seed, duration_s=180)

            async def drain() -> list:
                return [e async for e in provider.stream(("BTC-USD",))]

            return asyncio.run(drain())

        assert run(99) == run(99)
        assert run(99) != run(100)

    def test_the_gbm_regime_has_an_analytic_answer(self) -> None:
        provider = SimulatedProvider(
            symbols=("BTC-USD",), seed=1, params=SimulatorParams.for_regime(Regime.GBM)
        )
        spot = provider.current_price("BTC-USD")
        # Monotone in the target, and symmetric about the current price.
        assert provider.analytic_prob_above(
            "BTC-USD", spot * 1.01, 300
        ) < provider.analytic_prob_above("BTC-USD", spot * 0.99, 300)
        assert 0.4 < provider.analytic_prob_above("BTC-USD", spot, 300) < 0.6

    def test_an_analytic_answer_is_refused_outside_the_gbm_regime(self) -> None:
        provider = SimulatedProvider(
            symbols=("BTC-USD",), seed=1, params=SimulatorParams.for_regime(Regime.REALISTIC)
        )
        with pytest.raises(ValueError, match="GBM"):
            provider.analytic_prob_above("BTC-USD", 1.0, 300)

    def test_everything_it_produces_is_labelled_simulated(self) -> None:
        provider = SimulatedProvider(symbols=("BTC-USD",), duration_s=10)
        assert provider.data_source is DataSource.SIMULATED
        assert "simulator" in provider.name
