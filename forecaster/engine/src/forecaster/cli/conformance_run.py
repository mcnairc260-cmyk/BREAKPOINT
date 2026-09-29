"""One command that exercises the entire live path without an exchange.

The live verification command (`forecaster live-check`) needs a route to a venue.
This one does not, and it runs everything else: a server speaking the venue's wire
protocol on localhost, the unmodified production adapter connecting to it over a
real socket, the collector, the forecast engine, the append-only log, the
evaluator, and the report.

It exists so that a change to any of that fails in CI on a network with no
exchange access, rather than the day someone finally runs the thing live.

What it proves and does not prove is stated in its own output, every time, so the
distinction cannot be lost between "the pipeline works" and "the forecasts are
any good". It proves the first. Nothing offline can prove the second.
"""

from __future__ import annotations

import asyncio
import contextlib
import tempfile
from pathlib import Path
from typing import Any

from forecaster.config import Config
from forecaster.marketdata.conformance import CoinbaseConformanceVenue, Faults
from forecaster.marketdata.venues.coinbase import CoinbaseProvider
from forecaster.models.baseline import BaselineModel
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine
from forecaster.service.livecheck import live_check
from forecaster.service.livereport import live_validation_report, monotonicity_violations
from forecaster.service.liverunner import LiveRunner
from forecaster.store import (
    MarketRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import DataSource

#: Short enough that the whole life cycle fits in one run, long enough that the
#: bar aggregator and the evaluator both do real work.
HORIZON_S = 12


class Result:
    def __init__(self) -> None:
        self.checks: list[tuple[str, bool, str]] = []

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.checks.append((name, ok, detail))
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name:<42} {detail}")

    @property
    def ok(self) -> bool:
        return all(ok for _, ok, _ in self.checks)


async def _run(seconds: float, workdir: Path) -> Result:
    result = Result()
    url = f"sqlite:///{workdir}/conformance.db"
    database = open_database(url)
    config = Config(database_url=url, data_dir=workdir, artifact_dir=workdir)
    market = MarketRepository(database)
    predictions = PredictionRepository(database)
    quality = QualityRepository(database)

    # -- 1. the adapter against a wire-protocol server ----------------------
    async with CoinbaseConformanceVenue(rate_hz=200.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        result.add(
            "endpoint guard downgrades a non-venue host",
            provider.data_source is DataSource.SIMULATED,
            f"data_source={provider.data_source.value}",
        )
        check = await live_check(
            provider,
            symbols=("BTC-USD", "ETH-USD"),
            seconds=min(seconds / 4.0, 8.0),
            ws_url=venue.ws_url,
            rest_url=venue.rest_url,
        )
        result.add(
            "live price checks pass over a real socket",
            check.ok,
            f"{len([c for c in check.checks if c.status == 'PASS'])} checks, "
            f"{check.events:,} events",
        )

    # -- 2. a dirty feed must be survived, not ignored -----------------------
    async with CoinbaseConformanceVenue(
        rate_hz=400.0,
        faults=Faults(malformed_every=11, duplicate_every=7, zero_price_every=17, drop_after=250),
    ) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        dirty = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=quality,
            symbols=("BTC-USD", "ETH-USD"),
            monitor=QualityMonitor(config.quality),
        )
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(dirty.run(max_events=400), timeout=40)
        await dirty.close()
        result.add(
            "dirty feed survived and bad data rejected",
            dirty.stats.events >= 300 and dirty.stats.rejected > 0,
            f"{dirty.stats.events:,} events, {dirty.stats.rejected:,} rejected, "
            f"{provider.health.reconnects} reconnects",
        )

    # -- 3. the whole life cycle, unattended --------------------------------
    market.purge_source(DataSource.SIMULATED)
    async with CoinbaseConformanceVenue(rate_hz=80.0, history_s=2400.0) as venue:
        provider = CoinbaseProvider(ws_url=venue.ws_url, rest_url=venue.rest_url)
        collector = Collector(
            provider=provider,
            market_repo=market,
            quality_repo=quality,
            symbols=("BTC-USD", "ETH-USD"),
            bar_resolutions_s=config.bar_resolutions_s,
            monitor=QualityMonitor(config.quality),
        )
        runner = LiveRunner(
            provider=provider,
            collector=collector,
            engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=config),
            prediction_repo=predictions,
            market_repo=market,
            config=config,
            symbols=("BTC-USD", "ETH-USD"),
            horizons_s=(HORIZON_S,),
            interval_s={HORIZON_S: 5.0},
            status_path=workdir / "status.json",
        )
        status = await runner.run(seconds=seconds)

    rows = predictions.history(limit=100_000)
    result.add(
        "forecasts produced on live-path data",
        len(rows) > 0,
        f"{len(rows):,} forecasts across {len(status.progress)} symbols",
    )
    result.add(
        "forecasts resolved automatically at expiry",
        status.evaluated > 0,
        f"{status.evaluated:,} resolved, {status.voided:,} void",
    )

    violations, checked = monotonicity_violations(rows)
    result.add(
        "probability never rises with the target",
        checked > 0 and violations == 0,
        f"{violations} violations in {checked:,} adjacent pairs",
    )

    try:
        verified = predictions.verify_chain()
        chain_ok, chain_detail = True, f"{verified:,} rows chained"
    except Exception as exc:
        chain_ok, chain_detail = False, str(exc)
    result.add("append-only chain intact under concurrency", chain_ok, chain_detail)

    # -- 4. a restart must not lose or duplicate anything --------------------
    del predictions, market, database
    database2 = open_database(url)
    predictions2 = PredictionRepository(database2)
    market2 = MarketRepository(database2)
    after = predictions2.history(limit=100_000)
    result.add(
        "predictions survive a restart",
        len(after) == len(rows),
        f"{len(after):,} of {len(rows):,} still present",
    )

    from forecaster.service.evaluator import Evaluator

    evaluator = Evaluator(prediction_repo=predictions2, market_repo=market2, quality=config.quality)
    future = max((int(r["eval_at_ns"]) for r in after), default=0) + 10**9
    first = evaluator.run_once(at_ns=future)
    second = evaluator.run_once(at_ns=future)
    result.add(
        "resolution is idempotent across restarts",
        second.checked == 0,
        f"{first.checked} resolved on the first pass, {second.checked} on the second",
    )

    # -- 5. provenance separation -------------------------------------------
    live_report = live_validation_report(
        prediction_repo=predictions2,
        quality_repo=QualityRepository(database2),
        horizons_s=(HORIZON_S,),
        data_source=DataSource.LIVE,
    )
    sim_report = live_validation_report(
        prediction_repo=predictions2,
        quality_repo=QualityRepository(database2),
        horizons_s=(HORIZON_S,),
        data_source=DataSource.SIMULATED,
    )
    result.add(
        "conformance rows never appear in live metrics",
        live_report["totals"]["forecasts"] == 0 and sim_report["totals"]["resolved"] > 0,
        f"live={live_report['totals']['forecasts']}, simulated={sim_report['totals']['resolved']}",
    )
    insufficient = [
        g for g in sim_report["groups"] if g["resolved"] > 0 and not g["can_claim_calibration"]
    ]
    result.add(
        "a small sample refuses to report calibration",
        all(g["calibration_error"] is None for g in insufficient),
        f"{len(insufficient)} groups labelled insufficient",
    )
    return result


def run_conformance(*, seconds: float = 60.0, output: str | None = None) -> int:
    """Run the offline live-path proof. Returns a process exit code."""
    print("")
    print("  LIVE PATH CONFORMANCE RUN")
    print(f"  {'─' * 68}")
    print("  A server speaking Coinbase's wire protocol runs on 127.0.0.1 and the")
    print("  unmodified production adapter connects to it over a real socket.")
    print("")
    print("  PROVES     the client: connect, subscribe, parse, book, quality checks,")
    print("             forecast, persist, expire, resolve, restart, reconnect.")
    print("  DOES NOT   prove that Coinbase emits these shapes today, and says")
    print("  PROVE      nothing whatever about forecast accuracy in a real market.")
    print("")

    with tempfile.TemporaryDirectory(prefix="forecaster-conformance-") as tmp:
        result = asyncio.run(_run(seconds, Path(tmp)))

    passed = sum(1 for _, ok, _ in result.checks if ok)
    print("")
    print(f"  {passed}/{len(result.checks)} checks passed")
    print("")
    print("  Real-market validation still requires `forecaster live-check` and")
    print("  `forecaster collect-live` on a network that can reach an exchange.")
    print("")

    if output:
        import json

        payload: dict[str, Any] = {
            "passed": passed,
            "total": len(result.checks),
            "ok": result.ok,
            "scope": "conformance harness on localhost — not real market data",
            "checks": [
                {"name": name, "ok": ok, "detail": detail} for name, ok, detail in result.checks
            ],
        }
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(json.dumps(payload, indent=2))
        print(f"  written to {output}\n")

    return 0 if result.ok else 1
