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
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.config import Config, load_config
from forecaster.types import NS_PER_SECOND, DataSource


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
# verify
# ---------------------------------------------------------------------------


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
