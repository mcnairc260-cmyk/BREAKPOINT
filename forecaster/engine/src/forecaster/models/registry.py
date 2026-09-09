"""Model artifacts: everything needed to reproduce a forecast.

A model that cannot be reproduced cannot be audited, and a forecasting system
whose history cannot be audited is asking to be believed rather than checked. So
an artifact carries not just the fitted parameters but the whole context: which
data trained it, over what period, how much genuinely independent evidence that
amounted to, which features, which calibrator, and what it scored.

`train_data_source` and `calibration_source` are separate fields on purpose. A
model trained on the simulator and calibrated on live outcomes is a different
thing from one trained and calibrated live, and collapsing them into one column
is exactly how a simulated result gets reported as a real one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from forecaster.calibration import Calibrator, load_calibrator
from forecaster.confidence.assess import NoveltyModel
from forecaster.features.compute import FEATURE_NAMES, FEATURE_SET_VERSION
from forecaster.models.baseline import BaselineModel
from forecaster.models.ml import GradientBoostedCorrection, LogisticCorrection
from forecaster.models.tails import ResidualShape
from forecaster.types import DataSource

ARTIFACT_VERSION = 1


@dataclass
class ModelArtifact:
    """A trained, versioned, reproducible forecaster."""

    version: str
    family: str
    symbol: str
    horizon_s: int
    trained_ns: int
    train_start_ns: int
    train_end_ns: int
    train_data_source: DataSource
    baseline: BaselineModel
    logistic: LogisticCorrection | None = None
    gbm: GradientBoostedCorrection | None = None
    calibrator: Calibrator | None = None
    calibration_source: DataSource | None = None
    novelty: NoveltyModel | None = None
    feature_names: tuple[str, ...] = FEATURE_NAMES
    feature_set_version: str = FEATURE_SET_VERSION
    sample_size: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    z_calibrated_max: float = 3.0
    git_sha: str | None = None
    notes: str = ""

    @property
    def is_simulated(self) -> bool:
        return self.train_data_source is DataSource.SIMULATED

    @property
    def has_learner(self) -> bool:
        return (self.gbm is not None and self.gbm.is_fitted) or (
            self.logistic is not None and self.logistic.is_fitted
        )

    @property
    def is_calibrated(self) -> bool:
        return self.calibrator is not None and self.calibrator.name != "identity"

    def describe(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "family": self.family,
            "symbol": self.symbol,
            "horizon_s": self.horizon_s,
            "trained_ns": self.trained_ns,
            "train_data_source": self.train_data_source.value,
            "calibration_source": self.calibration_source.value
            if self.calibration_source
            else None,
            "calibrator": self.calibrator.name if self.calibrator else "identity",
            "residual_shape": self.baseline.shape.source,
            "seasonality_fitted": self.baseline.seasonality.is_fitted,
            "has_learner": self.has_learner,
            "feature_set_version": self.feature_set_version,
            "sample_size": self.sample_size,
            "z_calibrated_max": self.z_calibrated_max,
            "git_sha": self.git_sha,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_version": ARTIFACT_VERSION,
            "version": self.version,
            "family": self.family,
            "symbol": self.symbol,
            "horizon_s": self.horizon_s,
            "trained_ns": self.trained_ns,
            "train_start_ns": self.train_start_ns,
            "train_end_ns": self.train_end_ns,
            "train_data_source": self.train_data_source.value,
            "calibration_source": self.calibration_source.value
            if self.calibration_source
            else None,
            "baseline": {
                "shape": self.baseline.shape.to_dict(),
                "seasonality": self.baseline.seasonality.to_dict(),
                "version_suffix": self.baseline.version_suffix,
            },
            "logistic": self.logistic.to_dict() if self.logistic else None,
            "gbm": self.gbm.to_dict() if self.gbm else None,
            "calibrator": self.calibrator.to_dict() if self.calibrator else None,
            "novelty": self.novelty.to_dict() if self.novelty else None,
            "feature_names": list(self.feature_names),
            "feature_set_version": self.feature_set_version,
            "sample_size": self.sample_size,
            "metrics": self.metrics,
            "z_calibrated_max": self.z_calibrated_max,
            "git_sha": self.git_sha,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ModelArtifact:
        from forecaster.features.seasonality import WeeklySeasonality

        baseline_payload = payload.get("baseline", {})
        baseline = BaselineModel()
        baseline.shape = ResidualShape.from_dict(baseline_payload.get("shape", {}))
        baseline.seasonality = WeeklySeasonality.from_dict(baseline_payload.get("seasonality", {}))
        baseline.version_suffix = str(baseline_payload.get("version_suffix", "untrained"))
        train_source = DataSource(payload["train_data_source"])
        baseline.train_data_source = train_source
        baseline.trained_ns = payload.get("trained_ns")

        calibration_source = payload.get("calibration_source")
        return cls(
            version=str(payload["version"]),
            family=str(payload["family"]),
            symbol=str(payload["symbol"]),
            horizon_s=int(payload["horizon_s"]),
            trained_ns=int(payload["trained_ns"]),
            train_start_ns=int(payload["train_start_ns"]),
            train_end_ns=int(payload["train_end_ns"]),
            train_data_source=train_source,
            baseline=baseline,
            logistic=LogisticCorrection.from_dict(payload["logistic"])
            if payload.get("logistic")
            else None,
            gbm=GradientBoostedCorrection.from_dict(payload["gbm"]) if payload.get("gbm") else None,
            calibrator=load_calibrator(payload.get("calibrator")),
            calibration_source=DataSource(calibration_source) if calibration_source else None,
            novelty=NoveltyModel.from_dict(payload["novelty"]) if payload.get("novelty") else None,
            feature_names=tuple(payload.get("feature_names", FEATURE_NAMES)),
            feature_set_version=str(payload.get("feature_set_version", FEATURE_SET_VERSION)),
            sample_size=dict(payload.get("sample_size", {})),
            metrics=dict(payload.get("metrics", {})),
            z_calibrated_max=float(payload.get("z_calibrated_max", 3.0)),
            git_sha=payload.get("git_sha"),
            notes=str(payload.get("notes", "")),
        )


def save_artifact(artifact: ModelArtifact, directory: str | Path) -> Path:
    """Write the artifact and a human-readable model card beside it.

    The card exists so that a reviewer can answer "what is this thing and should
    I believe it" without loading any code. It is where the simulated-data
    warning lives in plain words.
    """
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    artifact_path = path / f"{artifact.version.replace('/', '_')}.json"
    artifact_path.write_text(json.dumps(artifact.to_dict(), indent=2), encoding="utf-8")
    (path / f"{artifact.version.replace('/', '_')}.card.md").write_text(
        _model_card(artifact), encoding="utf-8"
    )
    return artifact_path


def load_artifact(path: str | Path) -> ModelArtifact:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("artifact_version") != ARTIFACT_VERSION:
        raise ValueError(
            f"artifact version {payload.get('artifact_version')} is not {ARTIFACT_VERSION}; "
            "retrain rather than loading a model whose meaning may have changed"
        )
    return ModelArtifact.from_dict(payload)


def _source_name(source: DataSource | None) -> str:
    return source.value if source else "not calibrated"


def _residuals(artifact: ModelArtifact) -> str:
    return f"{artifact.baseline.shape.n_residuals:,} residuals"


def _count(size: dict[str, Any], key: str) -> str:
    """Format a count, tolerating a missing one.

    Model cards are written even when training was cut short, and a card that
    crashes rather than saying "unknown" would lose the record of exactly the
    run worth investigating.
    """
    value = size.get(key)
    return f"{value:,}" if isinstance(value, int) else "unknown"


def _model_card(artifact: ModelArtifact) -> str:
    from forecaster.clock import iso

    warning = ""
    if artifact.is_simulated:
        warning = (
            "\n> **TRAINED ON SIMULATED DATA.** Every number below describes this model's\n"
            "> behaviour on a synthetic market produced by `marketdata/simulator.py`.\n"
            "> None of it is evidence about real markets. This model must not serve a\n"
            "> live forecast unless `FORECASTER_ALLOW_ML_LIVE` is deliberately set.\n"
        )

    size = artifact.sample_size
    return f"""# Model card — `{artifact.version}`
{warning}
| | |
|---|---|
| Family | `{artifact.family}` |
| Symbol | {artifact.symbol} |
| Horizon | {artifact.horizon_s}s |
| Trained | {iso(artifact.trained_ns)} |
| Training data | {iso(artifact.train_start_ns)} to {iso(artifact.train_end_ns)} |
| Training data source | **{artifact.train_data_source.value}** |
| Calibration source | {_source_name(artifact.calibration_source)} |
| Calibrator | {artifact.calibrator.name if artifact.calibrator else "identity"} |
| Residual shape | {artifact.baseline.shape.source} ({_residuals(artifact)}) |
| Seasonality fitted | {artifact.baseline.seasonality.is_fitted} |
| Feature set | `{artifact.feature_set_version}` ({len(artifact.feature_names)} features) |
| Git commit | `{artifact.git_sha or "unknown"}` |

## How much evidence is behind this

| Measure | Value |
|---|---|
| Rows | {_count(size, "n_rows")} |
| Distinct instants | {_count(size, "n_instants")} |
| **Non-overlapping observations** | **{_count(size, "n_non_overlapping")}** |
| Days of data | {size.get("n_days", "unknown")} |

The last two rows are the ones that matter. Rows overstate the evidence badly:
several target prices are sampled at each instant and all resolve from one
realised price, and consecutive instants share almost all of their outcome
window.

## Metrics

```json
{json.dumps(artifact.metrics, indent=2)}
```

## Notes

{artifact.notes or "None."}
"""
