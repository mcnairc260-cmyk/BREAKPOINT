"""Learned models, built as corrections to the baseline.

The central design decision, and the reason the comparisons in `VALIDATION.md`
mean anything:

    logit(p) = logit(p_baseline(z)) + g(features, z)

A learner does not predict the probability. It predicts the **correction** to the
baseline's probability. Three things follow, all of them load-bearing:

1. **"Does machine learning add anything?" becomes a testable null.** It is
   exactly the hypothesis that g is zero. A free-standing classifier given `z` as
   a feature would rediscover the baseline, score almost identically, and be
   reported as "LightGBM beats the volatility model" — which would be a claim
   about nothing.

2. **The monotonicity guarantee survives.** The baseline term is monotone
   decreasing in z by construction, and g is constrained to be monotone
   non-increasing in z as well. A sum of two non-increasing functions is
   non-increasing, and the sigmoid preserves order, so raising the target can
   never raise the probability of clearing it. This is enforced structurally, not
   checked afterwards and hoped for.

3. **It degrades gracefully.** In conditions unlike anything in training, the
   correction is small and the answer falls back toward the baseline, rather than
   a tree extrapolating confidently off the end of its training distribution.

Hyperparameters are fixed at documented defaults and are **not tuned on
simulated data** — the trainer refuses. Tuning against a simulator is fitting the
simulator, and the resulting numbers would describe this repository's code rather
than any market.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from forecaster.features.compute import FEATURE_NAMES
from forecaster.models.base import clamp_probability
from forecaster.models.dataset import Dataset
from forecaster.types import DataSource

LOGIT_CLAMP = 12.0
"""Keeps the offset finite. A baseline probability of 1e-4 has a logit of about
-9.2, so this never binds in practice and only guards against a corrupted input."""


def logit(p: np.ndarray | float) -> np.ndarray | float:
    clipped = np.clip(p, 1e-6, 1.0 - 1e-6)
    return np.clip(np.log(clipped / (1.0 - clipped)), -LOGIT_CLAMP, LOGIT_CLAMP)


def expit(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -LOGIT_CLAMP, LOGIT_CLAMP)))


class TuningRefused(Exception):
    """Raised when hyperparameter search is attempted on simulated data."""


@dataclass
class LogisticCorrection:
    """A linear correction to the baseline. The simplest thing that could help.

    Fitted with an offset, so the intercept measures a systematic bias in the
    baseline and each coefficient measures what one feature adds beyond it.
    Coefficients are directly readable, which makes this the model that explains
    *why* a forecast moved — used for the contributing-signals panel even when a
    stronger model produces the number.
    """

    coefficients: np.ndarray | None = None
    intercept: float = 0.0
    feature_names: tuple[str, ...] = FEATURE_NAMES
    include_z: bool = False
    """Whether z survived the monotonicity check. False means the correction is a
    pure level shift and monotonicity is inherited from the baseline exactly."""
    z_coefficient: float = 0.0
    train_data_source: DataSource | None = None
    trained_ns: int | None = None
    version_suffix: str = "untrained"
    train_summary: dict[str, Any] = field(default_factory=dict)

    @property
    def family(self) -> str:
        return "logistic-z"

    @property
    def version(self) -> str:
        return f"{self.family}@{self.version_suffix}"

    @property
    def train_source(self) -> DataSource | None:
        return self.train_data_source

    @property
    def is_fitted(self) -> bool:
        return self.coefficients is not None

    def fit(self, dataset: Dataset, *, at_ns: int) -> LogisticCorrection:

        if len(dataset) == 0:
            raise ValueError("cannot fit on an empty dataset")

        design = np.column_stack([dataset.features, dataset.z])
        offset = np.asarray(logit(dataset.baseline_p), dtype=float)
        weights = dataset.instant_weights()

        # scikit-learn's logistic regression has no offset parameter, so the
        # correction is fitted by gradient descent on the penalised likelihood
        # with the offset held fixed. Small problem, few features, converges in
        # well under a second — not worth another dependency.
        coefficients, intercept = _fit_offset_logistic(
            design, dataset.label.astype(float), offset, weights
        )

        z_coefficient = float(coefficients[-1])
        # The constraint that keeps the product coherent: the correction may not
        # push probability UP as the target rises. A positive coefficient here
        # would do exactly that, so z is dropped and the correction becomes a
        # level shift — worse fitting, still honest.
        include_z = z_coefficient <= 0.0
        if not include_z:
            z_coefficient = 0.0
            coefficients = np.concatenate([coefficients[:-1], [0.0]])

        self.coefficients = coefficients[:-1]
        self.z_coefficient = z_coefficient
        self.include_z = include_z
        self.intercept = intercept
        self.train_data_source = dataset.data_source
        self.trained_ns = at_ns
        self.version_suffix = _version_suffix(dataset.data_source, at_ns)
        self.train_summary = {
            "n_rows": len(dataset),
            "n_instants": dataset.n_instants,
            "z_coefficient": z_coefficient,
            "z_dropped_for_monotonicity": not include_z,
            "intercept": intercept,
        }
        return self

    def correction(self, features: np.ndarray, z: np.ndarray | float) -> np.ndarray | float:
        if self.coefficients is None:
            return 0.0
        linear = features @ self.coefficients + self.intercept
        if self.include_z:
            linear = linear + self.z_coefficient * z
        return linear

    def predict_proba(self, dataset: Dataset) -> np.ndarray:
        offset = np.asarray(logit(dataset.baseline_p), dtype=float)
        return np.asarray(expit(offset + self.correction(dataset.features, dataset.z)), dtype=float)

    def adjust(self, baseline_p: float, features: list[float], z: float) -> float:
        offset = float(logit(baseline_p))
        shift = float(self.correction(np.asarray(features, dtype=float), z))
        return clamp_probability(float(expit(offset + shift)))

    def contributions(self, features: list[float]) -> list[tuple[str, float]]:
        """Per-feature contribution to the logit, for the explanation panel."""
        if self.coefficients is None:
            return []
        values = np.asarray(features, dtype=float)
        return [
            (name, float(values[i] * self.coefficients[i]))
            for i, name in enumerate(self.feature_names)
        ]

    def to_dict(self) -> dict[str, Any]:
        return {
            "family": self.family,
            "version": self.version,
            "coefficients": self.coefficients.tolist() if self.coefficients is not None else None,
            "intercept": self.intercept,
            "z_coefficient": self.z_coefficient,
            "include_z": self.include_z,
            "feature_names": list(self.feature_names),
            "train_data_source": self.train_data_source.value if self.train_data_source else None,
            "trained_ns": self.trained_ns,
            "version_suffix": self.version_suffix,
            "train_summary": self.train_summary,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LogisticCorrection:
        coefficients = payload.get("coefficients")
        source = payload.get("train_data_source")
        return cls(
            coefficients=np.asarray(coefficients, dtype=float) if coefficients else None,
            intercept=float(payload.get("intercept", 0.0)),
            feature_names=tuple(payload.get("feature_names", FEATURE_NAMES)),
            include_z=bool(payload.get("include_z", False)),
            z_coefficient=float(payload.get("z_coefficient", 0.0)),
            train_data_source=DataSource(source) if source else None,
            trained_ns=payload.get("trained_ns"),
            version_suffix=str(payload.get("version_suffix", "untrained")),
            train_summary=dict(payload.get("train_summary", {})),
        )


def _fit_offset_logistic(
    design: np.ndarray,
    labels: np.ndarray,
    offset: np.ndarray,
    weights: np.ndarray,
    *,
    l2: float = 1.0,
    iterations: int = 400,
    learning_rate: float = 0.25,
) -> tuple[np.ndarray, float]:
    """Weighted logistic regression with a fixed offset.

    Standardises the design internally so one learning rate works across
    features on wildly different scales, then unwinds the standardisation so the
    returned coefficients apply to raw inputs.

    The L2 penalty is deliberately firm. With only a few hundred genuinely
    independent observations, an unpenalised fit on twelve features will find
    structure that is not there.
    """
    n, p = design.shape
    mean = design.mean(axis=0)
    scale = design.std(axis=0)
    scale[scale < 1e-9] = 1.0
    scaled = (design - mean) / scale

    beta = np.zeros(p, dtype=float)
    bias = 0.0
    normaliser = float(np.sum(weights)) or 1.0

    for _ in range(iterations):
        prediction = expit(offset + scaled @ beta + bias)
        residual = (labels - prediction) * weights
        gradient = scaled.T @ residual / normaliser - l2 * beta / n
        bias_gradient = float(np.sum(residual)) / normaliser
        beta += learning_rate * gradient
        bias += learning_rate * bias_gradient

    raw_beta = beta / scale
    raw_bias = bias - float(np.sum(beta * mean / scale))
    return raw_beta, raw_bias


@dataclass
class GradientBoostedCorrection:
    """LightGBM fitted on the baseline's logit as an initial score.

    `init_score` is the natural expression of "learn the correction": the trees
    start from the baseline's answer and can only add to it. Combined with a
    monotone non-increasing constraint on z, the guarantee that probability falls
    as the target rises survives boosting.

    Hyperparameters are small and fixed. With a few hundred independent
    observations, a large tree ensemble is a memorisation device.
    """

    booster: Any = None
    feature_names: tuple[str, ...] = FEATURE_NAMES
    train_data_source: DataSource | None = None
    trained_ns: int | None = None
    version_suffix: str = "untrained"
    params: dict[str, Any] = field(default_factory=dict)
    train_summary: dict[str, Any] = field(default_factory=dict)

    DEFAULT_PARAMS: dict[str, Any] = field(
        default_factory=lambda: {
            "objective": "binary",
            "learning_rate": 0.03,
            "num_leaves": 7,
            "min_data_in_leaf": 200,
            "feature_fraction": 0.7,
            "bagging_fraction": 0.7,
            "bagging_freq": 1,
            "lambda_l2": 5.0,
            "verbosity": -1,
            "num_threads": 2,
        }
    )

    @property
    def family(self) -> str:
        return "lgbm-monotone"

    @property
    def version(self) -> str:
        return f"{self.family}@{self.version_suffix}"

    @property
    def train_source(self) -> DataSource | None:
        return self.train_data_source

    @property
    def is_fitted(self) -> bool:
        return self.booster is not None

    def fit(
        self, dataset: Dataset, *, at_ns: int, n_rounds: int = 150, tune: bool = False
    ) -> GradientBoostedCorrection:
        import lightgbm as lgb

        if tune and dataset.data_source is DataSource.SIMULATED:
            raise TuningRefused(
                "hyperparameter search on simulated data would fit the simulator, "
                "not the market; tune only on a real capture"
            )
        if len(dataset) == 0:
            raise ValueError("cannot fit on an empty dataset")

        design = dataset.design_matrix()
        offset = np.asarray(logit(dataset.baseline_p), dtype=float)
        weights = dataset.instant_weights()

        # Zero for every feature; -1 for z, the last column. This is what keeps
        # the correction from inverting the target ordering.
        monotone = [0] * len(self.feature_names) + [-1]

        params = {**self.DEFAULT_PARAMS, **self.params, "monotone_constraints": monotone}
        train_set = lgb.Dataset(
            design,
            label=dataset.label.astype(float),
            weight=weights,
            init_score=offset,
            feature_name=list(dataset.design_names),
            free_raw_data=False,
        )
        self.booster = lgb.train(params, train_set, num_boost_round=n_rounds)
        self.train_data_source = dataset.data_source
        self.trained_ns = at_ns
        self.version_suffix = _version_suffix(dataset.data_source, at_ns)
        self.train_summary = {
            "n_rows": len(dataset),
            "n_instants": dataset.n_instants,
            "n_rounds": n_rounds,
            "params": params,
            "tuned": False,
        }
        return self

    def predict_proba(self, dataset: Dataset) -> np.ndarray:
        if self.booster is None:
            return dataset.baseline_p.copy()
        offset = np.asarray(logit(dataset.baseline_p), dtype=float)
        raw = self.booster.predict(dataset.design_matrix(), raw_score=True)
        return np.asarray(expit(offset + np.asarray(raw, dtype=float)), dtype=float)

    def adjust(self, baseline_p: float, features: list[float], z: float) -> float:
        if self.booster is None:
            return baseline_p
        design = np.asarray([[*features, z]], dtype=float)
        raw = float(self.booster.predict(design, raw_score=True)[0])
        return clamp_probability(float(expit(float(logit(baseline_p)) + raw)))

    def importances(self) -> list[tuple[str, float]]:
        if self.booster is None:
            return []
        gains = self.booster.feature_importance(importance_type="gain")
        names = self.booster.feature_name()
        total = float(sum(gains)) or 1.0
        return sorted(
            ((n, float(g) / total) for n, g in zip(names, gains, strict=False)),
            key=lambda item: -item[1],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "family": self.family,
            "version": self.version,
            "model_string": self.booster.model_to_string() if self.booster else None,
            "feature_names": list(self.feature_names),
            "train_data_source": self.train_data_source.value if self.train_data_source else None,
            "trained_ns": self.trained_ns,
            "version_suffix": self.version_suffix,
            "train_summary": self.train_summary,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GradientBoostedCorrection:
        import lightgbm as lgb

        model_string = payload.get("model_string")
        source = payload.get("train_data_source")
        return cls(
            booster=lgb.Booster(model_str=model_string) if model_string else None,
            feature_names=tuple(payload.get("feature_names", FEATURE_NAMES)),
            train_data_source=DataSource(source) if source else None,
            trained_ns=payload.get("trained_ns"),
            version_suffix=str(payload.get("version_suffix", "untrained")),
            train_summary=dict(payload.get("train_summary", {})),
        )


def _version_suffix(source: DataSource, at_ns: int) -> str:
    from forecaster.clock import to_datetime

    stamp = to_datetime(at_ns).strftime("%Y%m%dT%H%M")
    tag = {"live": "live", "replay": "replay", "simulated": "sim"}[source.value]
    return f"{stamp}.{tag}"
