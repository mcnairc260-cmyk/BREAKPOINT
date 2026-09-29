"""Making stated probabilities match observed frequencies.

A calibrator maps a raw probability to a corrected one, fitted on a held-out
**chronological** slice that neither the model nor its features have seen.

One rule governs the whole module, and it is not negotiable:

    A calibrator is a function of the probability alone.

Not of the target, not of the distance to the target, not of anything that
varies across targets at a single instant. The moment a calibrator reads `z`, the
guarantee that probability falls as the target rises is gone — bucket boundaries
introduce jumps, and the product can print a higher chance of clearing a higher
price. It is tempting to fit per-distance calibrators, because miscalibration
genuinely does vary with distance, and it is exactly the wrong thing to do. Where
the model is miscalibrated by distance, the fix belongs in the model or the tail
shape, not in a calibrator that quietly breaks coherence.

Conditioning on horizon, symbol or volatility regime is fine: those are constant
across targets at a given instant. Separate calibrators per horizon are in fact
the normal case.

Three implementations, all strictly increasing:

* **Temperature** — one parameter, scales the logit. The right default with
  little data: it fixes systematic over- or under-confidence and cannot do much
  else.
* **Beta** — two parameters, handles asymmetric miscalibration, still smooth.
* **Isotonic** — non-parametric, most flexible, and interpolated between block
  midpoints rather than used as a raw step function. Plain isotonic returns the
  same value across wide ranges of input, which produces flat spots the user
  sees as a broken slider, and quantises output to a handful of distinct values.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import numpy as np

from forecaster.types import PROB_FLOOR

# Below this many outcomes, calibration fits noise. The identity calibrator is
# returned instead and the system reports that it is uncalibrated — which is a
# more useful thing to tell a user than a confidently wrong adjustment.
MIN_CALIBRATION_SAMPLES = 500


@runtime_checkable
class Calibrator(Protocol):
    @property
    def name(self) -> str: ...

    def transform(self, p: float) -> float: ...

    def transform_array(self, p: np.ndarray) -> np.ndarray: ...

    def to_dict(self) -> dict[str, Any]: ...


def _clamp(p: np.ndarray | float) -> np.ndarray | float:
    return np.clip(p, PROB_FLOOR, 1.0 - PROB_FLOOR)


def _logit(p: np.ndarray | float) -> np.ndarray | float:
    q = _clamp(p)
    return np.log(q / (1.0 - q))


def _expit(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))


@dataclass(frozen=True)
class IdentityCalibrator:
    """No adjustment. What ships until there is evidence to do otherwise."""

    reason: str = "not enough resolved outcomes to calibrate"

    @property
    def name(self) -> str:
        return "identity"

    def transform(self, p: float) -> float:
        return float(_clamp(p))

    def transform_array(self, p: np.ndarray) -> np.ndarray:
        return np.asarray(_clamp(p), dtype=float)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "reason": self.reason}


@dataclass(frozen=True)
class TemperatureCalibrator:
    """Divides the logit by a temperature. One parameter, hard to overfit.

    Temperature above 1 pulls probabilities toward 50% — the fix for a model that
    is too sure of itself, which is the usual direction of failure.
    """

    temperature: float
    n_samples: int = 0

    @property
    def name(self) -> str:
        return "temperature"

    def transform(self, p: float) -> float:
        return float(_expit(_logit(p) / self.temperature))

    def transform_array(self, p: np.ndarray) -> np.ndarray:
        return np.asarray(_expit(_logit(p) / self.temperature), dtype=float)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "temperature": self.temperature, "n_samples": self.n_samples}

    @classmethod
    def fit(cls, p: np.ndarray, y: np.ndarray) -> TemperatureCalibrator:
        """Golden-section search on log loss. One bounded parameter; no optimiser
        library needed, and the bounds make a runaway fit impossible."""
        raw = np.asarray(_logit(p), dtype=float)
        labels = np.asarray(y, dtype=float)

        def loss(t: float) -> float:
            q = np.clip(_expit(raw / t), 1e-9, 1.0 - 1e-9)
            return float(-np.mean(labels * np.log(q) + (1.0 - labels) * np.log(1.0 - q)))

        low, high = 0.25, 6.0
        phi = (math.sqrt(5.0) - 1.0) / 2.0
        c, d = high - phi * (high - low), low + phi * (high - low)
        for _ in range(60):
            if loss(c) < loss(d):
                high, d = d, c
                c = high - phi * (high - low)
            else:
                low, c = c, d
                d = low + phi * (high - low)
        return cls(temperature=(low + high) / 2.0, n_samples=int(labels.size))


@dataclass(frozen=True)
class BetaCalibrator:
    """Two-parameter calibration in logit space: `a·logit(p) + b`.

    Handles the common case where a model is well calibrated in one direction and
    not the other. Strictly increasing as long as `a > 0`, which the fit enforces.
    """

    a: float
    b: float
    n_samples: int = 0

    @property
    def name(self) -> str:
        return "beta"

    def transform(self, p: float) -> float:
        return float(_expit(self.a * _logit(p) + self.b))

    def transform_array(self, p: np.ndarray) -> np.ndarray:
        return np.asarray(_expit(self.a * _logit(p) + self.b), dtype=float)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "a": self.a, "b": self.b, "n_samples": self.n_samples}

    @classmethod
    def fit(cls, p: np.ndarray, y: np.ndarray) -> BetaCalibrator:
        raw = np.asarray(_logit(p), dtype=float)
        labels = np.asarray(y, dtype=float)
        a, b = 1.0, 0.0
        n = float(labels.size) or 1.0
        for _ in range(600):
            q = np.asarray(_expit(a * raw + b), dtype=float)
            residual = labels - q
            a += 0.5 * float(np.dot(residual, raw)) / n
            b += 0.5 * float(np.sum(residual)) / n
            # A non-positive slope would invert the ordering: a higher raw
            # probability would map to a lower calibrated one. Floored rather
            # than allowed, because monotonicity is worth more than fit.
            a = max(a, 0.05)
        return cls(a=float(a), b=float(b), n_samples=int(labels.size))


@dataclass(frozen=True)
class IsotonicCalibrator:
    """Non-parametric, then smoothed by interpolation.

    Isotonic regression finds the best non-decreasing fit, which is maximally
    flexible and maximally prone to overfitting on small samples. Two mitigations:
    it is only chosen when there are plenty of outcomes, and its step function is
    interpolated between block midpoints so the output is continuous and strictly
    increasing rather than a staircase.
    """

    x: tuple[float, ...]
    y: tuple[float, ...]
    n_samples: int = 0

    @property
    def name(self) -> str:
        return "isotonic"

    def transform(self, p: float) -> float:
        return float(self.transform_array(np.asarray([p], dtype=float))[0])

    def transform_array(self, p: np.ndarray) -> np.ndarray:
        xs = np.asarray(self.x, dtype=float)
        ys = np.asarray(self.y, dtype=float)
        clamped = np.asarray(_clamp(p), dtype=float)
        interpolated = np.interp(clamped, xs, ys)
        # A tiny slope in the raw probability is retained so that two different
        # inputs never map to exactly the same output. Without it, every target
        # in a flat region would show the same probability and the product would
        # look broken to anyone dragging a target price around.
        blended = 0.995 * interpolated + 0.005 * clamped
        return np.asarray(_clamp(blended), dtype=float)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "x": list(self.x),
            "y": list(self.y),
            "n_samples": self.n_samples,
        }

    @classmethod
    def fit(cls, p: np.ndarray, y: np.ndarray) -> IsotonicCalibrator:
        from sklearn.isotonic import IsotonicRegression

        model = IsotonicRegression(out_of_bounds="clip", y_min=PROB_FLOOR, y_max=1.0 - PROB_FLOOR)
        order = np.argsort(p)
        xs = np.asarray(p, dtype=float)[order]
        ys = model.fit_transform(xs, np.asarray(y, dtype=float)[order])
        # Thinned to at most 256 knots: enough to capture any real shape, small
        # enough that the artifact stays readable.
        if xs.size > 256:
            picks = np.linspace(0, xs.size - 1, 256).astype(int)
            xs, ys = xs[picks], ys[picks]
        unique_x, index = np.unique(xs, return_index=True)
        return cls(
            x=tuple(float(v) for v in unique_x),
            y=tuple(float(v) for v in ys[index]),
            n_samples=int(np.asarray(y).size),
        )


def load_calibrator(payload: dict[str, Any] | None) -> Calibrator:
    if not payload:
        return IdentityCalibrator()
    name = payload.get("name")
    if name == "temperature":
        return TemperatureCalibrator(
            temperature=float(payload["temperature"]), n_samples=int(payload.get("n_samples", 0))
        )
    if name == "beta":
        return BetaCalibrator(
            a=float(payload["a"]), b=float(payload["b"]), n_samples=int(payload.get("n_samples", 0))
        )
    if name == "isotonic":
        return IsotonicCalibrator(
            x=tuple(payload["x"]), y=tuple(payload["y"]), n_samples=int(payload.get("n_samples", 0))
        )
    return IdentityCalibrator(reason=str(payload.get("reason", "unknown calibrator")))


@dataclass
class CalibrationChoice:
    """Which calibrator won, and the evidence for choosing it."""

    calibrator: Calibrator
    candidates: dict[str, float]
    """Log loss for each candidate, including the identity."""
    chosen_reason: str
    n_samples: int


def fit_best_calibrator(
    p: Sequence[float],
    y: Sequence[bool | int],
    *,
    min_samples: int = MIN_CALIBRATION_SAMPLES,
    holdout_fraction: float = 0.3,
) -> CalibrationChoice:
    """Choose a calibrator by out-of-sample log loss, identity included.

    The identity is a real candidate and often wins. A calibrator is only worth
    applying if it beats doing nothing on data it was not fitted on, and
    "uncalibrated because calibration did not help" is a legitimate — and
    honest — result.

    The split is chronological, on the assumption the inputs are in time order,
    because a random split would let adjacent overlapping outcomes appear on both
    sides and make every calibrator look excellent.
    """
    probs = np.asarray(p, dtype=float)
    labels = np.asarray(y, dtype=float)
    if probs.size < min_samples:
        return CalibrationChoice(
            calibrator=IdentityCalibrator(
                reason=f"only {probs.size} resolved outcomes; {min_samples} needed"
            ),
            candidates={},
            chosen_reason=f"too few outcomes ({probs.size} < {min_samples})",
            n_samples=int(probs.size),
        )

    split = int(probs.size * (1.0 - holdout_fraction))
    fit_p, fit_y = probs[:split], labels[:split]
    test_p, test_y = probs[split:], labels[split:]

    def loss(values: np.ndarray) -> float:
        q = np.clip(values, 1e-9, 1.0 - 1e-9)
        return float(-np.mean(test_y * np.log(q) + (1.0 - test_y) * np.log(1.0 - q)))

    candidates: dict[str, tuple[Calibrator, float]] = {
        "identity": (
            IdentityCalibrator(reason="calibration did not improve log loss"),
            loss(test_p),
        )
    }
    for builder in (TemperatureCalibrator, BetaCalibrator, IsotonicCalibrator):
        try:
            calibrator = builder.fit(fit_p, fit_y)
            candidates[calibrator.name] = (calibrator, loss(calibrator.transform_array(test_p)))
        except Exception:
            continue

    best_name = min(candidates, key=lambda k: candidates[k][1])
    best, best_loss = candidates[best_name]
    identity_loss = candidates["identity"][1]
    # A calibrator has to earn its place by a visible margin, not by a rounding
    # difference that will not survive the next thousand outcomes.
    if best_name != "identity" and best_loss > identity_loss - 1e-4:
        best = candidates["identity"][0]
        best_name = "identity"

    return CalibrationChoice(
        calibrator=best,
        candidates={name: value for name, (_, value) in candidates.items()},
        chosen_reason=f"lowest held-out log loss of {len(candidates)} candidates",
        n_samples=int(probs.size),
    )
