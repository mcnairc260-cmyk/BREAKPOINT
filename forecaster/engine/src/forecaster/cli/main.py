"""The command line.

One entry point per thing a person actually does: gather data, train, replay
history, score outstanding forecasts, serve the app, and check the whole thing
still works.

Output is written for a human reading a terminal, not for a log parser. Where a
number could be misread as stronger evidence than it is, the text says so on the
same line rather than in documentation nobody opens.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import subprocess
import sys
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.config import Config, load_config
from forecaster.types import HORIZONS_S, NS_PER_SECOND, DataSource


def git_sha() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return result.stdout.strip() or None
    except Exception:
        return None


def _open(config: Config) -> tuple[Any, Any, Any, Any, Any]:
    from forecaster.store import (
        MarketRepository,
        ModelRepository,
        PredictionRepository,
        QualityRepository,
        open_database,
    )

    config.ensure_dirs()
    db = open_database(config.database_url)
    return (
        db,
        MarketRepository(db),
        PredictionRepository(db),
        ModelRepository(db),
        QualityRepository(db),
    )


# ---------------------------------------------------------------------------
# simulate
# ---------------------------------------------------------------------------


def cmd_simulate(args: argparse.Namespace) -> int:
    """Generate simulated market data.

    Clearly labelled at every step. The data lands in the database tagged
    `simulated`, no aggregate mixes it with live data, and any model trained on
    it carries `.sim.` in its version string.
    """
    from forecaster.marketdata.replay import CaptureWriter
    from forecaster.marketdata.simulator import Regime, SimulatedProvider, SimulatorParams
    from forecaster.quality import QualityMonitor
    from forecaster.service.collector import Collector

    config = load_config()
    _, market_repo, _, _, quality_repo = _open(config)
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)

    if args.reset:
        market_repo.purge_source(DataSource.SIMULATED)
        print("cleared previously simulated market data")

    regime = Regime(args.regime)
    start_ns = now_ns() - int(args.duration * NS_PER_SECOND) if args.anchor_now else args.start_ns
    provider = SimulatedProvider(
        symbols=symbols,
        seed=args.seed,
        params=SimulatorParams.for_regime(regime),
        duration_s=args.duration,
        start_ns=start_ns,
        realtime=False,
    )
    capture = (
        CaptureWriter(args.capture, venue="simulator", data_source=DataSource.SIMULATED)
        if args.capture
        else None
    )
    collector = Collector(
        provider=provider,
        market_repo=market_repo,
        quality_repo=quality_repo,
        symbols=symbols,
        bar_resolutions_s=config.bar_resolutions_s,
        monitor=QualityMonitor(config.quality),
        capture=capture,
    )
    print(
        f"simulating {args.duration / 3600:.1f}h of {regime.value} market for "
        f"{', '.join(symbols)} (seed {args.seed})"
    )
    stats = asyncio.run(collector.run())
    if capture is not None:
        capture.close()
        print(f"capture written to {args.capture} ({capture.count:,} events)")
    print(
        f"stored {stats.trades:,} trades, {stats.quotes:,} quotes, {stats.books:,} books, "
        f"{stats.bars:,} bars ({stats.rejected} rejected by quality checks)"
    )
    print(f"window: {iso(start_ns)} to {iso(start_ns + int(args.duration * NS_PER_SECOND))}")
    print("\nTHIS IS SIMULATED DATA. It describes no real market.")
    return 0


# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------


def cmd_collect(args: argparse.Namespace) -> int:
    """Gather live market data. This is the one that must keep running."""
    from forecaster.marketdata.provider import build_provider
    from forecaster.marketdata.replay import CaptureWriter
    from forecaster.quality import QualityMonitor
    from forecaster.service.collector import Collector

    config = load_config()
    _, market_repo, _, _, quality_repo = _open(config)
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)

    provider = build_provider(
        "live" if args.venue else config.provider,
        venue=args.venue or config.venue,
        symbols=symbols,
        transport=args.transport or config.transport,
        seed=config.seed,
    )
    capture = (
        CaptureWriter(args.capture, venue=provider.venue, data_source=provider.data_source)
        if args.capture
        else None
    )
    collector = Collector(
        provider=provider,
        market_repo=market_repo,
        quality_repo=quality_repo,
        symbols=symbols,
        bar_resolutions_s=config.bar_resolutions_s,
        monitor=QualityMonitor(config.quality),
        capture=capture,
    )
    print(
        f"collecting {', '.join(symbols)} from {provider.venue} "
        f"via {args.transport or config.transport}"
    )
    print("press ctrl-c to stop\n")
    try:
        stats = asyncio.run(collector.run(max_events=args.max_events))
    except KeyboardInterrupt:
        stats = collector.stats
        asyncio.run(collector.close())
    print(
        f"\n{stats.trades:,} trades, {stats.quotes:,} quotes, {stats.books:,} books, "
        f"{stats.bars:,} bars over {stats.to_dict()['uptime_s']:.0f}s"
    )
    if provider.health.reconnects:
        print(f"{provider.health.reconnects} reconnects, last error: {provider.health.last_error}")
    return 0


# ---------------------------------------------------------------------------
# train
# ---------------------------------------------------------------------------


def cmd_train(args: argparse.Namespace) -> int:
    from forecaster.features.window import CachedWindowSource
    from forecaster.models.baseline import BaselineModel
    from forecaster.models.dataset import DatasetBuilder, price_lookup
    from forecaster.models.registry import save_artifact
    from forecaster.models.train import train
    from forecaster.types import HORIZONS_S

    config = load_config()
    _, market_repo, _, model_repo, _ = _open(config)
    source = DataSource(args.data_source)
    venue = args.venue or ("simulator" if source is DataSource.SIMULATED else config.venue)
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)
    horizons = tuple(int(h) for h in args.horizons.split(",")) if args.horizons else HORIZONS_S

    start_ns, end_ns = _resolve_window(market_repo, symbols[0], source, venue, args)
    if start_ns is None:
        print("no market data found for that source and venue; run `simulate` or `collect` first")
        return 1
    span_h = (end_ns - start_ns) / NS_PER_SECOND / 3600
    print(f"training on {span_h:.1f}h of {source.value} data from {venue}\n")

    exit_code = 0
    for symbol in symbols:
        for horizon_s in horizons:
            window_source = CachedWindowSource(
                market_repo=market_repo,
                symbol=symbol,
                venue=venue,
                data_source=source,
                start_ns=start_ns,
                end_ns=end_ns,
            ).load()
            builder = DatasetBuilder(
                window_source=window_source,
                baseline=BaselineModel(config=config.model),
                symbol=symbol,
                horizon_s=horizon_s,
                data_source=source,
                sample_interval_s=args.sample_interval,
            )
            print(f"--- {symbol} {horizon_s}s ---")
            try:
                result = train(
                    builder=builder,
                    start_ns=start_ns,
                    end_ns=end_ns,
                    price_at=price_lookup(market_repo, symbol, source=source, venue=venue),
                    symbol=symbol,
                    horizon_s=horizon_s,
                    data_source=source,
                    config=config.model,
                    warmup_s=args.warmup,
                    git_sha=git_sha(),
                    train_learner=not args.baseline_only,
                )
            except ValueError as exc:
                print(f"  could not train: {exc}\n")
                exit_code = 1
                continue

            print(result.summary())
            path = save_artifact(result.artifact, config.artifact_dir)
            model_repo.register(
                {
                    "version": result.artifact.version,
                    "family": result.artifact.family,
                    "symbol": symbol,
                    "horizon_s": horizon_s,
                    "trained_ns": result.artifact.trained_ns,
                    "train_start_ns": start_ns,
                    "train_end_ns": end_ns,
                    "n_rows": int(result.sample_size.get("n_rows", 0)),
                    "n_timestamps": int(result.sample_size.get("n_timestamps", 0)),
                    "n_independent": int(result.sample_size.get("n_non_overlapping", 0)),
                    "features_json": json.dumps(list(result.artifact.feature_names)),
                    "params_json": json.dumps({"horizon_s": horizon_s}),
                    "metrics_json": json.dumps(result.artifact.metrics),
                    "calibration_json": json.dumps(
                        result.artifact.calibrator.to_dict() if result.artifact.calibrator else None
                    ),
                    "train_data_source": source.value,
                    "calibration_source": (
                        result.artifact.calibration_source.value
                        if result.artifact.calibration_source
                        else None
                    ),
                    "git_sha": result.artifact.git_sha,
                    "artifact_path": str(path),
                    "status": "production" if source is not DataSource.SIMULATED else "quarantined",
                    "promoted_ns": now_ns() if source is not DataSource.SIMULATED else None,
                    "notes": result.decision_reason,
                }
            )
            model_repo.record_decision(
                {
                    "decided_ns": now_ns(),
                    "candidate_version": result.artifact.version,
                    "incumbent_version": None,
                    "promoted": result.promoted,
                    "reason": result.decision_reason,
                    "evidence_json": json.dumps(result.comparison or {}),
                }
            )
            print(f"  artifact  {path}\n")

    if source is DataSource.SIMULATED:
        print(
            "These models were trained on simulated data. They are registered as "
            "QUARANTINED and cannot serve a live forecast unless FORECASTER_ALLOW_ML_LIVE "
            "is deliberately set."
        )
    return exit_code


def _resolve_window(
    market_repo: Any, symbol: str, source: DataSource, venue: str, args: argparse.Namespace
) -> tuple[int | None, int]:
    from sqlalchemy import and_, func, select

    from forecaster.store.schema import trades

    if getattr(args, "start_ns", None) and getattr(args, "end_ns", None):
        return int(args.start_ns), int(args.end_ns)
    with market_repo.db.connect() as conn:
        row = conn.execute(
            select(func.min(trades.c.exchange_ns), func.max(trades.c.exchange_ns)).where(
                and_(
                    trades.c.symbol == symbol,
                    trades.c.venue == venue,
                    trades.c.data_source == source.value,
                )
            )
        ).first()
    if row is None or row[0] is None:
        return None, 0
    return int(row[0]), int(row[1])


# ---------------------------------------------------------------------------
# backtest, evaluate, report
# ---------------------------------------------------------------------------


def cmd_backtest(args: argparse.Namespace) -> int:
    from forecaster.backtest import run_backtest
    from forecaster.models.registry import load_artifact
    from forecaster.service.engine import ForecastEngine
    from forecaster.types import HORIZONS_S

    config = load_config()
    _, market_repo, prediction_repo, _, _ = _open(config)
    source = DataSource(args.data_source)
    venue = args.venue or ("simulator" if source is DataSource.SIMULATED else config.venue)
    symbol = args.symbol or config.symbols[0]

    engine = ForecastEngine(config=config)
    loaded = 0
    for path in sorted(config.artifact_dir.glob("*.json")):
        try:
            artifact = load_artifact(path)
        except Exception:
            continue
        if artifact.symbol == symbol:
            engine.register(artifact)
            loaded += 1

    start_ns, end_ns = _resolve_window(market_repo, symbol, source, venue, args)
    if start_ns is None:
        print("no market data for that source and venue")
        return 1

    print(f"backtesting {symbol} on {source.value} data ({loaded} artifacts loaded)\n")
    result = run_backtest(
        config=config,
        engine=engine,
        market_repo=market_repo,
        prediction_repo=prediction_repo,
        symbol=symbol,
        venue=venue,
        data_source=source,
        start_ns=start_ns,
        end_ns=end_ns,
        horizons_s=HORIZONS_S,
        step_s=args.step,
        warmup_s=args.warmup,
        persist=args.persist,
    )
    print(result.summary())
    if args.json:
        Path(args.json).write_text(json.dumps(result.to_dict(), indent=2), encoding="utf-8")
        print(f"\nfull report written to {args.json}")
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    from forecaster.service.evaluator import Evaluator

    config = load_config()
    _, market_repo, prediction_repo, _, _ = _open(config)
    evaluator = Evaluator(
        prediction_repo=prediction_repo, market_repo=market_repo, quality=config.quality
    )
    run = evaluator.run_once(at_ns=args.at_ns, limit=args.limit)
    print(
        f"checked {run.checked}, resolved {run.resolved} "
        f"({run.stale} from a stale price), voided {run.voided}, ties {run.ties}"
    )
    for outcome, count in sorted(run.by_outcome.items()):
        print(f"  {outcome:12} {count}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    from forecaster.service.reporting import performance_report

    config = load_config()
    _, _, prediction_repo, _, _ = _open(config)
    report = performance_report(
        prediction_repo, data_source=args.data_source, prediction_mode=args.mode
    )
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(
        f"resolved forecasts: {report['total_resolved']}  "
        f"(source: {report['data_source']}, mode: {report.get('prediction_mode', args.mode)})"
    )
    for key, group in report["groups"].items():
        if group.get("n", 0) == 0:
            continue
        print(f"\n{key}")
        print(
            f"  n={group['n']}  Brier={group['brier']:.5f}  "
            f"ECE={group['ece']:.5f}  accuracy={group['accuracy']:.1%}"
        )
        print(f"  {group['sample_size_note']}")
        if not group.get("can_claim_calibration"):
            print(f"  {group.get('calibration_note')}")
    void = report.get("void_analysis", {})
    if void.get("resolved"):
        print(
            f"\nvoid rate {void['void_rate']:.1%} — accuracy is between "
            f"{void['accuracy_if_all_voids_wrong']:.1%} and "
            f"{void['accuracy_if_all_voids_right']:.1%} "
            "once unscored forecasts are accounted for"
        )
    return 0


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from forecaster.service.app import build_state, create_app

    config = load_config()
    state = build_state(config)
    app = create_app(state, run_workers=True)

    banner = "LIVE" if config.provider == "live" else config.provider.upper()
    print(f"serving on http://{args.host}:{args.port}  [{banner} data from {config.venue}]")
    if config.provider != "live":
        print("Market data is not live. Nothing this server produces describes a real market.")
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


# ---------------------------------------------------------------------------
# live-check — prove a real venue, in one step
# ---------------------------------------------------------------------------


def _quiet_transport_noise() -> tuple[Counter[str], Callable[[], None]]:
    """Stop a library's internal tracebacks burying the one useful line.

    A refused WebSocket handshake makes `websockets` log a full traceback and
    leaves an unretrieved exception on an internal task, which asyncio then
    prints itself — once per reconnect attempt. Against a blocked host that is
    six tracebacks wrapped around one sentence ("proxy rejected connection: HTTP
    403"), which is the only part anyone needs.

    Nothing is hidden: the counter is reported, and the provider's own
    `last_error` carries the real diagnosis.

    Returns the counter and an `install` callable that must be invoked **inside**
    the running loop, because an exception handler belongs to a loop and there is
    no loop yet when this is called.

    An earlier version stashed that callable in a module-level list for
    `_with_quiet` to find. One caller never populated the list, so the
    suppression silently did nothing there and `collect-live` printed six
    library tracebacks per run. Returning the callable makes forgetting it a
    type error rather than a surprise found by reading the output.
    """
    logging.getLogger("websockets").setLevel(logging.CRITICAL)
    logging.getLogger("websockets.client").setLevel(logging.CRITICAL)
    logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
    background: Counter[str] = Counter()

    def collect(_loop: object, context: dict[str, Any]) -> None:
        exception = context.get("exception")
        label = (
            f"{type(exception).__name__}: {exception}"
            if exception is not None
            else str(context.get("message", "unknown"))
        )
        background[label] += 1

    def install() -> None:
        with contextlib.suppress(RuntimeError):
            asyncio.get_running_loop().set_exception_handler(collect)

    return background, install


async def _with_quiet(install: Callable[[], None], coro: Any) -> Any:
    """Run a coroutine with the noise handler installed on its own loop."""
    install()
    return await coro


def _live_endpoints(venue: str, args: argparse.Namespace) -> dict[str, str]:
    """Endpoint overrides, used by the conformance harness and nothing else.

    Pointing these anywhere but the venue's own hosts downgrades the data source
    to SIMULATED — see `marketdata/venues/endpoints.py`. There is no flag that
    can make non-venue data count as live.
    """
    overrides: dict[str, str] = {}
    if getattr(args, "ws_url", None):
        overrides["ws_url"] = args.ws_url
    if getattr(args, "rest_url", None):
        overrides["rest_url"] = args.rest_url
    return overrides


def cmd_live_check(args: argparse.Namespace) -> int:
    """Connect to a venue and verify that every price it reports means what we think."""
    import json as _json

    from forecaster.marketdata.venues import build_venue_provider
    from forecaster.marketdata.venues.endpoints import endpoint_note
    from forecaster.service.livecheck import format_report, live_check

    config = load_config()
    venue = args.venue or config.venue
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)
    overrides = _live_endpoints(venue, args)
    background, install_quiet = _quiet_transport_noise()

    provider = build_venue_provider(venue, symbols=symbols, transport=args.transport, **overrides)
    if overrides:
        print(f"  {endpoint_note(venue, *overrides.values())}")

    async def go() -> Any:
        return await _with_quiet(
            install_quiet,
            live_check(
                provider,
                symbols=symbols,
                seconds=args.seconds,
                transport=args.transport,
                ws_url=overrides.get("ws_url"),
                rest_url=overrides.get("rest_url"),
            ),
        )

    report = asyncio.run(go())
    print(format_report(report))
    if background:
        total = sum(background.values())
        top = background.most_common(1)[0][0]
        print(f"  {total} background transport errors suppressed, e.g. {top}\n")
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(_json.dumps(report.to_dict(), indent=2))
        print(f"  written to {args.json}\n")
    if report.error and report.events == 0:
        print(
            "  Nothing arrived. On a network that blocks exchanges this is the expected\n"
            "  result: the adapter is fine and the route is not. Try --transport poll,\n"
            "  then run this from a machine with ordinary internet access.\n"
        )
    return 0 if report.ok else 1


# ---------------------------------------------------------------------------
# collect-live — the unattended runner
# ---------------------------------------------------------------------------


def cmd_collect_live(args: argparse.Namespace) -> int:
    """Collect real market data and forecast against it, indefinitely."""
    from forecaster.marketdata.venues import build_venue_provider
    from forecaster.marketdata.venues.endpoints import endpoint_note
    from forecaster.models.baseline import BaselineModel
    from forecaster.quality import QualityMonitor
    from forecaster.service.collector import Collector
    from forecaster.service.engine import ForecastEngine
    from forecaster.service.liverunner import LiveRunner

    config = load_config()
    _, market_repo, prediction_repo, _, quality_repo = _open(config)
    venue = args.venue or config.venue
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)
    horizons = tuple(int(h) for h in args.horizons.split(",")) if args.horizons else HORIZONS_S
    overrides = _live_endpoints(venue, args)

    _, install_quiet = _quiet_transport_noise()

    provider = build_venue_provider(venue, symbols=symbols, transport=args.transport, **overrides)
    collector = Collector(
        provider=provider,
        market_repo=market_repo,
        quality_repo=quality_repo,
        symbols=symbols,
        bar_resolutions_s=config.bar_resolutions_s,
        monitor=QualityMonitor(config.quality),
    )
    runner = LiveRunner(
        provider=provider,
        collector=collector,
        engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=config),
        prediction_repo=prediction_repo,
        market_repo=market_repo,
        config=config,
        symbols=symbols,
        horizons_s=horizons,
        interval_s=({h: args.interval for h in horizons} if args.interval else None),
    )

    print(f"  {endpoint_note(venue, *overrides.values())}" if overrides else "")
    print(f"  collecting {', '.join(symbols)} from {venue} over {args.transport}")
    print(f"  data source      {provider.data_source.value.upper()}")
    print(f"  horizons         {', '.join(str(h) + 's' for h in horizons)}")
    print(
        "  sampling         "
        + ", ".join(f"{h}s every {runner.interval_s[h]:.0f}s" for h in horizons)
    )
    print(f"  targets          {len(runner.ladder_z)} per instant at z = {list(runner.ladder_z)}")
    print(f"  status file      {runner.status_path}")
    print("  ctrl-c to stop. Forecasts already written are resolved on the next start.\n")

    try:
        status = asyncio.run(_with_quiet(install_quiet, runner.run(seconds=args.seconds)))
    except KeyboardInterrupt:
        runner.stop()
        status = runner.status
    summary = status.to_dict()
    print(
        f"\n  {sum(p['forecasts'] for p in summary['per_symbol'].values()):,} forecasts written, "
        f"{summary['evaluated']:,} resolved, {summary['voided']:,} void, "
        f"{summary['reconnects']} reconnects"
    )
    print("  `forecaster live-report` for the full picture.\n")
    return 0


# ---------------------------------------------------------------------------
# live-report — the real-market validation report
# ---------------------------------------------------------------------------


def cmd_live_report(args: argparse.Namespace) -> int:
    import json as _json

    from forecaster.service.livereport import format_report, live_validation_report
    from forecaster.types import DataSource

    config = load_config()
    _, _, prediction_repo, _, quality_repo = _open(config)
    symbols = tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols)
    horizons = tuple(int(h) for h in args.horizons.split(",")) if args.horizons else HORIZONS_S

    report = live_validation_report(
        prediction_repo=prediction_repo,
        quality_repo=quality_repo,
        symbols=symbols,
        horizons_s=horizons,
        data_source=DataSource(args.data_source),
    )
    print(format_report(report))
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(_json.dumps(report, indent=2))
        print(f"  written to {args.json}\n")
    return 0


# ---------------------------------------------------------------------------
# live-status — is it running, and how far along is it
# ---------------------------------------------------------------------------


def cmd_live_status(args: argparse.Namespace) -> int:
    from forecaster.service.livestatus import format_status, live_status

    config = load_config()
    _, market_repo, prediction_repo, _, _ = _open(config)
    status = live_status(
        config=config,
        prediction_repo=prediction_repo,
        market_repo=market_repo,
        symbols=tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols),
    )
    if args.json:
        import json as _json

        print(_json.dumps(status, indent=2))
    else:
        print(format_status(status))
    return 0


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------


def cmd_live_proof(args: argparse.Namespace) -> int:
    """The one command that proves the system on a real market, or says why not."""
    from forecaster.cli.live_proof import run_live_proof

    _, install_quiet = _quiet_transport_noise()
    config = load_config()
    return run_live_proof(
        venue=args.venue or config.venue,
        transport=args.transport,
        symbols=tuple(args.symbols.split(",")) if args.symbols else tuple(config.symbols),
        horizons_s=tuple(int(h) for h in args.horizons.split(",")) if args.horizons else HORIZONS_S,
        minutes=args.minutes,
        warmup_s=args.warmup_s,
        sample_every_s=args.interval,
        output=args.json,
        ws_url=args.ws_url,
        rest_url=args.rest_url,
        quiet_install=install_quiet,
    )


def cmd_conformance(args: argparse.Namespace) -> int:
    """Exercise the entire live path against a local wire-protocol server."""
    from forecaster.cli.conformance_run import run_conformance

    return run_conformance(seconds=args.seconds, output=args.output)


def cmd_verify(args: argparse.Namespace) -> int:
    from forecaster.cli.verify import run_verification

    return run_verification(seeds=args.seeds, output=args.output, quick=args.quick)


# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="forecaster",
        description="Short-horizon crypto probability forecaster.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("simulate", help="generate simulated market data")
    p.add_argument("--duration", type=float, default=14_400, help="seconds of market to generate")
    p.add_argument("--seed", type=int, default=20260909)
    p.add_argument(
        "--regime",
        default="realistic",
        choices=["gbm", "realistic", "martingale", "alpha", "dirty"],
        help="realistic for normal use; martingale is the leakage gate; gbm has an analytic answer",
    )
    p.add_argument("--symbols", default=None)
    p.add_argument("--capture", default=None, help="also write an NDJSON capture here")
    p.add_argument("--reset", action="store_true", help="clear existing simulated data first")
    p.add_argument("--anchor-now", action="store_true", help="end the simulation at the present")
    p.add_argument("--start-ns", type=int, default=None)
    p.set_defaults(func=cmd_simulate, start_ns=0)

    p = sub.add_parser("collect", help="collect live market data")
    p.add_argument("--venue", default=None, choices=["coinbase", "binance", "kraken"])
    p.add_argument("--transport", default=None, choices=["websocket", "poll"])
    p.add_argument("--symbols", default=None)
    p.add_argument("--capture", default=None)
    p.add_argument("--max-events", type=int, default=None)
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("train", help="train and evaluate models")
    p.add_argument("--data-source", default="simulated", choices=["live", "replay", "simulated"])
    p.add_argument("--venue", default=None)
    p.add_argument("--symbols", default=None)
    p.add_argument("--horizons", default=None)
    p.add_argument("--warmup", type=int, default=3600)
    p.add_argument("--sample-interval", type=int, default=15)
    p.add_argument("--baseline-only", action="store_true", help="fit the baseline and stop")
    p.set_defaults(func=cmd_train, start_ns=None, end_ns=None)

    p = sub.add_parser("backtest", help="replay history and score every forecast")
    p.add_argument("--data-source", default="simulated", choices=["live", "replay", "simulated"])
    p.add_argument("--venue", default=None)
    p.add_argument("--symbol", default=None)
    p.add_argument("--step", type=int, default=60, help="seconds between forecast instants")
    p.add_argument("--warmup", type=int, default=3600)
    p.add_argument("--persist", action="store_true", help="write results to the predictions table")
    p.add_argument("--json", default=None, help="write the full report here")
    p.set_defaults(func=cmd_backtest, start_ns=None, end_ns=None)

    p = sub.add_parser("evaluate", help="score forecasts whose horizon has passed")
    p.add_argument("--at-ns", type=int, default=None)
    p.add_argument("--limit", type=int, default=5_000)
    p.set_defaults(func=cmd_evaluate)

    p = sub.add_parser("report", help="performance statistics")
    p.add_argument("--data-source", default=None)
    p.add_argument("--mode", default="live", choices=["live", "backfill"])
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("serve", help="run the API and the collector")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--log-level", default="info")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("live-check", help="verify a real venue's prices, in one step")
    p.add_argument("--venue", default=None)
    p.add_argument("--symbols", default=None)
    p.add_argument("--transport", default="websocket", choices=("websocket", "poll"))
    p.add_argument("--seconds", type=float, default=30.0)
    p.add_argument("--json", default=None, help="also write the report here")
    p.add_argument("--ws-url", default=None, help=argparse.SUPPRESS)
    p.add_argument("--rest-url", default=None, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_live_check)

    p = sub.add_parser("collect-live", help="collect live data and forecast against it")
    p.add_argument("--venue", default=None)
    p.add_argument("--symbols", default=None)
    p.add_argument("--transport", default="websocket", choices=("websocket", "poll"))
    p.add_argument("--horizons", default=None, help="comma separated seconds")
    p.add_argument(
        "--interval",
        type=float,
        default=None,
        help=(
            "seconds between sampling instants (default: the horizon, so forecasts never overlap)"
        ),
    )
    p.add_argument("--seconds", type=float, default=None, help="stop after this long")
    p.add_argument("--ws-url", default=None, help=argparse.SUPPRESS)
    p.add_argument("--rest-url", default=None, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_collect_live)

    p = sub.add_parser("live-report", help="the real-market validation report")
    p.add_argument("--symbols", default=None)
    p.add_argument("--horizons", default=None)
    p.add_argument("--data-source", default="live", choices=("live", "replay", "simulated"))
    p.add_argument("--json", default=None)
    p.set_defaults(func=cmd_live_report)

    p = sub.add_parser("live-status", help="collection progress and feed health")
    p.add_argument("--symbols", default=None)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_live_status)

    p = sub.add_parser("live-proof", help="the one command that proves the system on a real market")
    p.add_argument("--venue", default=None)
    p.add_argument("--symbols", default=None)
    p.add_argument("--transport", default="websocket", choices=("websocket", "poll"))
    p.add_argument("--horizons", default=None, help="comma separated seconds")
    p.add_argument("--minutes", type=float, default=75.0, help="wall-clock budget")
    p.add_argument(
        "--warmup-s",
        type=float,
        default=1800.0,
        help=(
            "seconds of market to collect before expecting a forecast. The default "
            "is the volatility model's own minimum and lowering it will not make it "
            "speak sooner — it only shortens the budget"
        ),
    )
    p.add_argument("--interval", type=float, default=None, help=argparse.SUPPRESS)
    p.add_argument("--json", default=None)
    p.add_argument("--ws-url", default=None, help=argparse.SUPPRESS)
    p.add_argument("--rest-url", default=None, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_live_proof)

    p = sub.add_parser(
        "conformance", help="exercise the live path against a local wire-protocol server"
    )
    p.add_argument("--seconds", type=float, default=60.0)
    p.add_argument("--output", default=None)
    p.set_defaults(func=cmd_conformance)

    p = sub.add_parser("verify", help="run the full offline verification suite")
    p.add_argument("--seeds", type=int, default=8)
    p.add_argument("--output", default=None)
    p.add_argument("--quick", action="store_true")
    p.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
