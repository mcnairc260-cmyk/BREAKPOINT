"""Request and response shapes.

Validation is strict and the error messages are written for a person. A target
price of zero is not a 500; it is a sentence explaining what is wrong.

Every response that carries a number also carries the provenance of that number —
which model made it, what data it was trained on, and whether the feed was live.
That is not decoration. A probability without its provenance invites the reader
to assume the best case.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from forecaster.types import HORIZONS_S


class ForecastRequest(BaseModel):
    symbol: str = Field(..., description="BTC-USD or ETH-USD")
    target: float = Field(..., gt=0.0, description="The price to forecast against")
    horizons: list[int] = Field(
        default_factory=lambda: list(HORIZONS_S),
        description="Horizons in seconds. 300, 1200, or both.",
    )
    save: bool = Field(True, description="Record the forecast so it can be scored later")

    @field_validator("horizons")
    @classmethod
    def _known_horizons(cls, value: list[int]) -> list[int]:
        unknown = [h for h in value if h not in HORIZONS_S]
        if unknown:
            raise ValueError(
                f"unsupported horizon(s) {unknown}; "
                f"this system forecasts {list(HORIZONS_S)} seconds"
            )
        return value or list(HORIZONS_S)


class SignalOut(BaseModel):
    name: str
    label: str
    direction: Literal["above", "below", "neutral"]
    weight: float
    detail: str


class HorizonForecastOut(BaseModel):
    horizon_s: int
    p_above: float
    p_below: float
    z: float
    sigma: float
    sigma_pct: float
    range_low: float
    range_high: float
    range_confidence: float
    median: float
    confidence: str
    confidence_reasons: list[str]
    as_of: str
    expires_at: str
    expires_in_s: float
    model_version: str
    model_train_source: str
    calibration_source: str | None
    prediction_id: int | None
    signals: list[SignalOut]


class ForecastResponse(BaseModel):
    symbol: str
    spot: float
    target: float
    distance: float
    distance_pct: float
    venue: str
    data_source: str
    service_level: str
    is_live: bool
    warnings: list[str]
    forecasts: list[HorizonForecastOut]


class PriceOut(BaseModel):
    symbol: str
    price: float
    bid: float | None
    ask: float | None
    spread_bps: float | None
    as_of: str
    age_s: float | None
    stale: bool
    venue: str
    data_source: str
    service_level: str


class HealthOut(BaseModel):
    status: str
    data_source: str
    venue: str
    provider_connected: bool
    symbols: Mapping[str, Mapping[str, object]]
    collector: Mapping[str, object]
    predictions: int
    chain_verified_rows: int | None
    models: list[dict[str, object]]
    warnings: list[str]
