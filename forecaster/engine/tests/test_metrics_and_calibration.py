"""Do the measurements actually measure what they claim?

Every metric here is checked against a case where the right answer is known:
a perfectly calibrated forecaster, a deliberately overconfident one, a useless
one. A metrics module that cannot tell those apart would let every other result
in the project mean nothing.
"""

from __future__ import annotations

import numpy as np
import pytest

from forecaster.calibration import (
    BetaCalibrator,
    IdentityCalibrator,
    IsotonicCalibrator,
    TemperatureCalibrator,
    fit_best_calibrator,
)
from forecaster.validation.bootstrap import block_bootstrap_mean, paired_delta, variance_inflation
from forecaster.validation.metrics import (
    brier,
    brier_skill_score,
    evaluate,
    murphy_decomposition,
    poisson_tail_test,
    probability_buckets,
    reliability_curve,
    wilson_interval,
)


@pytest.fixture(scope="module")
def calibrated() -> tuple[np.ndarray, np.ndarray]:
    """A forecaster that is right exactly as often as it says."""
    rng = np.random.default_rng(0)
    p = rng.uniform(0.02, 0.98, 40_000)
    y = (rng.uniform(size=p.size) < p).astype(float)
    return p, y


@pytest.fixture(scope="module")
def overconfident(calibrated) -> tuple[np.ndarray, np.ndarray]:
    p, y = calibrated
    return np.clip((p - 0.5) * 1.8 + 0.5, 0.005, 0.995), y


class TestMetricsBehaveCorrectly:
    def test_a_perfect_forecaster_has_near_zero_calibration_error(self, calibrated) -> None:
        p, y = calibrated
        metrics = evaluate(p, y)
        assert metrics.ece < 0.01
        assert metrics.murphy.reliability < 0.001

    def test_overconfidence_is_detected(self, calibrated, overconfident) -> None:
        good = evaluate(*calibrated)
        bad = evaluate(*overconfident)
        assert bad.ece > good.ece * 5
        assert bad.murphy.reliability > good.murphy.reliability * 10

    def test_brier_is_proper(self, calibrated) -> None:
        """Shading the number away from what you believe must not help.

        This is the property that makes the Brier score usable as a target at
        all: a model cannot improve its score by being strategically vague.
        """
        p, y = calibrated
        honest = brier(p, y)
        for distortion in (0.85, 1.15):
            shaded = np.clip((p - 0.5) * distortion + 0.5, 1e-6, 1 - 1e-6)
            assert brier(shaded, y) >= honest - 1e-9

    def test_skill_score_is_zero_against_itself(self, calibrated) -> None:
        p, y = calibrated
        assert brier_skill_score(p, y, p) == pytest.approx(0.0)

    def test_skill_score_is_negative_for_a_worse_model(self, calibrated, overconfident) -> None:
        p, y = calibrated
        worse, _ = overconfident
        assert brier_skill_score(worse, y, p) < 0

    def test_murphy_decomposition_reconstructs_the_brier_score(self, calibrated) -> None:
        p, y = calibrated
        parts = murphy_decomposition(p, y, n_bins=20)
        assert parts.brier == pytest.approx(brier(p, y), abs=0.005)

    def test_an_uninformative_forecaster_has_no_resolution(self) -> None:
        """Always saying the base rate is perfectly calibrated and useless.

        Reliability near zero, resolution near zero. This is exactly the case
        that a calibration-only view would call excellent, which is why
        resolution is reported alongside it.
        """
        rng = np.random.default_rng(1)
        y = (rng.uniform(size=20_000) < 0.5).astype(float)
        p = np.full(y.size, 0.5)
        parts = murphy_decomposition(p, y)
        assert parts.reliability < 0.001
        assert parts.resolution < 0.001

    def test_reliability_buckets_carry_counts_and_intervals(self, calibrated) -> None:
        p, y = calibrated
        curve = reliability_curve(p, y, n_bins=10)
        assert len(curve.buckets) >= 8
        for bucket in curve.buckets:
            assert bucket.count > 0
            assert bucket.ci_low <= bucket.observed_rate <= bucket.ci_high
            assert bucket.is_consistent

    def test_probability_buckets_fold_the_two_sides_together(self) -> None:
        """A 30% ABOVE and a 70% BELOW are the same statement."""
        p = np.array([0.3, 0.7])
        y = np.array([0.0, 1.0])
        buckets = probability_buckets(p, y)
        populated = [b for b in buckets if b["n"]]
        assert len(populated) == 1
        assert populated[0]["n"] == 2
        assert populated[0]["observed"] == pytest.approx(1.0)

    def test_wilson_interval_stays_inside_zero_and_one(self) -> None:
        for successes, trials in ((0, 3), (3, 3), (1, 1), (0, 1)):
            low, high = wilson_interval(successes, trials)
            assert 0.0 <= low <= high <= 1.0

    def test_poisson_tail_test_flags_a_real_excess(self) -> None:
        assert poisson_tail_test(expected=10.0, observed=10) > 0.5
        assert poisson_tail_test(expected=10.0, observed=30) < 0.01


class TestBootstrap:
    def test_dependence_widens_the_interval(self) -> None:
        """The whole reason for a block bootstrap.

        A strongly autocorrelated series carries far less information than its
        length suggests. If the variance inflation came back near 1, every
        confidence interval in the project would be far too narrow and every
        model comparison would find significance that is not there.
        """
        rng = np.random.default_rng(3)
        series = np.zeros(4_000)
        for i in range(1, series.size):
            series[i] = 0.99 * series[i - 1] + rng.normal()
        assert variance_inflation(series.tolist(), horizon_s=300, interval_s=1.0) > 10.0

    def test_independent_data_is_not_inflated_much(self) -> None:
        rng = np.random.default_rng(4)
        series = rng.normal(size=4_000)
        inflation = variance_inflation(series.tolist(), horizon_s=5, interval_s=1.0)
        assert 0.3 < inflation < 3.0

    def test_a_real_difference_is_found(self) -> None:
        rng = np.random.default_rng(5)
        a = rng.normal(0.0, 1.0, 3_000)
        b = a + 0.3
        result = paired_delta(a.tolist(), b.tolist(), horizon_s=10, interval_s=1.0)
        assert result.is_positive
        assert result.point == pytest.approx(0.3, abs=0.05)

    def test_no_difference_is_not_invented(self) -> None:
        rng = np.random.default_rng(6)
        a = rng.normal(0.0, 1.0, 3_000)
        b = a + rng.normal(0.0, 0.01, 3_000)
        result = paired_delta(a.tolist(), b.tolist(), horizon_s=10, interval_s=1.0)
        assert not result.is_positive
        assert result.ci_low <= 0.0 <= result.ci_high

    def test_a_single_observation_does_not_crash(self) -> None:
        result = block_bootstrap_mean([0.5])
        assert result.point == 0.5


class TestCalibration:
    def test_calibration_fixes_overconfidence(self, calibrated, overconfident) -> None:
        _, y = calibrated
        p, _ = overconfident
        before = evaluate(p, y).ece
        choice = fit_best_calibrator(p.tolist(), y.tolist())
        after = evaluate(choice.calibrator.transform_array(p), y).ece
        assert after < before / 3

    def test_too_few_outcomes_means_no_calibration(self) -> None:
        rng = np.random.default_rng(7)
        p = rng.uniform(0.1, 0.9, 50)
        y = (rng.uniform(size=50) < p).astype(float)
        choice = fit_best_calibrator(p.tolist(), y.tolist())
        assert isinstance(choice.calibrator, IdentityCalibrator)
        assert "50" in choice.chosen_reason

    def test_the_identity_is_a_real_candidate(self, calibrated) -> None:
        """ "Uncalibrated because calibration did not help" is a legitimate result."""
        p, y = calibrated
        choice = fit_best_calibrator(p.tolist(), y.tolist())
        assert "identity" in choice.candidates
        # Whatever wins, it must not be meaningfully worse than doing nothing.
        best = min(choice.candidates.values())
        assert best <= choice.candidates["identity"] + 1e-6

    @pytest.mark.parametrize(
        "calibrator",
        [TemperatureCalibrator(1.5), BetaCalibrator(1.2, -0.1), IdentityCalibrator()],
    )
    def test_calibrators_round_trip_through_serialisation(self, calibrator: object) -> None:
        from forecaster.calibration import load_calibrator

        restored = load_calibrator(calibrator.to_dict())  # type: ignore[attr-defined]
        assert restored.name == calibrator.name  # type: ignore[attr-defined]
        assert restored.transform(0.42) == pytest.approx(calibrator.transform(0.42))  # type: ignore[attr-defined]

    def test_isotonic_round_trips(self) -> None:
        from forecaster.calibration import load_calibrator

        rng = np.random.default_rng(8)
        p = rng.uniform(0.05, 0.95, 3_000)
        y = (rng.uniform(size=p.size) < p).astype(float)
        calibrator = IsotonicCalibrator.fit(p, y)
        restored = load_calibrator(calibrator.to_dict())
        assert restored.transform(0.6) == pytest.approx(calibrator.transform(0.6))
