"""The forecast engine: from a market window and a target price to an answer.

This is where every layer meets, and where the quarantine rule is enforced. It
does the following, in order, for one request:

1. Check the feed is healthy enough to answer at all.
2. Build features from the window, using the one shared feature function.
3. Ask the baseline for a distribution.
4. Apply a learned correction — but only if the model is allowed to serve.
5. Apply the calibrator.
6. Fold the adjusted probability back into the distribution, so the range and
   the median stay consistent with the number shown.
7. Assess confidence, which changes the label and never the number.
8. Explain which signals moved the answer.

**The quarantine.** A model trained on simulated data may not serve a live
forecast. Not by convention — the check is here, it is on by default, and
overriding it requires setting an environment variable whose name says what it
does. The reason is simple: a simulator-trained model produces confident numbers
that describe a piece of software rather than a market, and nothing in the output
would look wrong.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

from forecaster.calibration import Calibrator, IdentityCalibrator
from forecaster.confidence.assess import assess_confidence
from forecaster.config import Config
from forecaster.features.compute import MISSING, compute_features
from forecaster.features.registry import REGISTRY
from forecaster.features.window import MarketWindow
from forecaster.models.base import ForecastDistribution, InsufficientData
from forecaster.models.baseline import MIN_HISTORY_NS, BaselineModel
from forecaster.models.registry import ModelArtifact
from forecaster.types import (
    NS_PER_SECOND,
    DataSource,
    Forecast,
    PredictionMode,
    ServiceLevel,
    SignalContribution,
)


class ForecastRefused(Exception):
    """The system will not answer, and says why.

    A refusal is a feature. The alternative — a plausible number derived from a
    stale feed or ninety seconds of history — is worse in every way that matters,
    because nothing about it looks wrong.
    """


@dataclass
class EngineDecision:
    """Which model served, and why the others did not."""

    model_version: str
    used_learner: bool
    quarantine_reason: str | None
    baseline_p: float
    learner_p: float | None
    calibrated_p: float
    calibrator_name: str


class ForecastEngine:
    """Produces forecasts. One instance per process."""

    def __init__(
        self,
        *,
        config: Config,
        baseline: BaselineModel | None = None,
        artifacts: dict[tuple[str, int], ModelArtifact] | None = None,
    ) -> None:
        self.config = config
        self.baseline = baseline or BaselineModel(config=config.model)
        self.artifacts = artifacts or {}

    def artifact_for(self, symbol: str, horizon_s: int) -> ModelArtifact | None:
        return self.artifacts.get((symbol, horizon_s))

    def register(self, artifact: ModelArtifact) -> None:
        self.artifacts[(artifact.symbol, artifact.horizon_s)] = artifact

    # -- the quarantine rule -------------------------------------------------

    def _learner_allowed(
        self, artifact: ModelArtifact | None, data_source: DataSource
    ) -> tuple[bool, str | None]:
        """May a learned model serve this forecast?"""
        if artifact is None or not artifact.has_learner:
            return False, None
        if artifact.train_data_source is DataSource.LIVE:
            return True, None
        if data_source is not DataSource.LIVE:
            # Simulated data, simulated model: internally consistent, and clearly
            # labelled as simulated everywhere it surfaces.
            return True, None
        if self.config.allow_ml_live:
            return True, (
                f"model was trained on {artifact.train_data_source.value} data and is serving "
                "a live feed because FORECASTER_ALLOW_ML_LIVE is set"
            )
        return False, (
            f"model was trained on {artifact.train_data_source.value} data, so it is "
            "quarantined from live forecasts; the baseline is answering instead"
        )

    # -- the forecast --------------------------------------------------------

    def forecast(
        self,
        *,
        window: MarketWindow,
        target: float,
        horizon_s: int,
        service_level: ServiceLevel,
        feed_age_ns: int | None,
        now_ns: int,
        prediction_mode: PredictionMode = PredictionMode.LIVE,
    ) -> Forecast:
        if target <= 0.0:
            raise ForecastRefused("target price must be positive")
        if service_level in (ServiceLevel.STALE, ServiceLevel.DOWN):
            raise ForecastRefused(
                "market data feed is not healthy enough to forecast from; "
                "the system refuses rather than guessing"
            )
        if window.history_ns < MIN_HISTORY_NS:
            raise ForecastRefused(
                f"only {window.history_ns / NS_PER_SECOND / 60:.0f} minutes of market history "
                f"are available; {MIN_HISTORY_NS / NS_PER_SECOND / 60:.0f} are needed to "
                "estimate volatility"
            )

        artifact = self.artifact_for(window.symbol, horizon_s)
        baseline = artifact.baseline if artifact else self.baseline

        features = compute_features(window, validate=False)
        try:
            distribution = baseline.predict_distribution(window, horizon_s, features)
        except InsufficientData as exc:
            raise ForecastRefused(str(exc)) from exc

        z = distribution.z_for(target)
        baseline_p = distribution.prob_above(target)

        allowed, _quarantine_reason = self._learner_allowed(artifact, window.data_source)
        learner_p: float | None = None
        model_version = baseline.version

        if allowed and artifact is not None:
            feature_row = [features.values[name] for name in artifact.feature_names]
            # Beyond the calibrated range the learner is extrapolating from a
            # region where the calibration set had almost no events. The
            # parametric baseline answers there instead, and confidence is forced
            # to LOW with an explicit reason.
            if abs(z) <= artifact.z_calibrated_max:
                if artifact.gbm is not None and artifact.gbm.is_fitted:
                    learner_p = artifact.gbm.adjust(baseline_p, feature_row, z)
                elif artifact.logistic is not None and artifact.logistic.is_fitted:
                    learner_p = artifact.logistic.adjust(baseline_p, feature_row, z)
                if learner_p is not None:
                    model_version = (
                        artifact.gbm.version
                        if artifact.gbm and artifact.gbm.is_fitted
                        else artifact.logistic.version  # type: ignore[union-attr]
                    )

        raw_p = learner_p if learner_p is not None else baseline_p
        calibrator: Calibrator = (
            artifact.calibrator if artifact and artifact.calibrator else IdentityCalibrator()
        )
        calibrated_p = calibrator.transform(raw_p)

        # The probability, the median and the range all come off one distribution
        # after this. Without it the product could show a 70% chance of finishing
        # above a price its own predicted range excludes.
        final = distribution.with_probability(calibrated_p, target)
        low, high = final.interval(self.config.model.display_range_confidence)

        assessment = assess_confidence(
            features=features,
            config=self.config.confidence,
            service_level=service_level,
            z=z,
            z_calibrated_max=artifact.z_calibrated_max
            if artifact
            else self.config.model.z_calibrated_max,
            feed_age_ns=feed_age_ns,
            novelty_model=artifact.novelty if artifact else None,
            baseline_p=baseline_p,
            model_p=learner_p,
            is_calibrated=bool(artifact and artifact.is_calibrated),
            history_ns=window.history_ns,
            min_history_ns=MIN_HISTORY_NS,
        )

        contributions = self._explain(
            features=features,
            z=z,
            baseline_p=baseline_p,
            final_p=calibrated_p,
            distribution=final,
            artifact=artifact,
        )

        return Forecast(
            as_of_ns=window.as_of_ns,
            eval_at_ns=window.as_of_ns + horizon_s * NS_PER_SECOND,
            horizon_s=horizon_s,
            symbol=window.symbol,
            venue=window.venue,
            spot=distribution.spot,
            target=target,
            p_above=calibrated_p,
            z=z,
            sigma=distribution.sigma,
            range_low=low,
            range_high=high,
            range_confidence=self.config.model.display_range_confidence,
            median=final.median(),
            confidence=assessment.level,
            confidence_reasons=assessment.reasons + assessment.warnings,
            service_level=service_level,
            model_version=model_version,
            model_train_source=(
                artifact.train_data_source
                if artifact
                else (baseline.train_source or DataSource.SIMULATED)
            ),
            calibration_source=artifact.calibration_source if artifact else None,
            data_source=window.data_source,
            prediction_mode=prediction_mode,
            features=features,
            contributions=contributions,
        )

    def baseline_probability(self, window: MarketWindow, horizon_s: int, target: float) -> float:
        """The baseline's answer, ignoring any learner.

        The reference every claim of skill is measured against. Exposed so the
        backtester compares a learner against the volatility model rather than
        against a coin flip, which would flatter it enormously.
        """
        artifact = self.artifact_for(window.symbol, horizon_s)
        baseline = artifact.baseline if artifact else self.baseline
        return baseline.predict_distribution(window, horizon_s).prob_above(target)

    # -- explanation ---------------------------------------------------------

    def _explain(
        self,
        *,
        features: Any,
        z: float,
        baseline_p: float,
        final_p: float,
        distribution: ForecastDistribution,
        artifact: ModelArtifact | None,
    ) -> tuple[SignalContribution, ...]:
        """Which signals moved the answer, in the order they mattered.

        The first entry is always the distance to the target, because it is
        genuinely the dominant term and pretending otherwise would misrepresent
        how the forecast works. A user who believes the model has an opinion
        about direction, when nearly all of the number comes from how far away
        their target is, has been misled by the explanation rather than informed
        by it.
        """
        out: list[SignalContribution] = []

        distance_direction: Literal["above", "below", "neutral"] = (
            "below" if z > 0 else "above" if z < 0 else "neutral"
        )
        out.append(
            SignalContribution(
                name="target_distance",
                label="Distance to target",
                direction=distance_direction,
                weight=1.0,
                detail=(
                    f"target is {abs(z):.2f} standard deviations "
                    f"{'above' if z > 0 else 'below'} the current price — this is the "
                    "dominant term in the forecast"
                ),
            )
        )

        annual_vol = distribution.sigma * math.sqrt(
            (365.0 * 24.0 * 3600.0) / distribution.horizon_s
        )
        out.append(
            SignalContribution(
                name="volatility",
                label="Volatility regime",
                direction="neutral",
                weight=0.85,
                detail=(
                    f"{annual_vol * 100:.0f}% annualised, so a typical "
                    f"{distribution.horizon_s // 60}-minute move is about "
                    f"${distribution.spot * distribution.sigma:,.0f} "
                    f"({distribution.sigma * 100:.2f}%)"
                ),
            )
        )

        shift = final_p - baseline_p
        if abs(shift) > 0.005 and artifact is not None:
            source = "learned correction"
            details: list[str] = []
            if artifact.gbm is not None and artifact.gbm.is_fitted:
                for name, importance in artifact.gbm.importances()[:3]:
                    if name == "z":
                        continue
                    spec = REGISTRY.get(name)
                    value = features.values.get(name, MISSING)
                    if value == MISSING or spec is None:
                        continue
                    details.append(f"{_pretty(name)} ({importance:.0%} of model weight)")
            out.append(
                SignalContribution(
                    name="model_adjustment",
                    label=f"Model adjustment ({source})",
                    direction="above" if shift > 0 else "below",
                    weight=min(1.0, abs(shift) * 8.0),
                    detail=(
                        f"moved the probability {shift:+.1%} from the volatility baseline"
                        + (f"; driven by {', '.join(details)}" if details else "")
                    ),
                )
            )

        signals: tuple[tuple[str, Literal["above", "neutral"], str], ...] = (
            ("signed_flow_5m", "above", "Order flow"),
            ("book_imbalance_top5", "above", "Order-book imbalance"),
            ("rv_ratio_1m_60m", "neutral", "Volatility trend"),
            ("rel_volume_5m", "neutral", "Trading activity"),
        )
        for name, direction_when_positive, label in signals:
            value = features.values.get(name, MISSING)
            if value == MISSING:
                continue
            out.append(
                SignalContribution(
                    name=name,
                    label=label,
                    direction=(
                        direction_when_positive
                        if direction_when_positive == "neutral"
                        else ("above" if value > 0 else "below")
                    ),
                    weight=min(1.0, abs(value)),
                    detail=_describe(name, value),
                )
            )

        return tuple(sorted(out, key=lambda c: -c.weight)[:6])


def _pretty(name: str) -> str:
    return name.replace("_", " ")


def _describe(name: str, value: float) -> str:
    if name == "signed_flow_5m":
        side = "buying" if value > 0 else "selling"
        return f"aggressive {side} is {abs(value):.0%} of net flow over 5 minutes"
    if name == "book_imbalance_top5":
        side = "bid" if value > 0 else "ask"
        return f"{abs(value):.0%} more size on the {side} side of the book"
    if name == "rv_ratio_1m_60m":
        state = "expanding" if value > 0.2 else "contracting" if value < -0.2 else "steady"
        return f"short-term volatility is {state} against the hourly level"
    if name == "rel_volume_5m":
        return f"volume is running at {value:.1f}x the recent norm"
    return f"{_pretty(name)} = {value:.3f}"
