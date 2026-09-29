"""Shared fixtures.

Sockets are disabled for the whole suite. That is not only hermeticity: it is
what proves the venue "fixtures" really are fixtures. If a test could quietly
reach an exchange, a passing suite would say nothing about whether the parsing
code works offline — and this project's build environment has no exchange access
at all, so a test that needed one would fail for the wrong reason.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from forecaster.config import Config
from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.store import (
    MarketRepository,
    ModelRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import NS_PER_SECOND


@pytest.fixture
def db(tmp_path: Path):
    database = open_database(f"sqlite:///{tmp_path / 'test.db'}")
    yield database
    database.dispose()


@pytest.fixture
def repos(db):
    return {
        "market": MarketRepository(db),
        "prediction": PredictionRepository(db),
        "model": ModelRepository(db),
        "quality": QualityRepository(db),
    }


@pytest.fixture
def config(tmp_path: Path) -> Config:
    return Config(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        provider="simulated",
        venue="simulator",
        symbols=("BTC-USD",),
        data_dir=tmp_path / "data",
        artifact_dir=tmp_path / "artifacts",
    )


def make_provider(
    *, seed: int = 7, duration_s: float = 7200, regime: Regime = Regime.REALISTIC, start_ns: int = 0
) -> SimulatedProvider:
    return SimulatedProvider(
        symbols=("BTC-USD",),
        seed=seed,
        params=SimulatorParams.for_regime(regime),
        duration_s=duration_s,
        start_ns=start_ns,
        realtime=False,
    )


@pytest.fixture(scope="session")
def sim_events() -> list:
    """Two hours of simulated market events, generated once.

    Exposed raw so a test can build a collector that has seen only the events up
    to some instant — which is how "does knowing the future change the answer?"
    gets tested honestly.
    """
    provider = make_provider(duration_s=7200, start_ns=0)

    async def drain() -> list:
        return [event async for event in provider.stream(("BTC-USD",))]

    return asyncio.run(drain())


def collector_for(events: list, database) -> Collector:
    """A collector that has ingested exactly `events` and nothing more."""
    collector = Collector(
        provider=make_provider(duration_s=0),
        market_repo=MarketRepository(database),
        quality_repo=QualityRepository(database),
        symbols=("BTC-USD",),
        monitor=QualityMonitor(),
    )
    for event in events:
        collector.handle(event)
    collector.flush(force=True)
    return collector


@pytest.fixture(scope="session")
def collected():
    """Two hours of simulated market data, already ingested.

    Two hours because the volatility model needs at least thirty minutes of
    history before it will forecast at all, so a shorter capture would exercise
    the refusal path instead of the working one.

    Session-scoped and deterministic: the same seed produces the same market
    every time, so generating it once and sharing it is safe, and it takes the
    suite from eighty seconds to a few.
    """
    database = open_database("sqlite:///:memory:")
    provider = make_provider(duration_s=7200, start_ns=0)
    collector = Collector(
        provider=provider,
        market_repo=MarketRepository(database),
        quality_repo=QualityRepository(database),
        symbols=("BTC-USD",),
        monitor=QualityMonitor(),
    )
    asyncio.run(collector.run())
    return collector


@pytest.fixture
def fresh_collected(repos):
    """The same capture, in a throwaway database, for tests that write."""
    provider = make_provider(duration_s=7200, start_ns=0)
    collector = Collector(
        provider=provider,
        market_repo=repos["market"],
        quality_repo=repos["quality"],
        symbols=("BTC-USD",),
        monitor=QualityMonitor(),
    )
    asyncio.run(collector.run())
    return collector


@pytest.fixture(scope="session")
def sim_window(collected):
    """A window 90 minutes into the simulated capture."""
    return collected.window("BTC-USD", 90 * 60 * NS_PER_SECOND)
