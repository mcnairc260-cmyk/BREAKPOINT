"""The HTTP API.

Thin on purpose. Every endpoint validates its input, calls into the engine or a
repository, and shapes the result. No forecasting logic lives here, so the API
and the backtester cannot disagree about what a forecast is.

Two things are always in the response, whatever is asked for: which data source
is behind the numbers, and whether the system considers itself healthy. A client
that renders a probability without them would be presenting a simulated result
as a live one, and the API makes that awkward to do by accident.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from forecaster.clock import iso, now_ns
from forecaster.config import Config, load_config
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine, ForecastRefused
from forecaster.service.evaluator import Evaluator
from forecaster.service.persist import prediction_row
from forecaster.service.schemas import (
    ForecastRequest,
    ForecastResponse,
    HealthOut,
    HorizonForecastOut,
    PriceOut,
    SignalOut,
)
from forecaster.store import (
    MarketRepository,
    ModelRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import NS_PER_SECOND, DataSource, Forecast, PredictionMode


@dataclass
class AppState:
    config: Config
    engine: ForecastEngine
    collector: Collector
    evaluator: Evaluator
    prediction_repo: PredictionRepository
    market_repo: MarketRepository
    model_repo: ModelRepository
    quality_repo: QualityRepository
    tasks: list[asyncio.Task[Any]]


STATE: AppState | None = None


def state() -> AppState:
    if STATE is None:
        raise HTTPException(status_code=503, detail="service is still starting")
    return STATE


def _forecast_to_out(forecast: Forecast, prediction_id: int | None) -> HorizonForecastOut:
    remaining = (forecast.eval_at_ns - now_ns()) / NS_PER_SECOND
    return HorizonForecastOut(
        horizon_s=forecast.horizon_s,
        p_above=round(forecast.p_above, 4),
        p_below=round(forecast.p_below, 4),
        z=round(forecast.z, 4),
        sigma=forecast.sigma,
        sigma_pct=round(forecast.sigma * 100.0, 4),
        range_low=round(forecast.range_low, 2),
        range_high=round(forecast.range_high, 2),
        range_confidence=forecast.range_confidence,
        median=round(forecast.median, 2),
        confidence=forecast.confidence.value,
        confidence_reasons=list(forecast.confidence_reasons),
        as_of=iso(forecast.as_of_ns),
        expires_at=iso(forecast.eval_at_ns),
        expires_in_s=round(remaining, 1),
        model_version=forecast.model_version,
        model_train_source=forecast.model_train_source.value,
        calibration_source=(
            forecast.calibration_source.value if forecast.calibration_source else None
        ),
        prediction_id=prediction_id,
        signals=[
            SignalOut(
                name=c.name,
                label=c.label,
                direction=c.direction,
                weight=round(c.weight, 3),
                detail=c.detail,
            )
            for c in forecast.contributions
        ],
    )


def _persist(app_state: AppState, forecast: Forecast) -> int:
    row = prediction_row(forecast)
    prediction_id, _ = app_state.prediction_repo.append(row)
    return prediction_id


def create_app(app_state: AppState | None = None, *, run_workers: bool = False) -> FastAPI:
    """Build the API.

    `run_workers` starts the collector and the evaluator alongside it, inside the
    lifespan rather than through `on_event`. FastAPI ignores `on_event` handlers
    entirely when a lifespan is supplied, so a startup hook registered that way
    never runs — which is exactly what happened the first time this server was
    launched. It served requests happily, collected no market data at all, and
    reported `service_level: down` with no error anywhere.
    """

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        current = STATE
        if run_workers and current is not None:
            current.tasks.append(asyncio.create_task(current.collector.run()))
            current.tasks.append(asyncio.create_task(current.evaluator.run_forever(interval_s=5.0)))
        yield
        current = STATE
        if current is not None:
            for task in current.tasks:
                task.cancel()

    app = FastAPI(
        title="Crypto probability forecaster",
        version="0.1.0",
        summary=(
            "Calibrated probabilities that a price will be above a target, with recorded outcomes."
        ),
        lifespan=lifespan,
    )
    # The API serves only its own front end and holds no secrets, so a permissive
    # origin policy costs nothing here. If an authenticated endpoint is ever
    # added, this must be narrowed at the same time.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    if app_state is not None:
        global STATE
        STATE = app_state

    @app.get("/api/health", response_model=HealthOut)
    def health() -> HealthOut:
        s = state()
        symbols: dict[str, dict[str, object]] = {}
        warnings: list[str] = []
        for symbol in s.config.symbols:
            level, _ = s.collector.service_level(symbol)
            age = s.collector.feed_age_ns(symbol)
            window = s.collector.window(symbol, now_ns())
            symbols[symbol] = {
                "service_level": level.value,
                "feed_age_s": round(age / NS_PER_SECOND, 2) if age is not None else None,
                "spot": window.spot,
                "history_minutes": round(window.history_ns / NS_PER_SECOND / 60.0, 1),
                "quality": s.collector.monitor.summary(symbol),
            }
        if s.collector.data_source is not DataSource.LIVE:
            warnings.append(
                f"Market data is {s.collector.data_source.value.upper()}, not live. "
                "No number produced here describes a real market."
            )
        try:
            chain_rows = s.prediction_repo.verify_chain()
        except Exception as exc:
            chain_rows = None
            warnings.append(f"prediction hash chain failed verification: {exc}")

        return HealthOut(
            status="ok",
            data_source=s.collector.data_source.value,
            venue=s.collector.provider.venue,
            provider_connected=s.collector.provider.health.connected,
            symbols=symbols,
            collector=s.collector.stats.to_dict(),
            predictions=s.prediction_repo.count(),
            chain_verified_rows=chain_rows,
            models=[a.describe() for a in s.engine.artifacts.values()],
            warnings=warnings,
        )

    @app.get("/api/price/{symbol}", response_model=PriceOut)
    def price(symbol: str) -> PriceOut:
        s = state()
        if symbol not in s.config.symbols:
            raise HTTPException(status_code=404, detail=f"{symbol} is not being collected")
        moment = now_ns()
        window = s.collector.window(symbol, moment)
        if window.spot is None:
            raise HTTPException(status_code=503, detail=f"no price for {symbol} yet")
        level, _ = s.collector.service_level(symbol)
        age = s.collector.feed_age_ns(symbol, moment)
        quote = window.last_quote
        return PriceOut(
            symbol=symbol,
            price=round(window.spot, 2),
            bid=round(quote.bid, 2) if quote else None,
            ask=round(quote.ask, 2) if quote else None,
            spread_bps=(
                round(quote.spread / quote.mid * 10_000.0, 2) if quote and quote.mid > 0 else None
            ),
            as_of=iso(moment),
            age_s=round(age / NS_PER_SECOND, 2) if age is not None else None,
            stale=level.value in ("stale", "down"),
            venue=s.collector.provider.venue,
            data_source=s.collector.data_source.value,
            service_level=level.value,
        )

    @app.post("/api/forecast", response_model=ForecastResponse)
    def forecast(request: ForecastRequest) -> ForecastResponse:
        s = state()
        if request.symbol not in s.config.symbols:
            raise HTTPException(status_code=404, detail=f"{request.symbol} is not being collected")

        moment = now_ns()
        window = s.collector.window(request.symbol, moment)
        if window.spot is None:
            raise HTTPException(status_code=503, detail=f"no price for {request.symbol} yet")
        level, _ = s.collector.service_level(request.symbol, moment)
        age = s.collector.feed_age_ns(request.symbol, moment)

        outputs: list[HorizonForecastOut] = []
        warnings: list[str] = []
        if s.collector.data_source is not DataSource.LIVE:
            warnings.append(f"{s.collector.data_source.value.upper()} DATA — not a real market")

        for horizon_s in sorted(set(request.horizons)):
            try:
                result = s.engine.forecast(
                    window=window,
                    target=request.target,
                    horizon_s=horizon_s,
                    service_level=level,
                    feed_age_ns=age,
                    now_ns=moment,
                    prediction_mode=PredictionMode.LIVE,
                )
            except ForecastRefused as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            prediction_id = _persist(s, result) if request.save else None
            outputs.append(_forecast_to_out(result, prediction_id))
            if (
                result.model_train_source is not DataSource.LIVE
                and result.model_version.count("baseline") == 0
            ):
                warnings.append(
                    f"the {horizon_s}s forecast used a model trained on "
                    f"{result.model_train_source.value} data"
                )

        spot = window.spot
        return ForecastResponse(
            symbol=request.symbol,
            spot=round(spot, 2),
            target=request.target,
            distance=round(request.target - spot, 2),
            distance_pct=round((request.target / spot - 1.0) * 100.0, 4),
            venue=s.collector.provider.venue,
            data_source=s.collector.data_source.value,
            service_level=level.value,
            is_live=s.collector.data_source is DataSource.LIVE,
            warnings=sorted(set(warnings)),
            forecasts=outputs,
        )

    @app.get("/api/history")
    def history(
        limit: int = Query(50, ge=1, le=500),
        symbol: str | None = None,
        horizon_s: int | None = None,
    ) -> JSONResponse:
        s = state()
        rows = s.prediction_repo.history(limit=limit, symbol=symbol, horizon_s=horizon_s)
        return JSONResponse(
            {
                "predictions": [
                    {
                        "id": r["id"],
                        "created_at": iso(int(r["created_ns"])),
                        "expires_at": iso(int(r["eval_at_ns"])),
                        "expires_in_s": round((int(r["eval_at_ns"]) - now_ns()) / NS_PER_SECOND, 1),
                        "symbol": r["symbol"],
                        "horizon_s": r["horizon_s"],
                        "spot": r["spot"],
                        "target": r["target"],
                        "p_above": r["p_above"],
                        "predicted_side": "above" if float(r["p_above"]) > 0.5 else "below",
                        "confidence": r["confidence"],
                        "model_version": r["model_version"],
                        "data_source": r["data_source"],
                        "model_train_source": r["model_train_source"],
                        "outcome": r.get("outcome"),
                        "eval_price": r.get("eval_price"),
                        "correct": r.get("correct"),
                        "brier": r.get("brier"),
                        "resolved": r.get("outcome") is not None,
                    }
                    for r in rows
                ]
            }
        )

    @app.get("/api/stats")
    def stats(data_source: str | None = None) -> JSONResponse:
        from forecaster.service.reporting import performance_report

        s = state()
        return JSONResponse(
            performance_report(
                s.prediction_repo,
                data_source=data_source or s.collector.data_source.value,
            )
        )

    @app.get("/api/models")
    def models() -> JSONResponse:
        s = state()
        return JSONResponse(
            {
                "loaded": [a.describe() for a in s.engine.artifacts.values()],
                "registered": s.model_repo.list_all(),
                "promotion_decisions": s.model_repo.decisions(20),
                "ml_allowed_live": s.config.allow_ml_live,
            }
        )

    @app.get("/api/quality")
    def quality(limit: int = Query(50, ge=1, le=200)) -> JSONResponse:
        s = state()
        return JSONResponse(
            {
                "recent": [
                    {**r, "observed_at": iso(int(r["observed_ns"]))}
                    for r in s.quality_repo.recent(limit)
                ],
                "by_symbol": {
                    symbol: s.collector.monitor.summary(symbol) for symbol in s.config.symbols
                },
            }
        )

    return app


def build_state(config: Config | None = None) -> AppState:
    """Wire the whole system together from configuration."""
    from forecaster.marketdata.provider import build_provider
    from forecaster.models.registry import load_artifact

    cfg = config or load_config()
    cfg.ensure_dirs()
    db = open_database(cfg.database_url)
    market_repo = MarketRepository(db)
    prediction_repo = PredictionRepository(db)
    model_repo = ModelRepository(db)
    quality_repo = QualityRepository(db)

    extra: dict[str, Any] = {}
    if cfg.provider == "simulated":
        # Start three hours in the past. The simulator generates that history as
        # fast as it can and then tracks the clock, so the service can forecast
        # from the moment it starts instead of refusing for the first half hour.
        extra = {"realtime": True, "start_ns": now_ns() - 3 * 3600 * NS_PER_SECOND}
    provider = build_provider(
        cfg.provider,
        venue=cfg.venue,
        symbols=tuple(cfg.symbols),
        seed=cfg.seed,
        transport=cfg.transport,
        **extra,
    )
    collector = Collector(
        provider=provider,
        market_repo=market_repo,
        quality_repo=quality_repo,
        symbols=tuple(cfg.symbols),
        bar_resolutions_s=cfg.bar_resolutions_s,
    )
    engine = ForecastEngine(config=cfg)
    for path in sorted(cfg.artifact_dir.glob("*.json")):
        if path.name.endswith(".card.md"):
            continue
        try:
            engine.register(load_artifact(path))
        except Exception:
            continue

    return AppState(
        config=cfg,
        engine=engine,
        collector=collector,
        evaluator=Evaluator(
            prediction_repo=prediction_repo, market_repo=market_repo, quality=cfg.quality
        ),
        prediction_repo=prediction_repo,
        market_repo=market_repo,
        model_repo=model_repo,
        quality_repo=quality_repo,
        tasks=[],
    )
