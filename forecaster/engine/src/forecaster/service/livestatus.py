"""How much live evidence exists, and how much is still needed.

Section 13 of the brief. The hard part is not the counting; it is refusing to
turn the counting into a promise. "You have 40% of the data you need" invites the
next question, "so how many more days?", and the honest answer to that question
is not a number, because it depends on how long the feed stays up, how often the
market halts, and how many forecasts get voided — none of which are known in
advance.

So this reports **rate so far** and what it would imply *if that rate continued*,
labelled as the conditional it is. It never returns a date.

The threshold it measures against is `MIN_INDEPENDENT_FOR_ML`, and it is measured
in non-overlapping observations. Sampling faster does not move this number, which
is exactly the point: no amount of resampling the same five minutes creates a
second observation of it.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.config import Config
from forecaster.models.train import MIN_INDEPENDENT_FOR_ML
from forecaster.service.liverunner import STATUS_FILENAME, read_status
from forecaster.store import MarketRepository, PredictionRepository
from forecaster.types import HORIZONS_S, NS_PER_SECOND, DataSource
from forecaster.validation.splits import effective_sample_size


def live_status(
    *,
    config: Config,
    prediction_repo: PredictionRepository,
    market_repo: MarketRepository,
    symbols: Sequence[str] = ("BTC-USD", "ETH-USD"),
    horizons_s: Sequence[int] = HORIZONS_S,
    data_source: DataSource = DataSource.LIVE,
) -> dict[str, Any]:
    """Feed health from the runner's status file, evidence counts from the database."""
    runner = read_status(config.data_dir / STATUS_FILENAME)
    scored = prediction_repo.scored(prediction_mode="live", data_source=data_source.value)

    feeds: list[dict[str, Any]] = []
    for symbol in symbols:
        counts = market_repo.counts_for(symbol=symbol, data_source=data_source)
        first_ns, last_ns = market_repo.span(symbol=symbol, data_source=data_source)
        per_symbol = (runner.get("per_symbol") or {}).get(symbol, {})
        age = (now_ns() - last_ns) / NS_PER_SECOND if last_ns else None
        feeds.append(
            {
                "symbol": symbol,
                "connected": bool(runner.get("connected")) and runner.get("running", False),
                "last_market_event": iso(last_ns) if last_ns else None,
                "last_event_age_s": age,
                "first_market_event": iso(first_ns) if first_ns else None,
                "collected_duration_s": (
                    (last_ns - first_ns) / NS_PER_SECOND if first_ns and last_ns else 0.0
                ),
                "events_collected": counts,
                "forecasts": per_symbol.get("forecasts", 0),
                "refusals": per_symbol.get("refusals", 0),
                "last_refusal": per_symbol.get("last_refusal"),
            }
        )

    progress: list[dict[str, Any]] = []
    for symbol in symbols:
        for horizon in horizons_s:
            rows = [r for r in scored if r["symbol"] == symbol and int(r["horizon_s"]) == horizon]
            size = effective_sample_size([int(r["as_of_ns"]) for r in rows], horizon, len(rows))
            independent = size.n_non_overlapping
            progress.append(
                {
                    "symbol": symbol,
                    "horizon_s": horizon,
                    "resolved_rows": len(rows),
                    "distinct_timestamps": size.n_timestamps,
                    "independent_observations": independent,
                    "days_represented": size.n_days,
                    "threshold": MIN_INDEPENDENT_FOR_ML,
                    "fraction_of_threshold": (
                        min(independent / MIN_INDEPENDENT_FOR_ML, 1.0)
                        if MIN_INDEPENDENT_FOR_ML
                        else 0.0
                    ),
                    "observations_remaining": max(MIN_INDEPENDENT_FOR_ML - independent, 0),
                    "rate_per_day_so_far": (
                        independent / size.n_days if size.n_days > 0.01 else None
                    ),
                    "implied_days_at_this_rate": _implied_days(independent, size.n_days),
                }
            )

    return {
        "generated": iso(now_ns()),
        "data_source": data_source.value,
        "runner": {
            "running": runner.get("running", False),
            "reason": runner.get("reason"),
            "updated": runner.get("updated"),
            "uptime_s": runner.get("uptime_s"),
            "venue": runner.get("venue"),
            "data_source": runner.get("data_source"),
            "reconnects": runner.get("reconnects", 0),
            "malformed_messages": runner.get("malformed_messages", 0),
            "stale_refusals": runner.get("stale_refusals", 0),
            "recent_errors": runner.get("recent_errors", []),
        },
        "feeds": feeds,
        "learner_threshold": {
            "min_independent_observations": MIN_INDEPENDENT_FOR_ML,
            "counted_in": "non-overlapping observations, never rows",
            "note": (
                "The threshold is not weakened by sampling faster. Six targets at one "
                "instant are six views of one future price, and two forecasts five "
                "seconds apart at a five-minute horizon share 295 of their 300 seconds."
            ),
        },
        "per_horizon_progress": progress,
    }


def _implied_days(independent: int, days: float) -> float | None:
    """Days to the threshold IF the rate so far continued. Not a prediction."""
    if days <= 0.01 or independent <= 0:
        return None
    rate = independent / days
    if rate <= 0:
        return None
    remaining = max(MIN_INDEPENDENT_FOR_ML - independent, 0)
    return remaining / rate


def format_status(status: dict[str, Any]) -> str:
    lines: list[str] = []
    add = lines.append
    runner = status["runner"]
    add("")
    add("  LIVE COLLECTION STATUS")
    add(f"  {'─' * 72}")
    if runner["running"]:
        add(
            f"  runner    RUNNING for {float(runner['uptime_s'] or 0) / 3600.0:.1f}h "
            f"on {runner['venue']} ({str(runner['data_source']).upper()})"
        )
        add(
            f"            {runner['reconnects']} reconnects, "
            f"{runner['malformed_messages']} malformed messages, "
            f"{runner['stale_refusals']} stale refusals"
        )
    else:
        add("  runner    NOT RUNNING")
        if runner.get("reason"):
            add(f"            {runner['reason']}")
    add("")

    add("  feeds")
    for feed in status["feeds"]:
        state = "connected" if feed["connected"] else "disconnected"
        age = (
            f"{feed['last_event_age_s']:.0f}s ago"
            if feed["last_event_age_s"] is not None
            else "never"
        )
        hours = feed["collected_duration_s"] / 3600.0
        events = feed["events_collected"]
        total = sum(events.values()) if isinstance(events, dict) else int(events or 0)
        add(f"    {feed['symbol']:<9} {state:<13} last event {age:<14} {hours:>6.2f}h collected")
        add(f"    {'':<9} {total:,} market events, {feed['forecasts']:,} forecasts")
        if feed["refusals"]:
            add(f"    {'':<9} {feed['refusals']} refusals — last: {feed['last_refusal']}")
    add("")

    threshold = status["learner_threshold"]["min_independent_observations"]
    add(f"  independent observations toward the learner threshold ({threshold:,})")
    add(
        f"    {'symbol':<9}{'horizon':>8}{'rows':>8}{'instants':>10}"
        f"{'independent':>13}{'days':>7}{'progress':>10}"
    )
    for row in status["per_horizon_progress"]:
        add(
            f"    {row['symbol']:<9}{str(row['horizon_s']) + 's':>8}{row['resolved_rows']:>8,}"
            f"{row['distinct_timestamps']:>10,}{row['independent_observations']:>13,}"
            f"{row['days_represented']:>7.2f}{row['fraction_of_threshold'] * 100:>9.1f}%"
        )
    add("")
    for row in status["per_horizon_progress"]:
        implied = row["implied_days_at_this_rate"]
        if implied is None:
            continue
        add(
            f"    {row['symbol']} {row['horizon_s']}s: at the rate observed so far "
            f"({row['rate_per_day_so_far']:.0f}/day) the remaining "
            f"{row['observations_remaining']:,} would take about {implied:.1f} more days"
        )
    add("")
    add("    That is arithmetic on the rate so far, not a promise about the calendar.")
    add("    Outages, halts and voided forecasts all slow it down, and none of them")
    add("    are known in advance.")
    add("")
    add(f"    {status['learner_threshold']['note']}")
    add("")
    return "\n".join(lines)
