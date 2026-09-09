"""The prediction hash chain.

Each prediction row carries the hash of the row before it. Recomputing the chain
from the stored fields proves that no forecast was edited, inserted or removed
after the fact.

This is the difference between a track record and a claim about a track record.
A forecasting product that cannot prove its own history is asking to be taken on
trust, and it is exactly the kind of product that should not be.

The digest covers only fields fixed at prediction time. The outcome lives in a
different table precisely so that resolving a forecast cannot alter the row that
was committed to.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

GENESIS = "0" * 64

# Order matters and must never change: it is part of the digest. Appending a new
# field to the end is safe; reordering silently invalidates every prior chain.
CHAINED_FIELDS: tuple[str, ...] = (
    "created_ns",
    "as_of_ns",
    "eval_at_ns",
    "horizon_s",
    "venue",
    "symbol",
    "spot",
    "target",
    "z",
    "sigma",
    "p_above",
    "range_low",
    "range_high",
    "median",
    "confidence",
    "service_level",
    "model_version",
    "model_train_source",
    "calibration_source",
    "data_source",
    "prediction_mode",
    "feature_set_version",
    "features_json",
)


def _canonical(value: Any) -> Any:
    """Render floats so the digest is stable across platforms.

    `repr` of a float is shortest-roundtrip and can differ between interpreters;
    a fixed 12-significant-digit form is reproducible and far more precision than
    any price or probability here carries.
    """
    if isinstance(value, float):
        return f"{value:.12g}"
    if value is None:
        return None
    return value


def row_digest(row: dict[str, Any], prev_hash: str) -> str:
    """Hash one prediction row against the hash of its predecessor."""
    payload = {name: _canonical(row.get(name)) for name in CHAINED_FIELDS}
    payload["prev_hash"] = prev_hash
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class ChainBreak(Exception):
    """Raised when the recomputed chain does not match what is stored."""

    def __init__(self, prediction_id: int, expected: str, found: str) -> None:
        super().__init__(
            f"prediction {prediction_id}: hash chain broken "
            f"(expected {expected[:12]}…, stored {found[:12]}…)"
        )
        self.prediction_id = prediction_id
        self.expected = expected
        self.found = found


def verify_chain(rows: list[dict[str, Any]]) -> int:
    """Recompute the chain over rows in insertion order. Returns rows checked."""
    prev = GENESIS
    for row in rows:
        if row["prev_hash"] != prev:
            raise ChainBreak(int(row["id"]), prev, str(row["prev_hash"]))
        expected = row_digest(row, prev)
        if expected != row["row_hash"]:
            raise ChainBreak(int(row["id"]), expected, str(row["row_hash"]))
        prev = expected
    return len(rows)
