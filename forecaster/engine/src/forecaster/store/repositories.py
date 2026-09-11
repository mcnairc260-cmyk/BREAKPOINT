"""Repositories: the only place that knows SQL.

Each repository is a small, explicit surface. Nothing above this layer builds a
query, so moving to PostgreSQL, adding a cache, or partitioning the tick tables
is a change here and nowhere else.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, delete, desc, func, insert, select, update
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from forecaster.store.database import Database
from forecaster.store.hashchain import GENESIS, row_digest, verify_chain
from forecaster.store.schema import (
    bars,
    book_snapshots,
    models,
    outcomes,
    predictions,
    promotion_decisions,
    quality_events,
    quotes,
    trades,
)
from forecaster.types import (
    Bar,
    BookLevel,
    BookSnapshot,
    DataSource,
    Quote,
    Side,
    Trade,
)


@dataclass
class MarketRepository:
    """Trades, quotes, book snapshots and bars."""

    db: Database

    def insert_trades(self, rows: list[Trade], venue: str, source: DataSource) -> int:
        if not rows:
            return 0
        payload = [
            {
                "exchange_ns": t.exchange_ns,
                "received_ns": t.received_ns,
                "venue": venue,
                "symbol": t.symbol,
                "price": t.price,
                "size": t.size,
                "side": t.side.value,
                "trade_id": t.trade_id,
                "data_source": source.value,
            }
            for t in rows
        ]
        with self.db.begin() as conn:
            # Duplicates are expected after a reconnect replays part of the
            # stream, so they are dropped rather than treated as an error.
            written = 0
            for item in payload:
                try:
                    conn.execute(insert(trades).values(**item))
                    written += 1
                except Exception:
                    continue
            return written

    def insert_quotes(self, rows: list[Quote], venue: str, source: DataSource) -> int:
        if not rows:
            return 0
        payload = [
            {
                "exchange_ns": q.exchange_ns,
                "received_ns": q.received_ns,
                "venue": venue,
                "symbol": q.symbol,
                "bid": q.bid,
                "bid_size": q.bid_size,
                "ask": q.ask,
                "ask_size": q.ask_size,
                "data_source": source.value,
            }
            for q in rows
        ]
        with self.db.begin() as conn:
            conn.execute(insert(quotes), payload)
        return len(payload)

    def insert_book(self, snapshot: BookSnapshot, venue: str, source: DataSource) -> None:
        with self.db.begin() as conn:
            conn.execute(
                insert(book_snapshots).values(
                    exchange_ns=snapshot.exchange_ns,
                    received_ns=snapshot.received_ns,
                    venue=venue,
                    symbol=snapshot.symbol,
                    bids_json=json.dumps([[b.price, b.size] for b in snapshot.bids]),
                    asks_json=json.dumps([[a.price, a.size] for a in snapshot.asks]),
                    sequence=snapshot.sequence,
                    data_source=source.value,
                )
            )

    def upsert_bars(self, rows: list[Bar], venue: str, source: DataSource) -> int:
        if not rows:
            return 0
        written = 0
        with self.db.begin() as conn:
            for b in rows:
                values = {
                    "open_ns": b.open_ns,
                    "resolution_s": b.resolution_s,
                    "venue": venue,
                    "symbol": b.symbol,
                    "open": b.open,
                    "high": b.high,
                    "low": b.low,
                    "close": b.close,
                    "volume": b.volume,
                    "buy_volume": b.buy_volume,
                    "sell_volume": b.sell_volume,
                    "trade_count": b.trade_count,
                    "vwap": b.vwap,
                    "data_source": source.value,
                }
                existing = conn.execute(
                    select(bars.c.id).where(
                        and_(
                            bars.c.venue == venue,
                            bars.c.symbol == b.symbol,
                            bars.c.resolution_s == b.resolution_s,
                            bars.c.open_ns == b.open_ns,
                            bars.c.data_source == source.value,
                        )
                    )
                ).first()
                if existing is None:
                    conn.execute(insert(bars).values(**values))
                else:
                    conn.execute(update(bars).where(bars.c.id == existing[0]).values(**values))
                written += 1
        return written

    def trades_between(
        self, symbol: str, start_ns: int, end_ns: int, *, source: DataSource, venue: str
    ) -> list[Trade]:
        stmt = (
            select(trades)
            .where(
                and_(
                    trades.c.symbol == symbol,
                    trades.c.venue == venue,
                    trades.c.data_source == source.value,
                    trades.c.exchange_ns >= start_ns,
                    trades.c.exchange_ns < end_ns,
                )
            )
            .order_by(trades.c.exchange_ns)
        )
        with self.db.connect() as conn:
            return [
                Trade(
                    exchange_ns=r.exchange_ns,
                    received_ns=r.received_ns,
                    symbol=r.symbol,
                    price=r.price,
                    size=r.size,
                    side=Side(r.side),
                    trade_id=r.trade_id,
                )
                for r in conn.execute(stmt)
            ]

    def last_trade_at_or_before(
        self, symbol: str, at_ns: int, *, source: DataSource, venue: str
    ) -> Trade | None:
        """The evaluation price lookup.

        Deliberately reads the recorded feed rather than asking the venue what
        the price was. Re-querying would make a resolved outcome depend on when
        the resolver happened to run, and an unreproducible history is not a
        history.
        """
        stmt = (
            select(trades)
            .where(
                and_(
                    trades.c.symbol == symbol,
                    trades.c.venue == venue,
                    trades.c.data_source == source.value,
                    trades.c.exchange_ns <= at_ns,
                )
            )
            .order_by(desc(trades.c.exchange_ns))
            .limit(1)
        )
        with self.db.connect() as conn:
            row = conn.execute(stmt).first()
        if row is None:
            return None
        return Trade(
            exchange_ns=row.exchange_ns,
            received_ns=row.received_ns,
            symbol=row.symbol,
            price=row.price,
            size=row.size,
            side=Side(row.side),
            trade_id=row.trade_id,
        )

    def quotes_between(
        self, symbol: str, start_ns: int, end_ns: int, *, source: DataSource, venue: str
    ) -> list[Quote]:
        """Quotes by RECEIPT time, because that is what a feature window cuts on."""
        stmt = (
            select(quotes)
            .where(
                and_(
                    quotes.c.symbol == symbol,
                    quotes.c.venue == venue,
                    quotes.c.data_source == source.value,
                    quotes.c.received_ns >= start_ns,
                    quotes.c.received_ns <= end_ns,
                )
            )
            .order_by(quotes.c.received_ns)
        )
        with self.db.connect() as conn:
            return [
                Quote(
                    exchange_ns=r.exchange_ns,
                    received_ns=r.received_ns,
                    symbol=r.symbol,
                    bid=r.bid,
                    bid_size=r.bid_size,
                    ask=r.ask,
                    ask_size=r.ask_size,
                )
                for r in conn.execute(stmt)
            ]

    def latest_book(
        self, symbol: str, at_ns: int, *, source: DataSource, venue: str
    ) -> BookSnapshot | None:
        stmt = (
            select(book_snapshots)
            .where(
                and_(
                    book_snapshots.c.symbol == symbol,
                    book_snapshots.c.venue == venue,
                    book_snapshots.c.data_source == source.value,
                    book_snapshots.c.received_ns <= at_ns,
                )
            )
            .order_by(desc(book_snapshots.c.received_ns))
            .limit(1)
        )
        with self.db.connect() as conn:
            row = conn.execute(stmt).first()
        if row is None:
            return None
        return BookSnapshot(
            exchange_ns=row.exchange_ns,
            received_ns=row.received_ns,
            symbol=row.symbol,
            bids=tuple(BookLevel(p, s) for p, s in json.loads(row.bids_json)),
            asks=tuple(BookLevel(p, s) for p, s in json.loads(row.asks_json)),
            sequence=row.sequence,
        )

    def books_between(
        self, symbol: str, start_ns: int, end_ns: int, *, source: DataSource, venue: str
    ) -> list[BookSnapshot]:
        stmt = (
            select(book_snapshots)
            .where(
                and_(
                    book_snapshots.c.symbol == symbol,
                    book_snapshots.c.venue == venue,
                    book_snapshots.c.data_source == source.value,
                    book_snapshots.c.received_ns >= start_ns,
                    book_snapshots.c.received_ns <= end_ns,
                )
            )
            .order_by(book_snapshots.c.received_ns)
        )
        with self.db.connect() as conn:
            return [
                BookSnapshot(
                    exchange_ns=row.exchange_ns,
                    received_ns=row.received_ns,
                    symbol=row.symbol,
                    bids=tuple(BookLevel(p, s) for p, s in json.loads(row.bids_json)),
                    asks=tuple(BookLevel(p, s) for p, s in json.loads(row.asks_json)),
                    sequence=row.sequence,
                )
                for row in conn.execute(stmt)
            ]

    def bars_between(
        self,
        symbol: str,
        resolution_s: int,
        start_ns: int,
        end_ns: int,
        *,
        source: DataSource,
        venue: str,
    ) -> list[Bar]:
        stmt = (
            select(bars)
            .where(
                and_(
                    bars.c.symbol == symbol,
                    bars.c.venue == venue,
                    bars.c.resolution_s == resolution_s,
                    bars.c.data_source == source.value,
                    bars.c.open_ns >= start_ns,
                    bars.c.open_ns < end_ns,
                )
            )
            .order_by(bars.c.open_ns)
        )
        with self.db.connect() as conn:
            return [
                Bar(
                    open_ns=r.open_ns,
                    resolution_s=r.resolution_s,
                    symbol=r.symbol,
                    open=r.open,
                    high=r.high,
                    low=r.low,
                    close=r.close,
                    volume=r.volume,
                    buy_volume=r.buy_volume,
                    sell_volume=r.sell_volume,
                    trade_count=r.trade_count,
                    vwap=r.vwap,
                )
                for r in conn.execute(stmt)
            ]

    def counts(self) -> dict[str, int]:
        with self.db.connect() as conn:
            return {
                "trades": int(conn.execute(select(func.count()).select_from(trades)).scalar_one()),
                "quotes": int(conn.execute(select(func.count()).select_from(quotes)).scalar_one()),
                "books": int(
                    conn.execute(select(func.count()).select_from(book_snapshots)).scalar_one()
                ),
                "bars": int(conn.execute(select(func.count()).select_from(bars)).scalar_one()),
            }

    def counts_for(self, *, symbol: str, data_source: DataSource) -> dict[str, int]:
        """Row counts for one symbol from one source.

        Separate from `counts()` rather than a parameter on it: the live status
        view must never be able to answer "how much live data is there?" with a
        number that quietly includes simulated rows, and a default argument is
        exactly how that happens.
        """
        out: dict[str, int] = {}
        with self.db.connect() as conn:
            for name, table in (
                ("trades", trades),
                ("quotes", quotes),
                ("books", book_snapshots),
                ("bars", bars),
            ):
                out[name] = int(
                    conn.execute(
                        select(func.count())
                        .select_from(table)
                        .where(
                            and_(
                                table.c.symbol == symbol,
                                table.c.data_source == data_source.value,
                            )
                        )
                    ).scalar_one()
                )
        return out

    def span(self, *, symbol: str, data_source: DataSource) -> tuple[int | None, int | None]:
        """First and last trade timestamps for one symbol and source.

        Exchange time, not receipt time: "how much market did we see" is a
        question about the market's clock.
        """
        with self.db.connect() as conn:
            row = conn.execute(
                select(func.min(trades.c.exchange_ns), func.max(trades.c.exchange_ns)).where(
                    and_(
                        trades.c.symbol == symbol,
                        trades.c.data_source == data_source.value,
                    )
                )
            ).first()
        if row is None or row[0] is None:
            return None, None
        return int(row[0]), int(row[1])

    def purge_source(self, source: DataSource) -> None:
        """Remove one data source entirely.

        Used to reset simulated data between runs. Live data is never purged by
        anything the application calls on its own.
        """
        with self.db.begin() as conn:
            for table in (trades, quotes, book_snapshots, bars):
                conn.execute(delete(table).where(table.c.data_source == source.value))


#: How many times an append may lose the race for the chain head before it
#: gives up. Generous enough for ordinary contention, small enough that a
#: livelock fails loudly instead of hanging.
_APPEND_ATTEMPTS = 8
_APPEND_RETRY_S = 0.01

#: Guards the read-modify-write of the chain head. Module level rather than
#: per instance because two `PredictionRepository` objects opened on the same
#: database are two writers to one chain, and a per-instance lock would not
#: see the other. Appends happen a few times a minute, so the coarseness
#: costs nothing. Across processes the unique index is what holds the line.
_APPEND_LOCK = threading.Lock()


def _is_chain_collision(error: IntegrityError) -> bool:
    """True when an insert lost the race for the chain head, not when it was invalid.

    Matched on the constraint's own name and on the column, because the two
    supported backends word it differently:

        SQLite      UNIQUE constraint failed: predictions.prev_hash
        PostgreSQL  duplicate key value violates unique constraint
                    "ux_prediction_chain"

    Matching on text is not lovely. The alternative — treating every
    `IntegrityError` as retryable — is worse: it silently converts the schema's
    deliberate refusals into a timeout.
    """
    message = str(getattr(error, "orig", error)).lower()
    return "ux_prediction_chain" in message or "prev_hash" in message


@dataclass
class PredictionRepository:
    """Predictions and their outcomes.

    Writes go through `append`, which extends the hash chain. There is no update
    path and no delete path, by design and by database trigger.
    """

    db: Database

    def _head_hash(self, conn: Connection) -> str:
        row = conn.execute(
            select(predictions.c.row_hash).order_by(desc(predictions.c.id)).limit(1)
        ).first()
        return GENESIS if row is None else str(row[0])

    def append(self, row: dict[str, Any]) -> tuple[int, str]:
        """Extend the hash chain by one row.

        Reading the head and appending to it is a read-modify-write, and it was
        not atomic. Two threads — the API runs handlers on a thread pool, and the
        live runner forecasts each symbol on its own thread — could both read the
        same head and both append to it. Neither insert failed. The chain forked,
        and the next verification reported a break that was indistinguishable
        from tampering. The log whose entire purpose is to be trustworthy was
        quietly untrustworthy under ordinary concurrency.

        Two defences, because one is not enough:

        * a process-wide lock, which removes the contention in the common case
          where every writer is in this process;
        * a unique index on `prev_hash`, which makes a fork impossible even
          across processes. The loser of a race gets an `IntegrityError`, re-reads
          the head and tries again.

        The retry is bounded. Livelock under heavy contention should surface as a
        loud failure, not as an append that never returns.
        """
        last: Exception | None = None
        for _ in range(_APPEND_ATTEMPTS):
            with _APPEND_LOCK:
                try:
                    with self.db.begin() as conn:
                        prev = self._head_hash(conn)
                        digest = row_digest(row, prev)
                        result = conn.execute(
                            insert(predictions).values(**row, prev_hash=prev, row_hash=digest)
                        )
                        key = result.inserted_primary_key
                        assert key is not None, "insert must return a primary key"
                        return int(key[0]), digest
                except IntegrityError as exc:
                    # Only a chain-head collision is retryable. Every other
                    # integrity failure is a refusal the caller must see: a
                    # probability of exactly 0 or 1, a horizon that runs
                    # backwards, a negative price. Retrying those eight times and
                    # then reporting a RuntimeError would turn a precise,
                    # intentional rejection into a vague one — which is what the
                    # first version of this loop did, and what the existing
                    # persistence tests caught.
                    if not _is_chain_collision(exc):
                        raise
                    last = exc
            time.sleep(_APPEND_RETRY_S)
        raise RuntimeError(
            f"could not extend the prediction chain after {_APPEND_ATTEMPTS} attempts: {last}"
        )

    def due_for_evaluation(self, now_ns: int, limit: int = 500) -> list[dict[str, Any]]:
        """Predictions whose horizon has passed and which have no outcome yet."""
        stmt = (
            select(predictions)
            .outerjoin(outcomes, outcomes.c.prediction_id == predictions.c.id)
            .where(and_(predictions.c.eval_at_ns <= now_ns, outcomes.c.prediction_id.is_(None)))
            .order_by(predictions.c.eval_at_ns)
            .limit(limit)
        )
        with self.db.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(stmt)]

    def record_outcome(self, values: dict[str, Any]) -> None:
        """Idempotent: resolving twice is a no-op, not a duplicate row."""
        with self.db.begin() as conn:
            existing = conn.execute(
                select(outcomes.c.prediction_id).where(
                    outcomes.c.prediction_id == values["prediction_id"]
                )
            ).first()
            if existing is not None:
                return
            conn.execute(insert(outcomes).values(**values))

    def history(
        self,
        limit: int = 50,
        *,
        symbol: str | None = None,
        horizon_s: int | None = None,
        prediction_mode: str | None = "live",
    ) -> list[dict[str, Any]]:
        conditions: list[Any] = []
        if symbol:
            conditions.append(predictions.c.symbol == symbol)
        if horizon_s:
            conditions.append(predictions.c.horizon_s == horizon_s)
        if prediction_mode:
            conditions.append(predictions.c.prediction_mode == prediction_mode)
        stmt = (
            select(predictions, outcomes)
            .outerjoin(outcomes, outcomes.c.prediction_id == predictions.c.id)
            .order_by(desc(predictions.c.created_ns))
            .limit(limit)
        )
        if conditions:
            stmt = stmt.where(and_(*conditions))
        with self.db.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(stmt)]

    def scored(
        self,
        *,
        symbol: str | None = None,
        horizon_s: int | None = None,
        model_version: str | None = None,
        prediction_mode: str | None = "live",
        data_source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Every prediction that has a resolved outcome.

        The unit of aggregation upstream is the (symbol, horizon, model version,
        source triple) group. Nothing here mixes them, because a Brier score
        averaged over two different models describes neither.
        """
        conditions: list[Any] = [
            outcomes.c.outcome.in_(("above", "below", "stale_above", "stale_below"))
        ]
        if symbol:
            conditions.append(predictions.c.symbol == symbol)
        if horizon_s:
            conditions.append(predictions.c.horizon_s == horizon_s)
        if model_version:
            conditions.append(predictions.c.model_version == model_version)
        if prediction_mode:
            conditions.append(predictions.c.prediction_mode == prediction_mode)
        if data_source:
            conditions.append(predictions.c.data_source == data_source)
        stmt = (
            select(predictions, outcomes)
            .join(outcomes, outcomes.c.prediction_id == predictions.c.id)
            .where(and_(*conditions))
            .order_by(predictions.c.as_of_ns)
        )
        with self.db.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(stmt)]

    def verify_chain(self) -> int:
        stmt = select(predictions).order_by(predictions.c.id)
        with self.db.connect() as conn:
            rows = [dict(r._mapping) for r in conn.execute(stmt)]
        return verify_chain(rows)

    def count(self) -> int:
        with self.db.connect() as conn:
            return int(conn.execute(select(func.count()).select_from(predictions)).scalar_one())


@dataclass
class ModelRepository:
    db: Database

    def register(self, values: dict[str, Any]) -> int:
        with self.db.begin() as conn:
            existing = conn.execute(
                select(models.c.id).where(models.c.version == values["version"])
            ).first()
            if existing is not None:
                conn.execute(update(models).where(models.c.id == existing[0]).values(**values))
                return int(existing[0])
            result = conn.execute(insert(models).values(**values))
            key = result.inserted_primary_key
            assert key is not None, "insert must return a primary key"
            return int(key[0])

    def get(self, version: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(select(models).where(models.c.version == version)).first()
        return None if row is None else dict(row._mapping)

    def production(self, symbol: str, horizon_s: int) -> dict[str, Any] | None:
        stmt = (
            select(models)
            .where(
                and_(
                    models.c.status == "production",
                    models.c.symbol == symbol,
                    models.c.horizon_s == horizon_s,
                )
            )
            .order_by(desc(models.c.promoted_ns))
            .limit(1)
        )
        with self.db.connect() as conn:
            row = conn.execute(stmt).first()
        return None if row is None else dict(row._mapping)

    def list_all(self) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            return [
                dict(r._mapping)
                for r in conn.execute(select(models).order_by(desc(models.c.trained_ns)))
            ]

    def set_status(self, version: str, status: str, promoted_ns: int | None = None) -> None:
        values: dict[str, Any] = {"status": status}
        if promoted_ns is not None:
            values["promoted_ns"] = promoted_ns
        with self.db.begin() as conn:
            conn.execute(update(models).where(models.c.version == version).values(**values))

    def record_decision(self, values: dict[str, Any]) -> None:
        with self.db.begin() as conn:
            conn.execute(insert(promotion_decisions).values(**values))

    def decisions(self, limit: int = 50) -> list[dict[str, Any]]:
        stmt = (
            select(promotion_decisions)
            .order_by(desc(promotion_decisions.c.decided_ns))
            .limit(limit)
        )
        with self.db.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(stmt)]


@dataclass
class QualityRepository:
    db: Database

    def record(
        self,
        *,
        observed_ns: int,
        venue: str,
        symbol: str | None,
        kind: str,
        severity: str,
        detail: str,
    ) -> None:
        with self.db.begin() as conn:
            conn.execute(
                insert(quality_events).values(
                    observed_ns=observed_ns,
                    venue=venue,
                    symbol=symbol,
                    kind=kind,
                    severity=severity,
                    detail=detail,
                )
            )

    def recent(self, limit: int = 100) -> list[dict[str, Any]]:
        stmt = select(quality_events).order_by(desc(quality_events.c.observed_ns)).limit(limit)
        with self.db.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(stmt)]

    def counts_by_kind(self, since_ns: int) -> dict[str, int]:
        stmt = (
            select(quality_events.c.kind, func.count())
            .where(quality_events.c.observed_ns >= since_ns)
            .group_by(quality_events.c.kind)
        )
        with self.db.connect() as conn:
            return {str(k): int(c) for k, c in conn.execute(stmt)}
