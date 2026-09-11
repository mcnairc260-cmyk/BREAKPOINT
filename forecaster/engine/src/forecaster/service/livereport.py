"""The real-market validation report: what the live track record does and does not show.

The temptation this module is written against is specific. After a day of live
collection there will be a few hundred resolved forecasts and a Brier score, and
that Brier score will be quotable, and quoting it would be wrong. A few hundred
overlapping five-minute forecasts from one afternoon describe one afternoon. They
cannot distinguish a calibrated model from a lucky one, and they cannot say
anything at all about twenty-minute forecasts, of which one afternoon contains
about twenty independent examples.

So every figure here is reported next to the evidence behind it, and the report
labels its own sample sizes rather than leaving the reader to work it out:

* **n_rows** — forecasts written. The biggest number and the least meaningful,
  because six targets at one instant all resolve from one realised price.
* **n_timestamps** — distinct sampling instants.
* **n_non_overlapping** — instants at least one horizon apart. The honest count.
* **n_days** — how much market was seen. Two thousand rows from one afternoon
  have been validated against one afternoon.

`sufficiency` turns those into a plain sentence, and nothing in this repository
reports a calibration claim from a sample it has labelled INSUFFICIENT.

## Live means live

Every query is filtered on `data_source`. Simulated and live outcomes are never
summed, never averaged together, and never appear in the same row of the same
table. A live report run against a database containing only simulated rows says
so and reports zero, which is the correct answer.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from itertools import pairwise
from typing import Any

import numpy as np

from forecaster.clock import iso, now_ns
from forecaster.labels.resolve import label_from_price
from forecaster.store import PredictionRepository, QualityRepository
from forecaster.types import DataSource, Outcome
from forecaster.validation.metrics import (
    brier,
    expected_calibration_error,
    log_loss,
    probability_buckets,
    wilson_interval,
)
from forecaster.validation.splits import effective_sample_size

#: Below this many non-overlapping observations, no calibration claim is made.
#: It is not a statistical threshold so much as a refusal to be quoted: an
#: expected calibration error from thirty observations has a confidence interval
#: wider than the quantity it estimates.
MIN_NON_OVERLAPPING_FOR_CALIBRATION = 100

#: Below this, the sample is described as a smoke test rather than as evidence.
MIN_NON_OVERLAPPING_FOR_ANY_CLAIM = 30

#: A track record from a single day has seen a single day's market regime,
#: whatever its row count.
MIN_DAYS_FOR_REGIME_CLAIM = 5.0


@dataclass
class GroupReport:
    """One (symbol, horizon) cell of the report."""

    symbol: str
    horizon_s: int
    data_source: str
    forecasts: int = 0
    resolved: int = 0
    void: int = 0
    stale_resolved: int = 0
    n_timestamps: int = 0
    n_non_overlapping: int = 0
    n_days: float = 0.0
    first_forecast: str | None = None
    last_forecast: str | None = None
    brier: float | None = None
    log_loss: float | None = None
    calibration_error: float | None = None
    observed_above_rate: float | None = None
    mean_forecast_above: float | None = None
    accuracy: float | None = None
    accuracy_interval: tuple[float, float] | None = None
    buckets: list[dict[str, Any]] = field(default_factory=list)
    monotonicity_violations: int = 0
    monotonicity_checked: int = 0
    sufficiency: str = "NO DATA"
    can_claim_calibration: bool = False
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _sufficiency(n_independent: int, n_days: float) -> tuple[str, bool, str]:
    """Say plainly how much this sample can support."""
    if n_independent == 0:
        return ("NO DATA", False, "no resolved live forecasts")
    if n_independent < MIN_NON_OVERLAPPING_FOR_ANY_CLAIM:
        return (
            "INSUFFICIENT — SMOKE TEST ONLY",
            False,
            f"{n_independent} independent observations proves the pipeline runs "
            "and nothing about forecast quality",
        )
    if n_independent < MIN_NON_OVERLAPPING_FOR_CALIBRATION:
        return (
            "INSUFFICIENT FOR CALIBRATION",
            False,
            f"{n_independent} independent observations; "
            f"{MIN_NON_OVERLAPPING_FOR_CALIBRATION} is the floor for a calibration claim",
        )
    if n_days < MIN_DAYS_FOR_REGIME_CLAIM:
        return (
            "PRELIMINARY — ONE REGIME",
            True,
            f"{n_independent} independent observations over {n_days:.1f} days; "
            f"a single regime, so the calibration figure describes these "
            f"{n_days:.1f} days and not the market",
        )
    return (
        "USABLE",
        True,
        f"{n_independent} independent observations over {n_days:.1f} days",
    )


def monotonicity_violations(rows: Sequence[dict[str, Any]]) -> tuple[int, int]:
    """Count forecasts from one instant whose probabilities disagree with their targets.

    The product's central guarantee: for one symbol, one horizon and one instant,
    a higher target must never carry a higher probability of being above it. The
    ladder puts six targets on every instant precisely so this can be checked on
    live output rather than only in a unit test.

    Returns (violations, adjacent pairs checked).
    """
    groups: dict[tuple[str, int, int], list[tuple[float, float]]] = {}
    for row in rows:
        key = (str(row["symbol"]), int(row["horizon_s"]), int(row["as_of_ns"]))
        groups.setdefault(key, []).append((float(row["target"]), float(row["p_above"])))

    violations = checked = 0
    for pairs in groups.values():
        if len(pairs) < 2:
            continue
        ordered = sorted(pairs)
        for (_, p_low), (_, p_high) in pairwise(ordered):
            checked += 1
            # A higher target must not have a higher probability. A tie is fine:
            # two targets far into the same tail both floor at the same value.
            if p_high > p_low + 1e-12:
                violations += 1
    return violations, checked


def group_report(
    *,
    symbol: str,
    horizon_s: int,
    data_source: DataSource,
    all_rows: Sequence[dict[str, Any]],
    scored_rows: Sequence[dict[str, Any]],
) -> GroupReport:
    """Build one cell. Pure, so the whole report is testable without a database."""
    report = GroupReport(symbol=symbol, horizon_s=horizon_s, data_source=data_source.value)
    mine = [
        r
        for r in all_rows
        if r["symbol"] == symbol
        and int(r["horizon_s"]) == horizon_s
        and str(r["data_source"]) == data_source.value
    ]
    report.forecasts = len(mine)
    if mine:
        stamps = [int(r["as_of_ns"]) for r in mine]
        report.first_forecast = iso(min(stamps))
        report.last_forecast = iso(max(stamps))

    scored = [
        r
        for r in scored_rows
        if r["symbol"] == symbol
        and int(r["horizon_s"]) == horizon_s
        and str(r["data_source"]) == data_source.value
    ]
    report.resolved = len(scored)
    report.void = sum(
        1
        for r in mine
        if str(r.get("outcome") or "") in (Outcome.VOID_GAP.value, Outcome.VOID_HALT.value)
    )
    report.stale_resolved = sum(
        1
        for r in scored
        if str(r.get("outcome") or "") in (Outcome.STALE_ABOVE.value, Outcome.STALE_BELOW.value)
    )

    violations, checked = monotonicity_violations(mine)
    report.monotonicity_violations = violations
    report.monotonicity_checked = checked

    # Sample size is counted on the RESOLVED rows: an unresolved forecast is not
    # evidence yet, and counting it as though it were is how a track record gets
    # quoted before it exists.
    stamps = [int(r["as_of_ns"]) for r in scored]
    size = effective_sample_size(stamps, horizon_s, len(scored))
    report.n_timestamps = size.n_timestamps
    report.n_non_overlapping = size.n_non_overlapping
    report.n_days = size.n_days

    label, can_claim, note = _sufficiency(size.n_non_overlapping, size.n_days)
    report.sufficiency = label
    report.can_claim_calibration = can_claim
    report.note = note

    if not scored:
        return report

    p = np.asarray([float(r["p_above"]) for r in scored], dtype=float)
    y = np.asarray(
        [
            1.0 if label_from_price(float(r["eval_price"]), float(r["target"])) else 0.0
            for r in scored
        ],
        dtype=float,
    )
    report.brier = float(brier(p, y))
    report.log_loss = float(log_loss(p, y))
    report.observed_above_rate = float(y.mean())
    report.mean_forecast_above = float(p.mean())
    correct = int(((p > 0.5) == (y > 0.5)).sum())
    report.accuracy = correct / len(y)
    report.accuracy_interval = wilson_interval(correct, len(y))
    report.buckets = [b.to_dict() if hasattr(b, "to_dict") else dict(b) for b in _buckets(p, y)]
    # ECE from a handful of points is noise with a decimal point, so it is only
    # computed where the sufficiency check says it can be.
    if can_claim:
        report.calibration_error = float(expected_calibration_error(p, y))
    return report


def _buckets(p: np.ndarray, y: np.ndarray) -> list[Any]:
    rows = probability_buckets(p, y)
    out: list[Any] = []
    for row in rows:
        out.append(row if isinstance(row, dict) else asdict(row))
    return out


def live_validation_report(
    *,
    prediction_repo: PredictionRepository,
    quality_repo: QualityRepository | None = None,
    symbols: Sequence[str] = ("BTC-USD", "ETH-USD"),
    horizons_s: Sequence[int] = (300, 1200),
    data_source: DataSource = DataSource.LIVE,
    reconnects: int = 0,
) -> dict[str, Any]:
    """The report §8 asks for: one cell per symbol and horizon, live rows only."""
    # prediction_mode="live" throughout: a backtest row can carry data_source
    # LIVE (replaying real history is a legitimate thing to do) and is still not
    # a live forecast. Mixing the two would let replayed results be read as a
    # real-time track record.
    all_rows = prediction_repo.history(limit=1_000_000, prediction_mode="live")
    scored_rows = prediction_repo.scored(prediction_mode="live", data_source=data_source.value)

    groups = [
        group_report(
            symbol=symbol,
            horizon_s=horizon,
            data_source=data_source,
            all_rows=all_rows,
            scored_rows=scored_rows,
        )
        for symbol in symbols
        for horizon in horizons_s
    ]

    quality: dict[str, int] = {}
    if quality_repo is not None:
        for kind, count in quality_repo.counts_by_kind(0, data_source=data_source).items():
            quality[str(kind)] = int(count)

    total_live = sum(g.forecasts for g in groups)
    total_resolved = sum(g.resolved for g in groups)
    other_sources = sorted(
        {str(r["data_source"]) for r in all_rows if str(r["data_source"]) != data_source.value}
    )

    return {
        "data_source": data_source.value,
        "generated": iso(now_ns()),
        "scope": (
            f"{data_source.value.upper()} forecasts only. Rows from other sources "
            f"({', '.join(other_sources) or 'none present'}) are excluded from every "
            "figure in this report."
        ),
        "totals": {
            "forecasts": total_live,
            "resolved": total_resolved,
            "unresolved": total_live - total_resolved,
            "predictions_in_log_all_sources": prediction_repo.count(),
        },
        "groups": [g.to_dict() for g in groups],
        "stale_and_quality_events": quality,
        "reconnects": reconnects,
        "headline": _headline(groups, data_source),
    }


def _headline(groups: Sequence[GroupReport], data_source: DataSource) -> str:
    """One sentence an honest person can paste into a message.

    It names the source. An earlier version said "live forecasts resolved"
    whatever the report was scoped to, so a simulated run produced a sentence
    that read as a real-market result the moment it left this page.
    """
    label = data_source.value
    resolved = sum(g.resolved for g in groups)
    if resolved == 0:
        return "No live forecasts have been resolved. This system has no real-market track record."
    claimable = [g for g in groups if g.can_claim_calibration]
    independent = sum(g.n_non_overlapping for g in groups)
    kind = "real market" if data_source is DataSource.LIVE else f"{label} data"
    if not claimable:
        return (
            f"{resolved} {label} forecasts resolved ({independent} independent "
            f"observations). That is enough to show the pipeline works end to end on "
            f"{kind}, and not enough to support any claim about calibration or skill."
        )
    return (
        f"{resolved} {label} forecasts resolved ({independent} independent observations). "
        f"{len(claimable)} of {len(groups)} groups have enough evidence for a "
        "calibration figure; none of them is evidence of skill against the baseline, "
        "which is a separate comparison that has not been run on live data."
    )


def format_report(report: dict[str, Any]) -> str:
    """The printed form."""
    lines: list[str] = []
    add = lines.append
    add("")
    add("  REAL-MARKET VALIDATION REPORT")
    add(f"  {'─' * 74}")
    add(f"  scope   {report['scope']}")
    totals = report["totals"]
    add(
        f"  totals  {totals['forecasts']:,} live forecasts, "
        f"{totals['resolved']:,} resolved, {totals['unresolved']:,} still open"
    )
    add(f"          {totals['predictions_in_log_all_sources']:,} predictions in the log overall")
    add("")
    header = (
        f"  {'symbol':<9}{'horizon':>8}{'fc':>7}{'resolved':>10}{'void':>6}"
        f"{'indep':>7}{'days':>7}{'brier':>9}{'ECE':>8}  sufficiency"
    )
    add(header)
    add(f"  {'─' * 74}")
    for g in report["groups"]:
        brier_txt = f"{g['brier']:.5f}" if g["brier"] is not None else "—"
        ece_txt = f"{g['calibration_error']:.5f}" if g["calibration_error"] is not None else "—"
        add(
            f"  {g['symbol']:<9}{str(g['horizon_s']) + 's':>8}{g['forecasts']:>7,}"
            f"{g['resolved']:>10,}{g['void']:>6,}{g['n_non_overlapping']:>7,}"
            f"{g['n_days']:>7.2f}{brier_txt:>9}{ece_txt:>8}  {g['sufficiency']}"
        )
    add("")
    for g in report["groups"]:
        if g["resolved"] == 0 and g["forecasts"] == 0:
            continue
        add(f"  {g['symbol']} {g['horizon_s']}s — {g['note']}")
        if g["monotonicity_checked"]:
            add(
                f"    monotonicity: {g['monotonicity_violations']} violations in "
                f"{g['monotonicity_checked']:,} adjacent target pairs"
            )
        if g["resolved"]:
            add(
                f"    observed ABOVE rate {g['observed_above_rate']:.4f} "
                f"vs mean forecast {g['mean_forecast_above']:.4f}"
            )
            if g["accuracy_interval"]:
                low, high = g["accuracy_interval"]
                add(
                    f"    accuracy {g['accuracy']:.4f} (95% CI {low:.4f} to {high:.4f}) "
                    "— reported last, and on purpose"
                )
            if g["stale_resolved"]:
                add(f"    {g['stale_resolved']} resolved from a stale print, flagged as such")
        add("")
    if report["stale_and_quality_events"]:
        add("  data quality events recorded:")
        for kind, count in sorted(report["stale_and_quality_events"].items()):
            add(f"    {kind:<28} {count:,}")
        add("")
    add(f"  reconnects during collection: {report['reconnects']}")
    add("")
    add("  " + report["headline"])
    add("")
    return "\n".join(lines)
