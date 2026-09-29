"""Market data: one protocol, several sources."""

from forecaster.marketdata.bars import BarAggregator
from forecaster.marketdata.book import BookBuilder, SequenceGap
from forecaster.marketdata.provider import (
    MarketDataProvider,
    MarketEvent,
    ProviderError,
    ProviderHealth,
    build_provider,
)
from forecaster.marketdata.replay import ReplayProvider
from forecaster.marketdata.simulator import SimulatedProvider, SimulatorParams

__all__ = [
    "BarAggregator",
    "BookBuilder",
    "MarketDataProvider",
    "MarketEvent",
    "ProviderError",
    "ProviderHealth",
    "ReplayProvider",
    "SequenceGap",
    "SimulatedProvider",
    "SimulatorParams",
    "build_provider",
]
