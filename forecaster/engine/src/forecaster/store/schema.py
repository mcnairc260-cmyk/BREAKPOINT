"""The database schema.

SQLAlchemy Core rather than the ORM, and rather than hand-written SQL. Core keeps
the SQL explicit and readable while making PostgreSQL a connection-string change
instead of a rewrite — the difference between a portability claim and portability.

Two decisions are worth explaining because they are load-bearing:

**Predictions are append-only and hash-chained.** A row is written before the
outcome could possibly be known, is never updated, and carries the hash of the
row before it. Outcomes go in a separate table keyed to the prediction. Without
this, "our live accuracy is 61%" is a sentence anyone can type; with it, the
claim is checkable by recomputing the chain. That property matters more than
any model in this repository.

**The tick layer is sampled, not exhaustive.** A full level-2 delta stream for a
single pair runs to gigabytes a day, which SQLite should not be asked to hold.
Trades and top-of-book are stored in full; book depth is a periodic top-N
snapshot. `ARCHITECTURE.md` records what this costs and what it would take to
reverse.
"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
)

metadata = MetaData()

# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

trades = Table(
    "trades",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("exchange_ns", BigInteger, nullable=False),
    Column("received_ns", BigInteger, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("price", Float, nullable=False),
    Column("size", Float, nullable=False),
    Column("side", String(8), nullable=False),
    Column("trade_id", String(64), nullable=False),
    Column("data_source", String(16), nullable=False),
    # The same trade arriving twice after a reconnect must not become two trades;
    # a duplicated print would inflate volume and dent the volatility estimate.
    UniqueConstraint("venue", "symbol", "trade_id", "data_source", name="ux_trade"),
    Index("ix_trades_lookup", "symbol", "venue", "exchange_ns"),
)

quotes = Table(
    "quotes",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("exchange_ns", BigInteger, nullable=False),
    Column("received_ns", BigInteger, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("bid", Float, nullable=False),
    Column("bid_size", Float, nullable=False),
    Column("ask", Float, nullable=False),
    Column("ask_size", Float, nullable=False),
    Column("data_source", String(16), nullable=False),
    Index("ix_quotes_lookup", "symbol", "venue", "received_ns"),
)

book_snapshots = Table(
    "book_snapshots",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("exchange_ns", BigInteger, nullable=False),
    Column("received_ns", BigInteger, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("bids_json", Text, nullable=False),
    Column("asks_json", Text, nullable=False),
    Column("sequence", BigInteger, nullable=True),
    Column("data_source", String(16), nullable=False),
    Index("ix_book_lookup", "symbol", "venue", "received_ns"),
)

bars = Table(
    "bars",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("open_ns", BigInteger, nullable=False),
    Column("resolution_s", Integer, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("open", Float, nullable=False),
    Column("high", Float, nullable=False),
    Column("low", Float, nullable=False),
    Column("close", Float, nullable=False),
    Column("volume", Float, nullable=False),
    Column("buy_volume", Float, nullable=False),
    Column("sell_volume", Float, nullable=False),
    Column("trade_count", Integer, nullable=False),
    Column("vwap", Float, nullable=False),
    Column("data_source", String(16), nullable=False),
    UniqueConstraint("venue", "symbol", "resolution_s", "open_ns", "data_source", name="ux_bar"),
    Index("ix_bars_lookup", "symbol", "resolution_s", "open_ns"),
)

# ---------------------------------------------------------------------------
# Predictions — append-only, hash-chained
# ---------------------------------------------------------------------------

predictions = Table(
    "predictions",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("created_ns", BigInteger, nullable=False),
    Column("as_of_ns", BigInteger, nullable=False),
    Column("eval_at_ns", BigInteger, nullable=False),
    Column("horizon_s", Integer, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("spot", Float, nullable=False),
    Column("target", Float, nullable=False),
    Column("z", Float, nullable=False),
    Column("sigma", Float, nullable=False),
    Column("p_above", Float, nullable=False),
    Column("range_low", Float, nullable=False),
    Column("range_high", Float, nullable=False),
    Column("range_confidence", Float, nullable=False),
    Column("median", Float, nullable=False),
    Column("confidence", String(16), nullable=False),
    Column("confidence_reasons", Text, nullable=False),
    Column("service_level", String(16), nullable=False),
    Column("model_version", String(128), nullable=False),
    # Three separate source fields, deliberately. A model trained on simulated
    # data serving a live feed is not a live result, and one column called
    # "data_source" would let exactly that be reported as clean.
    Column("model_train_source", String(16), nullable=False),
    Column("calibration_source", String(16), nullable=True),
    Column("data_source", String(16), nullable=False),
    Column("prediction_mode", String(16), nullable=False),
    Column("features_json", Text, nullable=False),
    Column("feature_set_version", String(64), nullable=False),
    Column("contributions_json", Text, nullable=False),
    Column("prev_hash", String(64), nullable=False),
    Column("row_hash", String(64), nullable=False),
    # A probability of exactly zero or one is a claim of certainty and makes log
    # loss infinite. Enforced in the model layer and again here, because the
    # database is the last place a bad number can be stopped.
    CheckConstraint("p_above > 0.0 AND p_above < 1.0", name="ck_probability_open_interval"),
    CheckConstraint("eval_at_ns > as_of_ns", name="ck_horizon_forward"),
    # The hash chain must not fork. Two rows sharing a `prev_hash` means two
    # writers read the same head and both appended to it, which silently
    # destroys the tamper-evidence the chain exists to provide — the
    # verifier then reports a break that looks like tampering. Expressing
    # "the chain is linear" as a uniqueness constraint makes the race
    # impossible rather than unlikely: the loser of the race gets an
    # IntegrityError and retries against the new head.
    Index("ux_prediction_chain", "prev_hash", unique=True),
    CheckConstraint("spot > 0.0 AND target > 0.0", name="ck_prices_positive"),
    Index("ix_pred_eval", "eval_at_ns"),
    Index("ix_pred_created", "created_ns"),
    Index("ix_pred_group", "symbol", "horizon_s", "model_version", "prediction_mode"),
)

outcomes = Table(
    "outcomes",
    metadata,
    Column("prediction_id", Integer, ForeignKey("predictions.id"), primary_key=True),
    Column("resolved_ns", BigInteger, nullable=False),
    Column("eval_price", Float, nullable=True),
    Column("eval_price_ns", BigInteger, nullable=True),
    Column("staleness_ns", BigInteger, nullable=True),
    Column("outcome", String(16), nullable=False),
    Column("correct", Boolean, nullable=True),
    Column("brier", Float, nullable=True),
    Column("log_loss", Float, nullable=True),
    Column("tie", Boolean, nullable=False, default=False),
    Column("resolver_version", String(32), nullable=False),
    Index("ix_outcome_resolved", "resolved_ns"),
)

# ---------------------------------------------------------------------------
# Models and evaluation
# ---------------------------------------------------------------------------

models = Table(
    "models",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("version", String(128), nullable=False, unique=True),
    Column("family", String(64), nullable=False),
    Column("symbol", String(16), nullable=True),
    Column("horizon_s", Integer, nullable=True),
    Column("trained_ns", BigInteger, nullable=False),
    Column("train_start_ns", BigInteger, nullable=False),
    Column("train_end_ns", BigInteger, nullable=False),
    Column("n_rows", Integer, nullable=False),
    Column("n_timestamps", Integer, nullable=False),
    Column("n_independent", Integer, nullable=False),
    Column("features_json", Text, nullable=False),
    Column("params_json", Text, nullable=False),
    Column("metrics_json", Text, nullable=False),
    Column("calibration_json", Text, nullable=True),
    Column("train_data_source", String(16), nullable=False),
    Column("calibration_source", String(16), nullable=True),
    Column("git_sha", String(64), nullable=True),
    Column("artifact_path", String(512), nullable=True),
    Column("status", String(16), nullable=False, default="candidate"),
    Column("promoted_ns", BigInteger, nullable=True),
    Column("notes", Text, nullable=True),
    CheckConstraint(
        "status IN ('candidate','production','retired','quarantined')", name="ck_model_status"
    ),
)

promotion_decisions = Table(
    "promotion_decisions",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("decided_ns", BigInteger, nullable=False),
    Column("candidate_version", String(128), nullable=False),
    Column("incumbent_version", String(128), nullable=True),
    Column("promoted", Boolean, nullable=False),
    Column("reason", Text, nullable=False),
    Column("evidence_json", Text, nullable=False),
)

quality_events = Table(
    "quality_events",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("observed_ns", BigInteger, nullable=False),
    Column("venue", String(32), nullable=False),
    Column("symbol", String(16), nullable=True),
    Column("kind", String(48), nullable=False),
    Column("severity", String(16), nullable=False),
    Column("detail", Text, nullable=False),
    # Nullable, and NULL means "recorded before sources were tracked" rather
    # than any particular source. A live report counts only rows that say they
    # are live, so unlabelled history is excluded rather than guessed at — the
    # alternative was a live report listing quality events from simulator runs.
    Column("data_source", String(16), nullable=True),
    Index("ix_quality_time", "observed_ns"),
)

ALL_TABLES = (
    trades,
    quotes,
    book_snapshots,
    bars,
    predictions,
    outcomes,
    models,
    promotion_decisions,
    quality_events,
)
