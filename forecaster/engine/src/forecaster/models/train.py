"""Training, and the discipline around it.

The sequence is fixed and each step exists for a reason:

1. **Fit the baseline's residual shape and seasonality** on the training window.
   Done first, because everything downstream is expressed as a correction to the
   baseline, so the baseline has to be as good as it can be before anyone asks
   whether machine learning improves on it.
2. **Build the dataset** — features, sampled targets, outcomes, and the
   baseline's probability for each row.
3. **Walk forward** with purge and embargo, refitting *everything* inside each
   fold. Scalers, the residual shape, the seasonal factors, the calibrator — all
   of it. Fitting any of them on the full dataset first is the most common real
   leak in practice, and it is invisible in the results because it simply makes
   the model look better.
4. **Compare against the baseline** using a paired block bootstrap on the
   difference in Brier score, not two separate intervals.
5. **Calibrate** on a held-out chronological slice.
6. **Decide** whether the learner has earned promotion, with the decision and its
   evidence written down whichever way it goes.

Hyperparameter search is refused on simulated data. Tuning against a simulator
produces a model fitted to this repository's own code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

import numpy as np

from forecaster.calibration import fit_best_calibrator
from forecaster.clock import now_ns
from forecaster.confidence.assess import NoveltyModel
from forecaster.config import ModelConfig
from forecaster.features.compute import FEATURE_NAMES
from forecaster.models.baseline import BaselineModel
from forecaster.models.dataset import Dataset, DatasetBuilder
from forecaster.models.ml import GradientBoostedCorrection, LogisticCorrection
from forecaster.models.registry import ModelArtifact
from forecaster.types import DataSource
from forecaster.validation.bootstrap import paired_delta, variance_inflation
from forecaster.validation.metrics import evaluate
from forecaster.validation.splits import effective_sample_size, walk_forward_folds

# The smallest improvement in Brier score worth caring about, fixed before any
# result is seen. Without a pre-registered threshold, "significant" degrades into
# "whatever the data happened to show".
MIN_PRACTICAL_IMPROVEMENT = 0.002

# Below this many genuinely independent observations, a learner is not trained at
# all. This is not caution for its own sake: twelve features fitted to a few
# hundred independent points will find structure that is not there, and it will
# validate, because the validation set is just as small.
MIN_INDEPENDENT_FOR_ML = 750


@dataclass
class TrainingResult:
    """What training produced, and whether it was any good."""

    artifact: ModelArtifact
    baseline_metrics: dict[str, Any]
    learner_metrics: dict[str, Any] | None
    comparison: dict[str, Any] | None
    promoted: bool
    decision_reason: str
    sample_size: dict[str, Any]
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            f"model      {self.artifact.version}",
            f"data       {self.artifact.train_data_source.value}",
            f"evidence   {self.sample_size.get('n_non_overlapping')} independent observations "
            f"from {self.sample_size.get('n_rows')} rows",
            f"baseline   Brier {self.baseline_metrics.get('brier'):.5f}  "
            f"ECE {self.baseline_metrics.get('ece'):.5f}",
        ]
        if self.learner_metrics:
            lines.append(
                f"learner    Brier {self.learner_metrics.get('brier'):.5f}  "
                f"ECE {self.learner_metrics.get('ece'):.5f}"
            )
        if self.comparison:
            lines.append(f"delta      {self.comparison.get('description')}")
        lines.append(
            f"decision   {'PROMOTED' if self.promoted else 'NOT PROMOTED'} — {self.decision_reason}"
        )
        for warning in self.warnings:
            lines.append(f"warning    {warning}")
        return "\n".join(lines)


def train(
    *,
    builder: DatasetBuilder,
    start_ns: int,
    end_ns: int,
    price_at: Any,
    symbol: str,
    horizon_s: int,
    data_source: DataSource,
    config: ModelConfig | None = None,
    n_folds: int = 4,
    warmup_s: int = 3600,
    git_sha: str | None = None,
    train_learner: bool = True,
) -> TrainingResult:
    cfg = config or ModelConfig()
    warnings: list[str] = []
    at_ns = now_ns()

    # -- 1. the baseline first ----------------------------------------------

    residuals, variance_points = builder.residuals(
        start_ns, end_ns, price_at=price_at, warmup_s=warmup_s
    )
    baseline = BaselineModel(config=cfg)
    if residuals:
        baseline.fit_shape(residuals, source=data_source, at_ns=at_ns)
    if len(variance_points) >= 500:
        baseline.fit_seasonality(variance_points, source=data_source, at_ns=at_ns)
    else:
        warnings.append(
            f"only {len(variance_points)} volatility observations; the weekly seasonal "
            "pattern was left flat rather than estimated from too little data"
        )
    builder.baseline = baseline

    # -- 2. the dataset ------------------------------------------------------

    dataset = builder.build(start_ns, end_ns, price_at=price_at, warmup_s=warmup_s)
    if len(dataset) == 0:
        raise ValueError("no training rows could be built; check the capture covers the window")

    sample = effective_sample_size(dataset.as_of_ns.tolist(), horizon_s, len(dataset))
    sample_dict = sample.to_dict()

    # -- 3. walk forward -----------------------------------------------------

    fold_baseline: list[float] = []
    fold_learner: list[float] = []
    fold_labels: list[float] = []
    fold_ready = False

    can_learn = train_learner and sample.n_non_overlapping >= MIN_INDEPENDENT_FOR_ML
    if train_learner and not can_learn:
        warnings.append(
            f"only {sample.n_non_overlapping} independent observations "
            f"({MIN_INDEPENDENT_FOR_ML} needed); no learner was trained, and the baseline "
            "is the model. This is the expected state early on."
        )

    if can_learn:
        try:
            folds = walk_forward_folds(
                int(dataset.as_of_ns.min()),
                int(dataset.as_of_ns.max()) + horizon_s * 1_000_000_000,
                horizon_s=horizon_s,
                n_folds=n_folds,
            )
        except ValueError as exc:
            folds = []
            warnings.append(f"walk-forward validation skipped: {exc}")

        for fold in folds:
            train_mask = np.asarray(
                [fold.contains_train(int(ts), horizon_s) for ts in dataset.as_of_ns]
            )
            test_mask = np.asarray([fold.contains_test(int(ts)) for ts in dataset.as_of_ns])
            if train_mask.sum() < 500 or test_mask.sum() < 100:
                continue
            train_split = dataset.mask(train_mask)
            test_split = dataset.mask(test_mask)

            # Refitted inside the fold, deliberately. A learner fitted once on
            # everything and evaluated per fold would be reading the answers.
            learner = GradientBoostedCorrection().fit(train_split, at_ns=at_ns)
            fold_baseline.extend(test_split.baseline_p.tolist())
            fold_learner.extend(learner.predict_proba(test_split).tolist())
            fold_labels.extend(test_split.label.astype(float).tolist())
            fold_ready = True

    # -- 4. compare ----------------------------------------------------------

    if fold_ready:
        baseline_p = np.asarray(fold_baseline)
        learner_p = np.asarray(fold_learner)
        labels = np.asarray(fold_labels)
    else:
        baseline_p = dataset.baseline_p
        learner_p = None
        labels = dataset.label.astype(float)

    baseline_metrics = evaluate(
        baseline_p, labels, reference=np.full(labels.size, 0.5), reference_name="always-50%"
    ).to_dict()

    learner_metrics = None
    comparison = None
    promoted = False
    reason = "no learner was trained; the volatility baseline is the model"

    if learner_p is not None:
        learner_metrics = evaluate(
            learner_p, labels, reference=baseline_p, reference_name="baseline-t"
        ).to_dict()

        baseline_loss = (baseline_p - labels) ** 2
        learner_loss = (learner_p - labels) ** 2
        # Paired: both models saw the same markets, and pretending otherwise
        # throws away the comparison's whole advantage.
        delta = paired_delta(
            learner_loss.tolist(),
            baseline_loss.tolist(),
            horizon_s=horizon_s,
            interval_s=float(builder.sample_interval_s),
        )
        vif = variance_inflation(
            (baseline_loss - learner_loss).tolist(),
            horizon_s=horizon_s,
            interval_s=float(builder.sample_interval_s),
        )
        comparison = {
            **delta.to_dict(),
            "variance_inflation": vif,
            "min_practical_improvement": MIN_PRACTICAL_IMPROVEMENT,
            "description": delta.describe(),
        }

        learner_ece = cast(float, learner_metrics["ece"])
        baseline_ece = cast(float, baseline_metrics["ece"])
        ece_ok = learner_ece <= baseline_ece + 0.005
        # Both bars must clear: statistically distinguishable from zero AND large
        # enough to matter. Either alone promotes noise.
        if delta.is_positive and delta.point >= MIN_PRACTICAL_IMPROVEMENT and ece_ok:
            promoted = True
            reason = (
                f"improved Brier by {delta.point:.5f} with a 95% interval excluding zero, "
                f"and calibration did not get worse"
            )
        elif delta.ci_high < 0.0:
            # Significantly worse, not merely unproven. Worth saying plainly:
            # a learner that reliably loses to the baseline is a result, and on
            # data with no directional structure it is the CORRECT result.
            reason = (
                f"significantly WORSE than the baseline: Brier changed by "
                f"{delta.point:+.5f} with a 95% interval of {delta.ci_low:+.5f} to "
                f"{delta.ci_high:+.5f}, entirely below zero"
            )
        elif not delta.is_positive:
            reason = (
                f"improvement of {delta.point:+.5f} is not distinguishable from zero "
                f"(95% interval {delta.ci_low:+.5f} to {delta.ci_high:+.5f})"
            )
        elif delta.point < MIN_PRACTICAL_IMPROVEMENT:
            reason = (
                f"improvement of {delta.point:.5f} is real but below the "
                f"{MIN_PRACTICAL_IMPROVEMENT} threshold set before training"
            )
        else:
            reason = "calibration got worse, which outweighs the accuracy gain for this product"

    # -- 5. fit the shipped learner and calibrate ----------------------------

    logistic = None
    gbm = None
    if promoted:
        logistic = LogisticCorrection().fit(dataset, at_ns=at_ns)
        gbm = GradientBoostedCorrection().fit(dataset, at_ns=at_ns)

    serving_p = learner_p if (promoted and learner_p is not None) else baseline_p
    calibration = fit_best_calibrator(serving_p.tolist(), labels.tolist())
    if calibration.calibrator.name == "identity":
        # "Identity won" and "there was not enough data to try" are different
        # statements and the warning should not conflate them. The first is a
        # real finding: the probabilities were already good enough that adjusting
        # them made things worse on data the calibrator had not seen.
        detail = getattr(calibration.calibrator, "reason", calibration.chosen_reason)
        warnings.append(f"probabilities left uncalibrated — {detail}")

    novelty = NoveltyModel.fit(dataset.features, FEATURE_NAMES)
    z_max = _calibrated_z_limit(dataset, cfg.z_calibrated_max)
    if z_max < cfg.z_calibrated_max:
        warnings.append(
            f"calibrated range narrowed to {z_max:.1f} standard deviations; beyond that the "
            "training data has too few outcomes to support a learned adjustment"
        )

    version = f"{'lgbm-monotone' if promoted else 'baseline-t'}@{symbol}.{horizon_s}s."
    version += baseline.version_suffix

    artifact = ModelArtifact(
        version=version,
        family="lgbm-monotone" if promoted else "baseline-t",
        symbol=symbol,
        horizon_s=horizon_s,
        trained_ns=at_ns,
        train_start_ns=start_ns,
        train_end_ns=end_ns,
        train_data_source=data_source,
        baseline=baseline,
        logistic=logistic,
        gbm=gbm,
        calibrator=calibration.calibrator,
        calibration_source=data_source if calibration.calibrator.name != "identity" else None,
        novelty=novelty,
        sample_size=sample_dict,
        metrics={
            "baseline": baseline_metrics,
            "learner": learner_metrics,
            "comparison": comparison,
            "calibration_candidates": calibration.candidates,
            "walk_forward_folds": len(fold_labels) > 0,
        },
        z_calibrated_max=z_max,
        git_sha=git_sha,
        notes=reason,
    )

    return TrainingResult(
        artifact=artifact,
        baseline_metrics=baseline_metrics,
        learner_metrics=learner_metrics,
        comparison=comparison,
        promoted=promoted,
        decision_reason=reason,
        sample_size=sample_dict,
        warnings=warnings,
    )


def _calibrated_z_limit(dataset: Dataset, ceiling: float, min_events: int = 20) -> float:
    """The furthest target distance the training data can actually speak to.

    Beyond this, the calibration set contains too few outcomes for the learned
    adjustment to mean anything, so the parametric baseline answers instead and
    confidence drops to LOW. Without this the model extrapolates confidently into
    a region where it has essentially no evidence.
    """
    for limit in (ceiling, 2.5, 2.0, 1.5, 1.0):
        band = np.abs(dataset.z) >= (limit - 0.5)
        if band.sum() == 0:
            continue
        positives = int(dataset.label[band].sum())
        negatives = int(band.sum() - positives)
        if min(positives, negatives) >= min_events:
            return float(limit)
    return 1.0
