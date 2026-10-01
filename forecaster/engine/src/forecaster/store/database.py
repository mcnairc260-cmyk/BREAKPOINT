"""Opening and guarding the database.

The append-only guarantee on `predictions` is enforced by SQLite triggers rather
than by discipline. Application code that forgets is a bug; a trigger that raises
is a wall. On PostgreSQL the equivalent rules are created instead, so the
guarantee travels with the schema rather than with the engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import Connection

from forecaster.store.schema import metadata

_SQLITE_APPEND_ONLY = (
    """
    CREATE TRIGGER IF NOT EXISTS trg_predictions_no_update
    BEFORE UPDATE ON predictions
    BEGIN
        SELECT RAISE(ABORT, 'predictions is append-only: a forecast cannot be edited');
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS trg_predictions_no_delete
    BEFORE DELETE ON predictions
    BEGIN
        SELECT RAISE(ABORT, 'predictions is append-only: a forecast may not be deleted');
    END;
    """,
)


def apply_append_only_guard(conn: Connection, dialect: str) -> None:
    """(Re)create the triggers that make `predictions` append-only.

    Takes a connection rather than opening one so that the caller can drop the
    update trigger and put it back inside a single transaction: if anything in
    between fails, the rollback restores the guard along with everything else,
    and there is no window in which the table is silently editable.

    Public because the one sanctioned exception to append-only -- blanking the
    derived `contributions_json` column -- has to suspend that trigger. It must
    put back *this* definition rather than a copy living next to the migration,
    because a copy can drift and the drift would be invisible: the table would
    still look guarded while allowing an edit.
    """
    if dialect != "sqlite":
        return
    for statement in _SQLITE_APPEND_ONLY:
        conn.execute(text(statement))


@dataclass
class Database:
    engine: Engine
    dialect: str

    def connect(self) -> Connection:
        return self.engine.connect()

    def begin(self) -> Connection:
        return self.engine.begin()  # type: ignore[return-value]

    def dispose(self) -> None:
        self.engine.dispose()


def _add_column_if_missing(conn: Any, table: str, column: str, ddl_type: str) -> None:
    """Add a nullable column to an existing table, once.

    `create_all` skips a table that already exists, so a column added later never
    reaches a database created before it. There is no migration tool here and one
    would be overkill for a nullable column; what matters is that this is
    idempotent and that existing rows are left NULL rather than back-filled with
    a guess.
    """
    existing = (
        {
            str(row[1] if not isinstance(row, dict) else row["name"])
            for row in conn.execute(text(f"PRAGMA table_info({table})"))
        }
        if conn.engine.dialect.name == "sqlite"
        else {
            str(row[0])
            for row in conn.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name = :t"),
                {"t": table},
            )
        }
    )
    if existing and column not in existing:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


def open_database(url: str, *, create: bool = True) -> Database:
    """Open the database, creating the schema and its guarantees if asked."""
    if url.startswith("sqlite"):
        path_part = url.split("///", 1)[-1]
        if path_part and path_part != ":memory:":
            Path(path_part).parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, future=True)

    if engine.dialect.name == "sqlite":

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_connection: object, _record: object) -> None:
            cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
            # WAL so the collector writing does not block the API reading.
            cursor.execute("PRAGMA journal_mode=WAL")
            # NORMAL rather than FULL: the tick layer is high volume and a
            # handful of lost ticks after a hard power cut is survivable, while
            # fsync on every insert is not.
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    if create:
        metadata.create_all(engine)
        # `create_all` skips a table that already exists, and skips its indexes
        # with it. The chain-fork guard therefore has to be issued explicitly, or
        # a database created before the guard existed would never gain it — and
        # that is exactly the database with history worth protecting.
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_prediction_chain "
                    "ON predictions (prev_hash)"
                )
            )
            _add_column_if_missing(conn, "quality_events", "data_source", "VARCHAR(16)")
        with engine.begin() as conn:
            apply_append_only_guard(conn, engine.dialect.name)

    return Database(engine=engine, dialect=engine.dialect.name)
