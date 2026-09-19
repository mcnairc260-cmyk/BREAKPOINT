"""The prediction log, and why it cannot be edited.

A forecasting product's track record is only worth something if it cannot be
tidied up after the fact. So predictions are append-only, hash-chained, and the
guarantee is enforced by the database rather than by anyone's good intentions.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from forecaster.store.hashchain import GENESIS, ChainBreak, row_digest, verify_chain
from forecaster.types import NS_PER_SECOND


def prediction_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "created_ns": 1_000,
        "as_of_ns": 1_000,
        "eval_at_ns": 1_000 + 300 * NS_PER_SECOND,
        "horizon_s": 300,
        "venue": "simulator",
        "symbol": "BTC-USD",
        "spot": 79_434.27,
        "target": 79_460.0,
        "z": 0.19,
        "sigma": 0.0017,
        "p_above": 0.42,
        "range_low": 79_280.0,
        "range_high": 79_590.0,
        "range_confidence": 0.8,
        "median": 79_434.27,
        "confidence": "moderate",
        "confidence_reasons": json.dumps(["test"]),
        "service_level": "full",
        "model_version": "baseline-t@test",
        "model_train_source": "simulated",
        "calibration_source": None,
        "data_source": "simulated",
        "prediction_mode": "live",
        "features_json": "{}",
        "feature_set_version": "fs-1",
        "contributions_json": "[]",
    }
    row.update(overrides)
    return row


class TestAppendOnly:
    def test_an_update_is_refused_by_the_database(self, repos) -> None:
        repos["prediction"].append(prediction_row())
        with (
            pytest.raises(IntegrityError, match="append-only"),
            repos["prediction"].db.begin() as conn,
        ):
            conn.execute(text("UPDATE predictions SET p_above = 0.99 WHERE id = 1"))

    def test_a_delete_is_refused_by_the_database(self, repos) -> None:
        repos["prediction"].append(prediction_row())
        with (
            pytest.raises(IntegrityError, match="append-only"),
            repos["prediction"].db.begin() as conn,
        ):
            conn.execute(text("DELETE FROM predictions WHERE id = 1"))

    def test_a_certain_probability_is_refused(self, repos) -> None:
        """Zero and one are claims of knowledge. The schema will not store them."""
        for impossible in (0.0, 1.0, -0.1, 1.5):
            with pytest.raises(IntegrityError, match="ck_probability_open_interval"):
                repos["prediction"].append(prediction_row(p_above=impossible))

    def test_a_backwards_horizon_is_refused(self, repos) -> None:
        with pytest.raises(IntegrityError, match="ck_horizon_forward"):
            repos["prediction"].append(prediction_row(eval_at_ns=500))


class TestHashChain:
    def test_the_chain_verifies_over_many_rows(self, repos) -> None:
        for i in range(25):
            repos["prediction"].append(prediction_row(created_ns=1_000 + i))
        assert repos["prediction"].verify_chain() == 25

    def test_the_first_row_links_to_genesis(self, repos) -> None:
        _, digest = repos["prediction"].append(prediction_row())
        assert digest == row_digest(prediction_row(), GENESIS)

    def test_a_tampered_row_is_detected(self, repos) -> None:
        """The chain is what makes the track record checkable rather than trusted.

        The database triggers block the ordinary edit paths, so this simulates a
        tamper the way a real one would have to happen — by going around them —
        and shows the chain still catches it.
        """
        for i in range(5):
            repos["prediction"].append(prediction_row(created_ns=1_000 + i))
        with repos["prediction"].db.begin() as conn:
            conn.execute(text("DROP TRIGGER trg_predictions_no_update"))
            conn.execute(text("UPDATE predictions SET p_above = 0.95 WHERE id = 3"))
        with pytest.raises(ChainBreak) as caught:
            repos["prediction"].verify_chain()
        assert caught.value.prediction_id == 3

    def test_verification_is_order_dependent(self) -> None:
        rows = []
        prev = GENESIS
        for i in range(3):
            row = prediction_row(created_ns=1_000 + i)
            digest = row_digest(row, prev)
            rows.append({**row, "id": i + 1, "prev_hash": prev, "row_hash": digest})
            prev = digest
        assert verify_chain(rows) == 3
        with pytest.raises(ChainBreak):
            verify_chain([rows[0], rows[2], rows[1]])


class TestOutcomes:
    def test_resolving_twice_writes_one_row(self, repos) -> None:
        prediction_id, _ = repos["prediction"].append(prediction_row())
        outcome = {
            "prediction_id": prediction_id,
            "resolved_ns": 2_000,
            "eval_price": 79_500.0,
            "eval_price_ns": 1_900,
            "staleness_ns": 100,
            "outcome": "above",
            "correct": True,
            "brier": 0.336,
            "log_loss": 0.867,
            "tie": False,
            "resolver_version": "resolver-1",
        }
        repos["prediction"].record_outcome(outcome)
        repos["prediction"].record_outcome({**outcome, "eval_price": 1.0})
        rows = repos["prediction"].scored(prediction_mode="live")
        assert len(rows) == 1
        # The first resolution stands; a re-run cannot rewrite it.
        assert rows[0]["eval_price"] == 79_500.0

    def test_only_expired_predictions_come_up_for_evaluation(self, repos) -> None:
        eval_at = 1_000 + 300 * NS_PER_SECOND
        repos["prediction"].append(prediction_row())
        assert repos["prediction"].due_for_evaluation(eval_at - 1) == []
        assert len(repos["prediction"].due_for_evaluation(eval_at)) == 1

    def test_resolved_predictions_stop_coming_up(self, repos) -> None:
        prediction_id, _ = repos["prediction"].append(prediction_row())
        eval_at = 1_000 + 300 * NS_PER_SECOND
        repos["prediction"].record_outcome(
            {
                "prediction_id": prediction_id,
                "resolved_ns": eval_at,
                "eval_price": 79_500.0,
                "eval_price_ns": eval_at,
                "staleness_ns": 0,
                "outcome": "above",
                "correct": True,
                "brier": 0.3,
                "log_loss": 0.8,
                "tie": False,
                "resolver_version": "resolver-1",
            }
        )
        assert repos["prediction"].due_for_evaluation(eval_at) == []
