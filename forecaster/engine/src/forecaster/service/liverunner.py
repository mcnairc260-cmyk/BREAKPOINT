"""The unattended collector: gather real market data and forecast against it, for days.

This is the process that turns "the application works" into "the application has
a track record". Nothing else in the repository can produce the one thing the
project still lacks, which is outcomes from a real market. It is therefore
written to the standard of something that will be started once and not looked at
again for a week.

## The sampling interval, and why it is the horizon

The obvious design is to forecast as often as possible. It is wrong, and wrong in
the direction that flatters the result.

A 5-minute forecast made now and another made one second from now share 299 of
their 300 seconds. They are not two pieces of evidence; they are one piece of
evidence counted twice. Sample every second for a day and the log holds 86,400
five-minute forecasts built from 288 independent observations — a row count 300
times larger than the evidence behind it. Every confidence interval computed from
that row count is roughly seventeen times too narrow, and a model comparison run
on it will find significance that is not there.

So each (symbol, horizon) pair is sampled **once per horizon**. Every forecast a
symbol makes at a given horizon is disjoint from the one before it, which means
`n_rows` and `n_non_overlapping` are the same number and there is nothing to
correct for later. The cost is a lower row count. The benefit is that the row
count is true.

At the default settings that is 288 five-minute and 72 twenty-minute sampling
instants per symbol per day.

## The target ladder

A forecast needs a target price, and a single target per instant would only ever
exercise one part of the probability range. Calibration is a statement about the
whole range — when the system says 20%, does it happen 20% of the time? — so it
cannot be measured from targets that all sit at the money.

Each sampling instant therefore emits one forecast per rung of a ladder placed in
**volatility units**, not dollars, so the ladder means the same thing in a calm
market and a violent one, and the same thing for BTC as for ETH. The six rungs
are the six cases worth distinguishing:

| rung | z      | what it asks                                    |
|------|--------|-------------------------------------------------|
| A    |  0.00  | essentially the current price                   |
| B    | +0.25  | modestly above                                  |
| C    | −0.25  | modestly below                                  |
| D    | +1.00  | about one expected move above                   |
| E    | −1.00  | about one expected move below                   |
| F    | +2.50  | substantially farther than the market should go |

The six targets from one instant are **not** six independent observations — they
are six views of the same future price. The report counts distinct timestamps
separately from rows for exactly this reason, and the learner-training threshold
is counted in non-overlapping observations, never in rows.

## Refusing to run

The runner does not forecast until the baseline has enough history to estimate
volatility, and it does not forecast when the feed is stale. Both refusals are
recorded and reported. A gap in the track record is a fact about the feed; a
forecast made from a stale price is a lie about the market.

## Never dying

A collector that stops is worse than one that never started, because the data it
would have gathered cannot be recovered afterwards. Every loop therefore catches
and records its own failures rather than propagating them, the provider
reconnects with backoff underneath, and the status file says plainly when the
last event arrived so an operator can tell "quiet" from "dead".
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.config import Config
from forecaster.marketdata.provider import MarketDataProvider
from forecaster.service.collector import Collector
from forecaster.service.engine import ForecastEngine, ForecastRefused
from forecaster.service.evaluator import Evaluator
from forecaster.service.persist import prediction_row
from forecaster.store import MarketRepository, PredictionRepository
from forecaster.types import HORIZONS_S, NS_PER_SECOND, PredictionMode, ServiceLevel

#: The ladder, in standard deviations of the horizon return. See the table above.
TARGET_LADDER_Z: tuple[float, ...] = (0.0, 0.25, -0.25, 1.0, -1.0, 2.5)

#: How often the status file is rewritten. Frequent enough to tell a stalled
#: process from a quiet market, cheap enough to ignore.
STATUS_INTERVAL_S = 5.0

#: How often expired forecasts are scored.
EVALUATE_INTERVAL_S = 5.0

#: Slack between the last forecast a bounded run may start and the run's end, on
#: top of the horizon itself, so the evaluator has time to score it.
SAMPLING_CUTOFF_MARGIN_S = 120.0

#: How long the whole feed may deliver nothing before the run is abandoned.
#:
#: A socket that reconnects and then stays silent is the worst shape of failure
#: this collector has: `sample_once` correctly refuses to forecast without fresh
#: ticks, so the run writes nothing further, records no error, and exits 0.
#: Segment 36 spent 3h25m in that state after a single reconnect, and reported
#: success.
#:
#: Ending the run is the cheap repair, because a segment is one of many: it
#: commits what it has and the next run opens a new connection, so a dead feed
#: costs minutes instead of hours. Ten minutes is far outside anything a quiet
#: market produces -- BTC and ETH together delivered about three trades a second
#: through every healthy segment -- so this cannot fire on a real lull.
FEED_SILENCE_ABORT_S = 600.0

STATUS_FILENAME = "live_runner_status.json"


@dataclass
class SymbolProgress:
    """Per-symbol accounting, reported and never inferred."""

    symbol: str
    forecasts: int = 0
    instants: int = 0
    refusals: int = 0
    last_refusal: str | None = None
    last_forecast_ns: int | None = None
    by_horizon: dict[int, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "forecasts": self.forecasts,
            "sampling_instants": self.instants,
            "refusals": self.refusals,
            "last_refusal": self.last_refusal,
            "last_forecast": iso(self.last_forecast_ns) if self.last_forecast_ns else None,
            "instants_by_horizon": {str(k): v for k, v in sorted(self.by_horizon.items())},
        }


@dataclass
class RunnerStatus:
    """What an operator needs to answer 'is this working?' without reading code."""

    started_ns: int
    venue: str
    data_source: str
    symbols: tuple[str, ...]
    horizons_s: tuple[int, ...]
    interval_s: dict[int, float]
    ladder_z: tuple[float, ...]
    connected: bool = False
    last_event_ns: int | None = None
    reconnects: int = 0
    malformed: int = 0
    stale_events: int = 0
    evaluated: int = 0
    voided: int = 0
    stopped: bool = False
    abandoned_reason: str | None = None
    """Set when the run ended itself rather than reaching its own deadline."""
    sampling_deadline_ns: int | None = None
    """When a bounded run stops starting new forecasts. See `LiveRunner.run`."""
    """Set on clean shutdown. Without it a status file written seconds before the
    process exited reads as a running collector for as long as the staleness
    window lasts, which is the one question this file exists to answer."""
    errors: list[str] = field(default_factory=list)
    progress: dict[str, SymbolProgress] = field(default_factory=dict)

    def to_dict(self, *, at_ns: int | None = None) -> dict[str, Any]:
        moment = at_ns if at_ns is not None else now_ns()
        age = (moment - self.last_event_ns) / NS_PER_SECOND if self.last_event_ns else None
        return {
            "started": iso(self.started_ns),
            "updated": iso(moment),
            "uptime_s": (moment - self.started_ns) / NS_PER_SECOND,
            "venue": self.venue,
            "data_source": self.data_source,
            "symbols": list(self.symbols),
            "horizons_s": list(self.horizons_s),
            "sampling_interval_s": {str(k): v for k, v in sorted(self.interval_s.items())},
            "target_ladder_z": list(self.ladder_z),
            "stopped": self.stopped,
            "abandoned_reason": self.abandoned_reason,
            "sampling_stops_at": (
                iso(self.sampling_deadline_ns) if self.sampling_deadline_ns else None
            ),
            "connected": self.connected and not self.stopped,
            "last_event": iso(self.last_event_ns) if self.last_event_ns else None,
            "feed_age_s": age,
            "reconnects": self.reconnects,
            "malformed_messages": self.malformed,
            "stale_refusals": self.stale_events,
            "evaluated": self.evaluated,
            "voided": self.voided,
            "recent_errors": self.errors[-10:],
            "per_symbol": {k: v.to_dict() for k, v in self.progress.items()},
        }


class LiveRunner:
    """Collect, forecast on a schedule, resolve at expiry. Indefinitely."""

    def __init__(
        self,
        *,
        provider: MarketDataProvider,
        collector: Collector,
        engine: ForecastEngine,
        prediction_repo: PredictionRepository,
        market_repo: MarketRepository,
        config: Config,
        symbols: tuple[str, ...],
        horizons_s: tuple[int, ...] = HORIZONS_S,
        interval_s: dict[int, float] | None = None,
        ladder_z: tuple[float, ...] = TARGET_LADDER_Z,
        status_path: Path | None = None,
    ) -> None:
        self.provider = provider
        self.collector = collector
        self.engine = engine
        self.prediction_repo = prediction_repo
        self.market_repo = market_repo
        self.config = config
        self.symbols = symbols
        self.horizons_s = horizons_s
        # Default: sample each horizon once per horizon, so every forecast is
        # disjoint from the last. See the module docstring.
        self.interval_s = interval_s or {h: float(h) for h in horizons_s}
        self.ladder_z = ladder_z
        self.status_path = status_path or (config.data_dir / STATUS_FILENAME)
        self.evaluator = Evaluator(
            prediction_repo=prediction_repo,
            market_repo=market_repo,
            quality=config.quality,
        )
        self.status = RunnerStatus(
            started_ns=now_ns(),
            venue=provider.venue,
            data_source=provider.data_source.value,
            symbols=symbols,
            horizons_s=horizons_s,
            interval_s=self.interval_s,
            ladder_z=ladder_z,
            progress={s: SymbolProgress(symbol=s) for s in symbols},
        )
        self._stop = asyncio.Event()
        #: When set, no new forecast is started after this instant. See `run()`.
        self._sampling_deadline_ns: int | None = None

    # -- targets -------------------------------------------------------------

    def targets_for(self, spot: float, sigma: float) -> list[float]:
        """The ladder, in prices.

        `sigma` is the standard deviation of the **log** return over the horizon,
        so a rung is placed at `spot * exp(z * sigma)`. Doing this in log space
        rather than as `spot * (1 + z * sigma)` keeps the ladder symmetric in the
        quantity the model actually describes, and keeps every target positive
        however wide the distribution gets.
        """
        if spot <= 0.0 or sigma <= 0.0 or not math.isfinite(sigma):
            return []
        return [round(spot * math.exp(z * sigma), 2) for z in self.ladder_z]

    # -- one sampling instant ------------------------------------------------

    def sample_once(self, symbol: str, horizon_s: int, *, at_ns: int | None = None) -> int:
        """Forecast the whole ladder for one symbol and horizon. Returns rows written.

        Synchronous and side-effecting in one place, so a test can call it
        directly instead of racing the scheduler.
        """
        moment = at_ns if at_ns is not None else now_ns()
        progress = self.status.progress[symbol]
        try:
            window = self.collector.window(symbol, moment)
            level, _ = self.collector.service_level(symbol, moment)
            if level in (ServiceLevel.STALE, ServiceLevel.DOWN):
                # Refusing is the feature. A forecast from a stale price looks
                # exactly like a good one and is not.
                self.status.stale_events += 1
                progress.refusals += 1
                progress.last_refusal = f"service level {level.value}"
                return 0
            distribution = self.engine.baseline_distribution(window, horizon_s)
            targets = self.targets_for(window.spot or 0.0, distribution.sigma)
            if not targets:
                progress.refusals += 1
                progress.last_refusal = "no usable spot or sigma"
                return 0
            forecasts = self.engine.forecast_many(
                window=window,
                targets=targets,
                horizon_s=horizon_s,
                service_level=level,
                feed_age_ns=self.collector.feed_age_ns(symbol, moment),
                now_ns=moment,
                prediction_mode=PredictionMode.LIVE,
            )
        except ForecastRefused as exc:
            progress.refusals += 1
            progress.last_refusal = str(exc)
            return 0
        except Exception as exc:
            progress.refusals += 1
            progress.last_refusal = f"{type(exc).__name__}: {exc}"
            self.status.errors.append(f"{iso(moment)} sample {symbol}/{horizon_s}s: {exc}")
            return 0

        written = 0
        for forecast in forecasts:
            try:
                self.prediction_repo.append(prediction_row(forecast, created_ns=moment))
                written += 1
            except Exception as exc:
                self.status.errors.append(f"{iso(moment)} append {symbol}: {exc}")
        if written:
            progress.forecasts += written
            progress.instants += 1
            progress.by_horizon[horizon_s] = progress.by_horizon.get(horizon_s, 0) + 1
            progress.last_forecast_ns = moment
        return written

    # -- loops ---------------------------------------------------------------

    async def _collect_loop(self) -> None:
        """Feeds the collector. The provider reconnects underneath this."""
        try:
            await self.collector.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.status.errors.append(f"{iso(now_ns())} collector stopped: {exc}")

    async def _forecast_loop(self, symbol: str, horizon_s: int) -> None:
        """One loop per (symbol, horizon), each on its own interval."""
        interval = self.interval_s.get(horizon_s, float(horizon_s))
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            if self._stop.is_set():
                return
            if self._sampling_deadline_ns is not None and now_ns() >= self._sampling_deadline_ns:
                # Past the deadline a new forecast could not expire before the
                # run ends, so making one would only produce a void. Collection
                # and evaluation continue; only sampling stops.
                return
            # Deliberately not in a try/except here: `sample_once` handles its
            # own failures and records them, so this loop cannot die of one.
            await asyncio.to_thread(self.sample_once, symbol, horizon_s)

    async def _evaluate_loop(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=EVALUATE_INTERVAL_S)
            if self._stop.is_set():
                return
            try:
                run = await asyncio.to_thread(self.evaluator.run_once)
                self.status.evaluated += run.resolved
                self.status.voided += run.voided
            except Exception as exc:
                self.status.errors.append(f"{iso(now_ns())} evaluate: {exc}")

    def feed_silence_ns(self, at_ns: int) -> int:
        """How long the feed has delivered nothing, counting from the start.

        Before the first event there is no `last_event_ns` to measure from, so
        silence runs from when the collector started. A feed that never connects
        is the same failure as one that stops, and must not be exempt from the
        watchdog for want of a timestamp.
        """
        since = self.status.last_event_ns or self.status.started_ns
        return max(0, at_ns - since)

    def abandon_if_feed_is_dead(self, at_ns: int) -> str | None:
        """Stop the run if the feed has gone silent. Returns the reason, if any.

        Separate from the loop that calls it so a test can drive it directly:
        the failure it guards against takes hours to appear in real time, and a
        test that waited for it would never be written.
        """
        if self.status.abandoned_reason is not None:
            return self.status.abandoned_reason
        silence_s = self.feed_silence_ns(at_ns) / NS_PER_SECOND
        if silence_s < FEED_SILENCE_ABORT_S:
            return None
        reason = (
            f"the feed delivered nothing for {silence_s / 60:.0f} minutes after "
            f"{self.status.reconnects} reconnect(s); abandoning the segment so the "
            "next run can open a new connection"
        )
        self.status.abandoned_reason = reason
        self.status.errors.append(f"{iso(at_ns)} {reason}")
        self._stop.set()
        return reason

    async def _status_loop(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=STATUS_INTERVAL_S)
            self.refresh_status()
            self.abandon_if_feed_is_dead(now_ns())
            self.write_status()
            if self._stop.is_set():
                return

    def refresh_status(self) -> None:
        health = self.provider.health
        self.status.connected = health.connected
        self.status.last_event_ns = health.last_event_ns
        self.status.reconnects = health.reconnects
        self.status.malformed = health.malformed_messages

    def write_status(self) -> None:
        """Publish health to disk.

        A file rather than a socket: the runner is meant to outlive every other
        process, and a status endpoint that needs the API server up cannot report
        that the API server is down.
        """
        try:
            self.status_path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(self.status.to_dict(), indent=2)
            tmp = self.status_path.with_suffix(".tmp")
            tmp.write_text(payload)
            tmp.replace(self.status_path)  # atomic, so a reader never sees half a file
        except OSError as exc:
            self.status.errors.append(f"{iso(now_ns())} status write: {exc}")

    async def run(
        self, *, seconds: float | None = None, self_contained: bool = False
    ) -> RunnerStatus:
        """Run until stopped, or for `seconds` if given.

        `self_contained` makes the run stop *sampling* before it stops
        *collecting*, so every forecast it starts also expires inside it.

        That is what a segment of a multi-day track record needs. Such a segment
        drops its raw ticks when it ends, and a forecast left open when the ticks
        go is scored VOID later — so sampling to the last second would end every
        segment with a tail of voids that say nothing about the market. With the
        cutoff, each segment resolves everything it starts and the void rate
        means what it should.

        It is deliberately **off** by default, because it is wrong for a one-shot
        run whose budget already accounts for expiry. Applying it to the live
        proof would cut that run from 22 sampling instants to about 10: its
        budget is warm-up + 2x the longest horizon precisely so that forecasts
        can be made and then expire, and taking another horizon off the end
        double-counts the same allowance. Unresolved forecasts at the end of a
        one-shot run are simply not yet scored, which is harmless; unresolved
        forecasts at the end of a segment are voids, which is not.

        Collection and evaluation always continue to the end. Only new sampling
        stops.
        """
        if seconds is not None and self_contained:
            quiet_from = seconds - max(self.horizons_s) - SAMPLING_CUTOFF_MARGIN_S
            if quiet_from > 0:
                self._sampling_deadline_ns = now_ns() + int(quiet_from * NS_PER_SECOND)
            else:
                self.status.errors.append(
                    f"{iso(now_ns())} run of {seconds:.0f}s is too short for a "
                    f"{max(self.horizons_s)}s horizon to be sampled and resolved"
                )
        self.write_status()
        tasks = [
            asyncio.create_task(self._collect_loop(), name="collect"),
            asyncio.create_task(self._evaluate_loop(), name="evaluate"),
            asyncio.create_task(self._status_loop(), name="status"),
        ]
        for symbol in self.symbols:
            for horizon in self.horizons_s:
                tasks.append(
                    asyncio.create_task(
                        self._forecast_loop(symbol, horizon), name=f"forecast:{symbol}:{horizon}"
                    )
                )
        try:
            if seconds is None:
                await self._stop.wait()
            else:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        finally:
            self._stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(Exception):
                await self.collector.close()
            # One last resolution pass, so forecasts that expired during the run
            # are scored before the process goes away.
            with contextlib.suppress(Exception):
                run = self.evaluator.run_once()
                self.status.evaluated += run.resolved
                self.status.voided += run.voided
            self.refresh_status()
            self.status.sampling_deadline_ns = self._sampling_deadline_ns
            self.status.stopped = True
            self.write_status()
        return self.status

    def stop(self) -> None:
        self._stop.set()


def read_status(path: Path, *, max_age_s: float = 60.0) -> dict[str, Any]:
    """Read a runner's status file and say whether it is still being written.

    A status file is a claim about the past. Without the age check a reader would
    report a runner that died last Tuesday as connected, which is the exact
    failure this file exists to prevent.
    """
    try:
        payload: dict[str, Any] = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"running": False, "reason": f"no readable status file at {path}"}
    if payload.get("stopped"):
        payload["running"] = False
        payload["reason"] = "the runner recorded a clean shutdown"
        return payload
    updated = payload.get("updated")
    age: float | None = None
    if isinstance(updated, str):
        from datetime import datetime

        with contextlib.suppress(ValueError):
            stamp = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            age = (now_ns() / NS_PER_SECOND) - stamp.timestamp()
    running = age is not None and age <= max_age_s
    payload["running"] = running
    payload["status_age_s"] = age
    if not running:
        payload["reason"] = (
            f"status file last written {age:.0f}s ago (limit {max_age_s:.0f}s) — "
            "the runner is not running"
            if age is not None
            else "status file has no readable timestamp"
        )
    return payload
