"""Feature engineering."""

from forecaster.features.compute import FEATURE_NAMES, FEATURE_SET_VERSION, compute_features
from forecaster.features.registry import (
    REGISTRY,
    FeatureSpec,
    LeakageDetected,
    assert_causal,
)
from forecaster.features.window import (
    CachedWindowSource,
    MarketWindow,
    RollingWindowSource,
    StoreWindowSource,
)

__all__ = [
    "FEATURE_NAMES",
    "FEATURE_SET_VERSION",
    "REGISTRY",
    "CachedWindowSource",
    "FeatureSpec",
    "LeakageDetected",
    "MarketWindow",
    "RollingWindowSource",
    "StoreWindowSource",
    "assert_causal",
    "compute_features",
]
