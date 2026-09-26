"""Scoring forecasts once their horizon has passed.

Runs as a separate, idempotent job. Separate because a forecast must be written
before its outcome could possibly be known, and scored afterwards by something
that cannot reach back and edit it — the predictions table is append-only and
enforces that with a database trigger.

Idempotent because it will be run repeatedly, sometimes concurrently, and a
prediction scored twice must produce one outcome row rather than two.

The evaluation price comes from the recorded feed, never from a fresh request to
the venue. A history that changes depending on when you looked at it is not a
history.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from forecaster.clock import now_ns
from forecaster.config import QualityConfig
from forecaster.labels.resolve import RESOLVER_VERSION, resolve_outcome
from forecaster.store import MarketRepository, PredictionRepository
from forecaster.types import DataSource, Outcome


@dataclass
class EvaluationRun:
    checked: int = 0
    resolved: int = 0
    voided: int = 0
    stale: int = 0
    ties: int = 0
    by_outcome: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "checked": self.checked,
            "resolved": self.resolved,
            "voided": self.voided,
            "stale": self.stale,
            "ties": self.ties,
            "by_outcome": dict(self.by_outcome),
        }


class Evaluator:
    def __init__(
        self,
        *,
        prediction_repo: PredictionRepository,
        market_repo: MarketRepository,
        quality: QualityConfig | None = None,
    ) -> None:
        self.prediction_repo = prediction_repo
        self.market_repo = market_repo
        self.quality = quality or QualityConfig()

    def run_once(self, *, at_ns: int | None = None, limit: int = 500) -> EvaluationRun:
        moment = at_ns if at_ns is not None else now_ns()
        run = EvaluationRun()
        for row in self.prediction_repo.due_for_evaluation(moment, limit=limit):
            run.checked += 1
            trade = self.market_repo.last_trade_at_or_before(
                str(row["symbol"]),
                int(row["eval_at_ns"]),
                source=DataSource(str(row["data_source"])),
                venue=str(row["venue"]),
            )
            resolution = resolve_outcome(
                p_above=float(row["p_above"]),
                target=float(row["target"]),
                eval_at_ns=int(row["eval_at_ns"]),
                last_trade=trade,
                fresh_bound_ns=self.quality.eval_staleness_ok_ns,
                max_bound_ns=self.quality.eval_staleness_max_ns,
            )
            self.prediction_repo.record_outcome(
                {
                    "prediction_id": int(row["id"]),
                    "resolved_ns": moment,
                    "eval_price": resolution.eval_price,
                    "eval_price_ns": resolution.eval_price_ns,
                    "staleness_ns": resolution.staleness_ns,
                    "outcome": resolution.outcome.value,
                    "correct": resolution.correct,
                    "brier": resolution.brier,
                    "log_loss": resolution.log_loss,
                    "tie": resolution.tie,
                    "resolver_version": RESOLVER_VERSION,
                }
            )
            key = resolution.outcome.value
            run.by_outcome[key] = run.by_outcome.get(key, 0) + 1
            if resolution.is_scored:
                run.resolved += 1
                if resolution.outcome in (Outcome.STALE_ABOVE, Outcome.STALE_BELOW):
                    run.stale += 1
            else:
                run.voided += 1
            if resolution.tie:
                run.ties += 1
        return run

    async def run_forever(self, *, interval_s: float = 5.0) -> None:
        """Poll for due predictions. Cheap: the query is a single indexed scan."""
        import asyncio
        import contextlib

        while True:
            # An evaluator that dies stops the track record entirely, which is
            # far worse than any single failed resolution. It retries next tick.
            with contextlib.suppress(Exception):
                self.run_once()
            await asyncio.sleep(interval_s)
