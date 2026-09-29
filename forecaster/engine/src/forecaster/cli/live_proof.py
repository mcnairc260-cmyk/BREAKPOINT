"""One command that proves — or fails to prove — that this system works on a real market.

Everything else in this repository can be run offline. This cannot, and that is
the point: it is the single procedure whose passing means "real BTC and ETH data
went in, real forecasts came out, their horizons expired, and their outcomes were
recorded from the venue's own prints".

It is written to be started once, on a machine with ordinary internet access, and
left alone. It takes about an hour. Most of that is waiting, and the waiting is
not padding:

* **~30 minutes of warm-up.** The volatility model refuses to speak until it has
  seen thirty minutes of market. That refusal is the product working, not an
  inconvenience to route around. A shortcut exists — Coinbase publishes 60-second
  candles going back hours — and it is deliberately not taken, because those
  candles cannot feed the one-second bars the estimator reads, and widening the
  estimator to accept coarser data to make a demo finish sooner would weaken the
  safeguard it was built to enforce.
* **~20 minutes for the longer horizon to expire.** A 20-minute forecast cannot
  be resolved in less than 20 minutes. There is no version of this that is fast.

Each stage reports PASS or FAIL with the number it observed, and the verdict at
the end is one of three things:

* **PROVEN** — live venue data, forecasts made, horizons expired, outcomes
  recorded, survived a restart.
* **NOT LIVE** — the procedure ran end to end, but against something that is not
  a venue endpoint. Everything is exercised and nothing is proven about a real
  market. This is what the conformance harness produces, and it exits non-zero so
  it can never be mistaken for the real thing.
* **BLOCKED** — no market data arrived at all. Reported with the exact transport
  error, because "it didn't work" is not a diagnosis.

The exit code is 0 only for PROVEN.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.config import Config, load_config
from forecaster.marketdata.provider import MarketDataProvider
from forecaster.models.baseline import MIN_HISTORY_NS, BaselineModel
from forecaster.quality import QualityMonitor
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine
from forecaster.service.evaluator import Evaluator
from forecaster.service.livecheck import live_check
from forecaster.service.livereport import live_validation_report, monotonicity_violations
from forecaster.service.liverunner import LiveRunner
from forecaster.store import (
    MarketRepository,
    PredictionRepository,
    QualityRepository,
    open_database,
)
from forecaster.types import NS_PER_SECOND, DataSource, Outcome

#: How long to sample the feed before deciding the prices are trustworthy.
CHECK_SECONDS = 30.0

#: Safety margin on top of the longest horizon, so a forecast written a moment
#: before the deadline still gets a chance to expire and be scored.
EXPIRY_MARGIN_S = 90.0

#: Above this, the connection is reconnecting more than it is streaming. Set
#: generously — a healthy venue feed reconnects a handful of times an hour, and
#: six a minute is already an order of magnitude worse than that.
MAX_RECONNECTS_PER_MINUTE = 6.0

VERDICT_PROVEN = "PROVEN"
VERDICT_NOT_LIVE = "NOT LIVE"
VERDICT_BLOCKED = "BLOCKED"
VERDICT_FAILED = "FAILED"


@dataclass
class Stage:
    name: str
    ok: bool
    detail: str
    observed: Any = None

    def to_dict(self) -> dict[str, Any]:
        return {"stage": self.name, "ok": self.ok, "detail": self.detail, "observed": self.observed}


@dataclass
class Proof:
    venue: str
    transport: str
    horizons_s: tuple[int, ...]
    started_ns: int = field(default_factory=now_ns)
    stages: list[Stage] = field(default_factory=list)
    data_source: str = DataSource.SIMULATED.value
    endpoint: str | None = None
    symbols_with_trades: list[str] = field(default_factory=list)
    symbols_with_quotes: list[str] = field(default_factory=list)
    forecasts: int = 0
    resolved: int = 0
    void: int = 0
    by_symbol_horizon: dict[str, dict[str, int]] = field(default_factory=dict)
    restart_ok: bool = False
    duplicates: int = 0
    monotonicity_violations: int = 0
    reconnects: int = 0
    report: dict[str, Any] | None = None
    error: str | None = None

    def add(self, name: str, ok: bool, detail: str, observed: Any = None) -> Stage:
        stage = Stage(name=name, ok=ok, detail=detail, observed=observed)
        self.stages.append(stage)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<44} {detail}", flush=True)
        return stage

    #: The stage that only records whether this was a venue at all. It is
    #: excluded from "did everything pass" because failing it is not a fault in
    #: the system — it is the whole difference between NOT LIVE and PROVEN, and
    #: reporting a flawless conformance run as FAILED buried that distinction.
    ENDPOINT_STAGE = "endpoint is a real venue"

    @property
    def all_stages_passed(self) -> bool:
        return all(s.ok for s in self.stages if s.name != self.ENDPOINT_STAGE)

    @property
    def is_live(self) -> bool:
        return self.data_source == DataSource.LIVE.value

    def scope(self) -> str:
        """What this run is, in one sentence, keyed off what actually happened.

        Not off the endpoint alone. An earlier version said "Real venue market
        data" whenever the hostname was a venue — including on runs where nothing
        arrived at all, which is the opposite of true and exactly the sentence
        someone would quote.
        """
        verdict = self.verdict()
        if verdict == VERDICT_PROVEN:
            return "Real venue market data, forecast and resolved end to end."
        if verdict == VERDICT_BLOCKED:
            return (
                "No market data was received. Nothing was forecast and nothing is "
                "proven either way."
            )
        if verdict == VERDICT_NOT_LIVE:
            return (
                "NOT real market data — this run did not talk to a venue endpoint, "
                "so nothing here is evidence about a real market."
            )
        return (
            "The procedure ran and at least one check failed. See the stages; this "
            "is not a proof of anything."
        )

    def verdict(self) -> str:
        if self.error and self.forecasts == 0 and not self.symbols_with_trades:
            return VERDICT_BLOCKED
        if not self.all_stages_passed:
            return VERDICT_FAILED
        if not self.is_live:
            return VERDICT_NOT_LIVE
        return VERDICT_PROVEN

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict(),
            "scope": self.scope(),
            "venue": self.venue,
            "transport": self.transport,
            "endpoint": self.endpoint,
            "data_source": self.data_source,
            "horizons_s": list(self.horizons_s),
            "started": iso(self.started_ns),
            "finished": iso(now_ns()),
            "duration_s": (now_ns() - self.started_ns) / NS_PER_SECOND,
            "real_btc_received": "BTC-USD" in self.symbols_with_trades,
            "real_eth_received": "ETH-USD" in self.symbols_with_trades,
            "symbols_with_trades": self.symbols_with_trades,
            "symbols_with_quotes": self.symbols_with_quotes,
            "forecasts_generated": self.forecasts,
            "forecasts_resolved": self.resolved,
            "forecasts_void": self.void,
            "by_symbol_horizon": self.by_symbol_horizon,
            "restart_recovery_ok": self.restart_ok,
            "duplicate_outcomes": self.duplicates,
            "monotonicity_violations": self.monotonicity_violations,
            "reconnects": self.reconnects,
            "stages": [s.to_dict() for s in self.stages],
            "validation_report": self.report,
            "error": self.error,
        }


def _banner(proof: Proof, warmup_s: float, budget_s: float) -> None:
    print("")
    print("  LIVE MARKET PROOF")
    print(f"  {'─' * 72}")
    print(f"  venue      {proof.venue} over {proof.transport}")
    print("  symbols    BTC-USD, ETH-USD")
    print(f"  horizons   {', '.join(f'{h}s' for h in proof.horizons_s)}")
    print(f"  budget     up to {budget_s / 60:.0f} minutes")
    print("")
    print("  This takes about an hour and most of it is waiting:")
    longest = max(proof.horizons_s)
    if warmup_s >= 300:
        print(
            f"    ~{warmup_s / 60:.0f} min  the volatility model refuses to forecast until it has"
        )
        print("            seen enough market. That refusal is the product working.")
    else:
        print(f"    {warmup_s:.0f}s     warm-up (shortened: history is being supplied another way)")
    if longest >= 60:
        print(
            f"    ~{2 * longest / 60:.0f} min  up to {longest // 60} minutes waiting for the "
            f"first {longest // 60}-minute forecast to be"
        )
        print(f"            sampled, then {longest // 60} more for it to expire. It is sampled")
        print("            once per horizon so that no two forecasts overlap.")
    else:
        print(f"    {longest}s      a {longest}-second forecast cannot be resolved any sooner.")
    print("")
    print("  Leave it running. Nothing needs attention unless a stage fails.")
    print("")


async def _run(
    *,
    make_provider: Callable[[], MarketDataProvider],
    config: Config,
    symbols: tuple[str, ...],
    horizons_s: tuple[int, ...],
    workdir: Path,
    budget_s: float,
    warmup_s: float,
    sample_every_s: float | None,
    endpoint: str | None,
    transport: str,
) -> Proof:
    # A provider per stage, deliberately.
    #
    # `live_check` owns the lifecycle of the feed it samples and closes it when
    # it is done, which permanently stops the reconnect loop on that object.
    # Handing the same instance to the collector afterwards produced a proof that
    # ran for twenty-two minutes, made zero forecasts and reported "service level
    # down" — a failure that would have looked identical against a real venue and
    # cost an hour to discover there.
    checker = make_provider()
    proof = Proof(venue=checker.venue, transport=transport, horizons_s=horizons_s)
    proof.data_source = checker.data_source.value
    proof.endpoint = endpoint
    deadline = time.monotonic() + budget_s

    # -- stage 1: is this a venue at all -----------------------------------
    proof.add(
        "endpoint is a real venue",
        checker.data_source is DataSource.LIVE,
        f"data_source={checker.data_source.value.upper()}"
        + ("" if checker.data_source is DataSource.LIVE else "  (not a venue host)"),
        checker.data_source.value,
    )

    # -- stage 2: do its prices mean what we think -------------------------
    check = await live_check(
        checker,
        symbols=symbols,
        seconds=CHECK_SECONDS,
        transport=transport,
        ws_url=endpoint,
    )
    proof.symbols_with_trades = [s for s, d in check.symbols.items() if d["trades"] > 0]
    proof.symbols_with_quotes = [s for s, d in check.symbols.items() if d["quotes"] > 0]
    proof.error = check.error
    passed = len([c for c in check.checks if c.status == "PASS"])
    proof.add(
        "live prices verified",
        check.ok,
        f"{passed} checks passed, {len(check.failures)} failed, {check.events:,} events"
        + (f" — {check.error}" if check.error else ""),
        {"passed": passed, "failed": len(check.failures), "events": check.events},
    )
    for symbol in symbols:
        data = check.symbols.get(symbol, {})
        if data.get("last_trade_price"):
            print(
                f"         {symbol}: {data['last_trade_price']:,.2f}  "
                f"bid {data['bid']:,.2f} / ask {data['ask']:,.2f}  "
                f"mid {data['midpoint']:,.2f}  spread {data['spread_bps']:.2f} bps"
            )
    if check.events == 0:
        proof.add(
            "market data received",
            False,
            "nothing arrived — the rest of the proof cannot run",
            0,
        )
        return proof
    proof.add(
        "real BTC and ETH trades received",
        {"BTC-USD", "ETH-USD"} <= set(proof.symbols_with_trades),
        f"trades for {', '.join(proof.symbols_with_trades) or 'nothing'}",
        proof.symbols_with_trades,
    )

    # -- stage 3: collect, forecast, expire, resolve ------------------------
    url = f"sqlite:///{workdir}/live-proof.db"
    database = open_database(url)
    market = MarketRepository(database)
    predictions = PredictionRepository(database)
    quality = QualityRepository(database)
    proof_config = Config(database_url=url, data_dir=workdir, artifact_dir=workdir)

    # Stage 3 gets its own connection: the one above has been closed.
    feed = make_provider()
    collector = Collector(
        provider=feed,
        market_repo=market,
        quality_repo=quality,
        symbols=symbols,
        bar_resolutions_s=config.bar_resolutions_s,
        monitor=QualityMonitor(config.quality),
    )
    runner = LiveRunner(
        provider=feed,
        collector=collector,
        engine=ForecastEngine(baseline=BaselineModel(config=config.model), config=proof_config),
        prediction_repo=predictions,
        market_repo=market,
        config=proof_config,
        symbols=symbols,
        horizons_s=horizons_s,
        interval_s=(dict.fromkeys(horizons_s, sample_every_s) if sample_every_s else None),
        status_path=workdir / "live_proof_status.json",
    )

    # Twice the longest horizon, not once.
    #
    # The first real run of this procedure spent fifty-two minutes on live
    # Coinbase data, resolved every five-minute forecast, and resolved none of
    # the twenty-minute ones — because the budget assumed a forecast is made the
    # instant the warm-up ends. It is not. A horizon-H forecast is sampled once
    # every H seconds, so the first tick after a thirty-minute warm-up can be
    # almost a full H away, and only then does the H-second horizon start. Worst
    # case is warm-up + H (waiting for the tick) + H (the horizon itself).
    #
    # Budgeting one H produced a run that failed on the one stage it existed to
    # demonstrate, and the arithmetic was exactly right: forecasts made at minute
    # forty expire at minute sixty, and the run stopped at fifty-two.
    remaining = max(deadline - time.monotonic(), 60.0)
    longest = max(horizons_s)
    needed = warmup_s + 2 * longest + EXPIRY_MARGIN_S
    run_for = min(remaining, needed)
    if run_for < needed:
        print(
            f"  WARNING: {run_for / 60:.0f} minutes left but {needed / 60:.0f} are needed for a "
            f"{longest // 60}-minute forecast to be made and then expire."
        )
        print("           Raise --minutes, or the longest horizon will not resolve.")
    print("")
    print(f"  collecting and forecasting for {run_for / 60:.0f} minutes…", flush=True)
    status = await runner.run(seconds=run_for)
    proof.reconnects = status.reconnects

    provider_error = feed.health.last_error
    rows = predictions.history(limit=1_000_000, prediction_mode="live")
    proof.forecasts = len(rows)
    proof.add(
        "forecasts generated on live data",
        len(rows) > 0,
        f"{len(rows):,} forecasts from {sum(p.instants for p in status.progress.values())} "
        "sampling instants",
        len(rows),
    )
    if not rows:
        last_refusal = next(
            (p.last_refusal for p in status.progress.values() if p.last_refusal), None
        )
        proof.add(
            "reason no forecast was made",
            False,
            last_refusal or "unknown",
            last_refusal,
        )
        return proof

    for horizon in horizons_s:
        for symbol in symbols:
            key = f"{symbol}|{horizon}"
            mine = [r for r in rows if r["symbol"] == symbol and int(r["horizon_s"]) == horizon]
            done = [r for r in mine if r["outcome"] is not None]
            proof.by_symbol_horizon[key] = {"generated": len(mine), "resolved": len(done)}

    scored = [r for r in rows if r["outcome"] is not None]
    resolved = [
        r
        for r in scored
        if str(r["outcome"]) not in (Outcome.VOID_GAP.value, Outcome.VOID_HALT.value)
    ]
    proof.resolved = len(resolved)
    proof.void = len(scored) - len(resolved)
    proof.add(
        "forecasts expired and were scored",
        len(resolved) > 0,
        f"{len(resolved):,} resolved, {proof.void:,} void",
        len(resolved),
    )
    covered = {h for h in horizons_s if any(int(r["horizon_s"]) == h for r in resolved)}
    proof.add(
        "every horizon produced a resolved forecast",
        covered == set(horizons_s),
        f"resolved at {', '.join(f'{h}s' for h in sorted(covered)) or 'no horizon'}",
        sorted(covered),
    )

    # A feed that reconnects more than it streams is not a feed, even when some
    # data gets through. The first live run logged 7,212 reconnects in 52 minutes
    # — 139 a minute — and every other stage passed, so nothing said a word about
    # it. Data arriving is not the same as the connection being healthy, and the
    # difference matters for anything measured from microstructure.
    minutes = max(run_for / 60.0, 1.0)
    rate = proof.reconnects / minutes
    proof.add(
        "feed stayed connected",
        rate <= MAX_RECONNECTS_PER_MINUTE,
        f"{proof.reconnects:,} reconnects in {minutes:.0f} min ({rate:.1f}/min)"
        + (
            ""
            if rate <= MAX_RECONNECTS_PER_MINUTE
            else f" — last error: {provider_error or 'none recorded'}"
        ),
        {"reconnects": proof.reconnects, "per_minute": round(rate, 2)},
    )

    violations, checked = monotonicity_violations(rows)
    proof.monotonicity_violations = violations
    proof.add(
        "probability never rises with the target",
        checked > 0 and violations == 0,
        f"{violations} violations in {checked:,} adjacent target pairs",
        violations,
    )

    # -- stage 4: restart ---------------------------------------------------
    del runner, collector, predictions, market, database
    database2 = open_database(url)
    predictions2 = PredictionRepository(database2)
    market2 = MarketRepository(database2)
    after = predictions2.history(limit=1_000_000, prediction_mode="live")
    survived = len(after) == len(rows)
    try:
        chained = predictions2.verify_chain()
        chain_ok = True
    except Exception as exc:
        chained, chain_ok = 0, False
        proof.error = f"{type(exc).__name__}: {exc}"
    proof.add(
        "predictions survive a restart",
        survived and chain_ok,
        f"{len(after):,} of {len(rows):,} present, chain {'intact' if chain_ok else 'BROKEN'}"
        + (f" ({chained:,} rows)" if chain_ok else ""),
        {"before": len(rows), "after": len(after), "chain_ok": chain_ok},
    )

    evaluator = Evaluator(prediction_repo=predictions2, market_repo=market2, quality=config.quality)
    before_outcomes = len([r for r in after if r["outcome"] is not None])
    second = evaluator.run_once(at_ns=now_ns())
    final = predictions2.history(limit=1_000_000, prediction_mode="live")
    after_outcomes = len([r for r in final if r["outcome"] is not None])
    ids = [int(r["id"]) for r in final if r["outcome"] is not None]
    proof.duplicates = len(ids) - len(set(ids))
    proof.restart_ok = survived and chain_ok and proof.duplicates == 0
    proof.add(
        "no outcome recorded twice after restart",
        proof.duplicates == 0,
        f"{before_outcomes:,} outcomes before, {after_outcomes:,} after a second "
        f"evaluation pass ({second.checked} newly due), {proof.duplicates} duplicates",
        proof.duplicates,
    )

    # -- stage 5: the report ------------------------------------------------
    proof.report = live_validation_report(
        prediction_repo=predictions2,
        quality_repo=QualityRepository(database2),
        symbols=symbols,
        horizons_s=horizons_s,
        data_source=feed.data_source,
        reconnects=proof.reconnects,
    )
    proof.add(
        "validation report generated",
        proof.report["totals"]["resolved"] > 0,
        proof.report["headline"][:90],
        proof.report["totals"],
    )
    return proof


async def _choose_venue(preferred: str | None) -> tuple[str | None, list[Any], str]:
    """Find a venue that actually answers, preferring the one asked for.

    Run before anything else when `--auto` is given. On a restricted network this
    turns an hour of waiting for a feed that will never arrive into fifteen
    seconds and a clear sentence about why.
    """
    from forecaster.marketdata.venues.catalog import VENUES, first_usable, probe_all

    order = VENUES
    if preferred:
        order = tuple(sorted(VENUES, key=lambda spec: (spec.name != preferred, VENUES.index(spec))))
    probes = await probe_all(order, include_ws=False)
    usable = first_usable(probes)
    if usable is None:
        reachable = [p.venue for p in probes if p.usable]
        if reachable:
            return (
                None,
                probes,
                (f"{', '.join(reachable)} answered but has no adapter in this build"),
            )
        return None, probes, "no venue answered — see `forecaster probe-venues`"
    return usable.venue, probes, f"{usable.venue} answered with real public market data"


def run_live_proof(
    *,
    venue: str | None = None,
    transport: str = "websocket",
    symbols: tuple[str, ...] | None = None,
    horizons_s: tuple[int, ...] = (300, 1200),
    minutes: float = 85.0,
    warmup_s: float = float(MIN_HISTORY_NS) / NS_PER_SECOND,
    sample_every_s: float | None = None,
    output: str | None = None,
    ws_url: str | None = None,
    rest_url: str | None = None,
    auto: bool = False,
    quiet_install: Any = None,
) -> int:
    """Run the whole proof. Returns a process exit code: 0 only for PROVEN."""
    import tempfile

    from forecaster.marketdata.venues import build_venue_provider

    config = load_config()
    venue = venue or config.venue
    symbols = symbols or ("BTC-USD", "ETH-USD")

    if auto and not (ws_url or rest_url):
        print("")
        print("  checking which venues this machine can reach…", flush=True)
        chosen, _probes, reason = asyncio.run(_choose_venue(venue))
        print(f"  {reason}")
        if chosen is None:
            print("")
            print("  VERDICT: BLOCKED")
            print("")
            print("  No exchange is reachable from this machine, so there is nothing to")
            print("  prove against. `forecaster probe-venues` shows which layer fails for")
            print("  each venue. Run this on a network without an egress policy.")
            print("")
            return 1
        venue = chosen

    overrides: dict[str, str] = {}
    if ws_url:
        overrides["ws_url"] = ws_url
    if rest_url:
        overrides["rest_url"] = rest_url

    def make_provider() -> MarketDataProvider:
        return build_venue_provider(venue, symbols=symbols, transport=transport, **overrides)

    proof = Proof(venue=venue, transport=transport, horizons_s=horizons_s)
    _banner(proof, warmup_s, minutes * 60.0)

    async def go() -> Proof:
        if quiet_install is not None:
            quiet_install()
        with tempfile.TemporaryDirectory(prefix="live-proof-") as tmp:
            return await _run(
                make_provider=make_provider,
                config=config,
                symbols=symbols,
                horizons_s=horizons_s,
                workdir=Path(tmp),
                budget_s=minutes * 60.0,
                warmup_s=warmup_s,
                sample_every_s=sample_every_s,
                endpoint=ws_url or rest_url,
                transport=transport,
            )

    result = asyncio.run(go())
    verdict = result.verdict()

    print("")
    print(f"  VERDICT: {verdict}")
    print("")
    if verdict == VERDICT_PROVEN:
        print("  Real venue data went in, real forecasts came out, their horizons")
        print("  expired, and their outcomes were recorded from the venue's own prints.")
        print("  That is proof the application works on a live market.")
        print("  It is NOT evidence that the forecasts are any good — that needs days")
        print("  of collection and is measured by `forecaster live-report`.")
    elif verdict == VERDICT_NOT_LIVE:
        print("  Every stage ran, against something that is not a venue endpoint.")
        print("  The pipeline is exercised end to end and nothing here is evidence")
        print("  about a real market. Re-run against a venue to prove that.")
    elif verdict == VERDICT_BLOCKED:
        print("  No market data arrived. The adapter is not the problem; the route is.")
        print(f"  Last transport error: {result.error or 'none recorded'}")
        # Transport-aware. Telling someone to try the transport they just tried
        # is worse than saying nothing: it reads as a script that did not look.
        if transport == "websocket":
            print("  Many networks block WebSocket upgrades but allow plain HTTPS.")
            print('  Try:  make live-proof ARGS="--transport poll"')
        else:
            print("  Plain HTTPS to the venue is refused too, so this is the network")
            print("  or an egress policy rather than the protocol. Run this from a")
            print("  machine with ordinary internet access.")
    else:
        print("  The procedure ran and something it checks is wrong. The failing")
        print("  stages are listed above, each with the number that failed it.")
    print("")

    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(json.dumps(result.to_dict(), indent=2))
        print(f"  written to {output}")
        print("")

    print(summary_block(result))
    return 0 if verdict == VERDICT_PROVEN else 1


def summary_block(proof: Proof) -> str:
    """A self-contained block to copy out of the terminal.

    Everything someone needs to judge the run, in one paste, with no reference to
    anything that is not in it. The verdict and the scope line come first so that
    a block quoted out of context still says what it is — a NOT LIVE run pasted
    without its header would otherwise read as a real-market result, which is the
    one misreading this whole procedure exists to prevent.
    """
    data = proof.to_dict()
    cells = data["by_symbol_horizon"] or {}
    lines = [
        "```",
        "FORECASTER LIVE MARKET PROOF",
        f"verdict          : {data['verdict']}",
        f"scope            : {data['scope']}",
        f"venue            : {data['venue']} over {data['transport']}",
        f"data source      : {data['data_source'].upper()}",
        f"started          : {data['started']}",
        f"finished         : {data['finished']}  ({data['duration_s'] / 60:.1f} min)",
        f"real BTC received: {data['real_btc_received']}",
        f"real ETH received: {data['real_eth_received']}",
        f"forecasts        : {data['forecasts_generated']} generated, "
        f"{data['forecasts_resolved']} resolved, {data['forecasts_void']} void",
        f"restart recovery : {'ok' if data['restart_recovery_ok'] else 'NOT VERIFIED'}"
        f"  (duplicate outcomes: {data['duplicate_outcomes']})",
        f"monotonicity     : {data['monotonicity_violations']} violations",
        f"reconnects       : {data['reconnects']}",
    ]
    if cells:
        lines.append("per cell         :")
        for key, counts in sorted(cells.items()):
            symbol, horizon = key.split("|")
            lines.append(
                f"  {symbol} {int(horizon) // 60}m: "
                f"{counts['generated']} generated, {counts['resolved']} resolved"
            )
    lines.append("stages           :")
    for stage in data["stages"]:
        mark = "PASS" if stage["ok"] else "FAIL"
        lines.append(f"  [{mark}] {stage['stage']} — {stage['detail']}")
    if data["error"]:
        lines.append(f"error            : {data['error']}")
    lines.append("")
    if data["verdict"] == VERDICT_PROVEN:
        lines.append("This proves operational correctness on live market data. It does NOT")
        lines.append("show forecast skill: that needs days of collection and is measured")
        lines.append("separately by `forecaster live-report`. Two different claims.")
    elif data["verdict"] == VERDICT_NOT_LIVE:
        lines.append("Nothing here is evidence about a real market. The software works;")
        lines.append("the endpoint was not an exchange.")
    elif data["verdict"] == VERDICT_BLOCKED:
        lines.append("No exchange was reachable, so nothing was proven either way. Run")
        lines.append("`forecaster probe-venues` to see which layer fails for each venue.")
    else:
        lines.append("At least one check failed. This is not a proof; see the stages above.")
    lines.append("```")
    return "\n".join(lines)
