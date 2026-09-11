"""Opening and guarding the database.

The append-only guarantee on `predictions` is enforced by SQLite triggers rather
than by discipline. Application code that forgets is a bug; a trigger that raises
is a wall. On PostgreSQL the equivalent rules are created instead, so the
guarantee travels with the schema rather than with the engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

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
        if engine.dialect.name == "sqlite":
            with engine.begin() as conn:
                for statement in _SQLITE_APPEND_ONLY:
                    conn.execute(text(statement))

    return Database(engine=engine, dialect=engine.dialect.name)
