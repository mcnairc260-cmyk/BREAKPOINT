# VALIDATION.md — how forecast quality is measured, and what has been shown

> ## NO REAL-MARKET VALIDATION HAS BEEN PERFORMED
>
> Every result in this repository was produced on **simulated or replayed** data.
> The environment this system was built in cannot reach any exchange: Binance,
> Coinbase, Kraken, Bitstamp, Gemini, OKX, Bybit, Bitfinex, CoinGecko, CoinCap,
> CryptoCompare, Finnhub, AlphaVantage and Yahoo Finance are all blocked by
> network policy, and WebSocket upgrades are unsupported through its proxy.
>
> That means the results here show the **pipeline is correct**. They are not
> evidence about real markets, and none of them should be quoted as if they were.
> This banner stays until real outcomes exist.

---

## 1. What is measured, and why accuracy is last

**Brier score** — the mean squared error of the probability. It is *proper*: a
forecaster cannot improve it by stating something other than what it believes.
This is the headline number.

**Brier skill score** — the Brier score relative to a reference. This, not the raw
score, is what means anything. A raw Brier of 0.01 sounds superb and is trivially
achieved by always saying "1%" for a target three standard deviations away. Every
learner is measured against the **volatility baseline**, never against a coin
flip, because beating a coin flip is not an achievement here.

**Expected calibration error (ECE)** — the average gap between what was promised
and what happened, across probability buckets. When the system says 70%, does it
happen 70% of the time?

**Murphy decomposition** — splits the Brier score into three parts:
- *reliability*: are the probabilities honest (lower is better),
- *resolution*: do they vary usefully (higher is better),
- *uncertainty*: how hard the question was (a property of the data, not the model).

This is how you catch a model whose good score comes entirely from the questions
being easy — the normal situation when most sampled targets are far from the
current price.

**Log loss** — punishes confident mistakes far harder than the Brier score does.

**Accuracy** — reported because the brief asks for it, and reported last. A
forecaster that says 55% and is right 55% of the time is working perfectly, and
accuracy makes that look mediocre.

**Poisson tail tests** — for far-out targets, squared-error metrics say nothing:
every prediction is near zero and almost every outcome is negative. The honest
question there is "we expected 12.3 of these and saw 19 — is that surprising?",
which is a counting question.

---

## 2. Preventing look-ahead and leakage

This is the section that decides whether any other number in this document is
worth reading. Leakage does not announce itself: a leaking model does not crash,
it simply performs better, which is what everyone involved wants to believe.

### 2.1 The window is the checkpoint

Every feature reads a `MarketWindow`, which is built with an explicit cutoff and
**physically excludes** anything after it. A feature cannot look ahead because
the data is not there — not because the author remembered.

`MarketWindow.validate_causality()` runs on every feature computation and raises
if anything in the window postdates the cutoff.

The cutoff is **receipt time**, not exchange time. Information that had not
arrived yet was not available, whatever the venue's clock says. Both timestamps
are stored on every event; outcomes resolve on exchange time, feature windows
close on receipt time.

### 2.2 Declared lookbacks, checked

Every feature declares how far back it reads. `assert_causal` recomputes each one
on a window truncated to that declaration and requires the answer to be
unchanged. A feature reading more history than it admits fails the build.

`tests/test_leakage.py` registers a deliberately leaking feature and asserts the
check catches it — so the detector itself is tested, not just trusted.

### 2.3 Overlapping labels: purge and embargo

A 20-minute label sampled every second overlaps its neighbour by 1199/1200. A
training row immediately before a validation boundary has an outcome extending
*into* the validation period, so the model is fitted on the answer it is about to
be tested on.

- **Purge**: a training row is only used if its *outcome* also lands before the
  boundary — not merely its features. This is checked in
  `Fold.contains_train`, and tested.
- **Embargo**: a further full horizon of gap, because features are serially
  correlated across that span too.

Splits are **chronological only**. Nothing is ever shuffled.

### 2.4 Several targets per instant are one observation

Several target prices are sampled at each instant. They all resolve from a single
realised price, so they are **one** piece of evidence dressed as many.

- They never split across folds.
- They are weighted by 1/(rows at that instant) during training, so an instant
  that happened to generate fourteen samples does not outvote one that generated
  four.
- They collapse to one in every sample-size count.

### 2.5 Everything is refit inside each fold

The residual shape, the seasonal factors, the scalers, the calibrator — all of it
is fitted inside the training fold, never once on the full dataset. Global
preprocessing is the most common real leak in practice, and it is invisible in
the results because it simply makes the model look better.

---

## 3. Sample size: the number every claim is judged against

Row counts overstate the evidence enormously. One day of one-second sampling
gives:

| Horizon | Rows/day (14 targets each) | Distinct instants | **Independent observations** |
|---|---|---|---|
| 5 min | ~1,200,000 | 86,400 | **288** |
| 20 min | ~1,200,000 | 86,400 | **72** |

Four numbers are reported, never one:

- `n_rows` — the largest and least meaningful.
- `n_timestamps` — distinct instants.
- `n_non_overlapping` — instants at least one horizon apart. **This is the number
  any claim should be judged against.**
- `n_days` — because regimes matter more than rows.

A single figure called "effective sample size" is deliberately *not* published,
because it invites the reader to plug it into a formula that assumes
independence, and the whole point is that these observations are not independent
in several ways at once.

### What this implies for the schedule

- **~7 days** of continuous collection before a 5-minute learner has ~2,000
  independent observations.
- **~28 days** before a 20-minute learner does.

The system therefore ships baseline-only and says so, rather than training a
learner on data that cannot support one. The threshold — 750 independent
observations — is enforced in code and was fixed before any result was seen.

---

## 4. Confidence intervals that account for dependence

An ordinary bootstrap resamples rows, which for overlapping labels produces
intervals far too narrow and declares differences significant that are not.

A **stationary block bootstrap** resamples contiguous blocks (length ≥ 3
horizons), preserving the correlation inside each block.

**Variance inflation** is reported alongside: the ratio of the honest variance to
the naive one. On a measured autocorrelated series in the test suite it comes out
at roughly 180×, meaning an ordinary interval would have been about 13× too
narrow. That number is published because it makes the overlap problem legible.

Model comparisons use a **paired** block bootstrap on the per-instant difference
in Brier score. Paired is both correct and much tighter — both models saw exactly
the same markets, and treating their scores as independent throws that away.

---

## 5. Promotion: when a new model replaces the current one

A candidate replaces the incumbent only if **all** of the following hold:

1. The 95% interval on the improvement in Brier score **excludes zero**.
2. The improvement exceeds **0.002**, a minimum practical effect fixed before any
   result was seen.
3. Calibration error is **no worse**.

Otherwise the candidate is recorded, the decision and its evidence are written to
`promotion_decisions`, and the incumbent stays. **Newer never means better.**

Models trained on simulated data are registered as `quarantined` and cannot serve
a live forecast at all unless `FORECASTER_ALLOW_ML_LIVE` is deliberately set — and
even then the warning still reaches the interface.

---

## 6. The two gates that catch a broken harness

### 6.1 The null-alpha gate

Run the whole pipeline on the simulator's `martingale` regime: zero drift, no
predictable structure whatsoever. **Any learner that beats the baseline there has
leaked**, and the build fails.

This is a stronger check than a deliberately future-peeking feature. A blatant
leak is easy to catch. A subtle one — a preprocessing step fitted globally, a
grouping bug, a boundary off by one — shows up only as "the model beats the
baseline on data where beating it is impossible".

### 6.2 The known-answer check

In the simulator's `gbm` regime the true probability is available analytically.
The baseline's answer is compared against arithmetic rather than against itself.

---

## 7. What the simulator can and cannot establish

The simulator carries a lot of weight here, so its limits are stated plainly.

**Ways a simulator flatters a forecasting system**

1. The generating process sits inside the model's assumptions — the baseline
   assumes stochastic volatility with fat tails, and that is what the simulator
   produces. Calibration will look better here than it ever will live.
2. It is stationary. Real crypto is not, so purge-and-embargo looks unnecessary
   on data that never changes regime.
3. Sample size is free, so every confidence interval shrinks and every model
   looks significantly better than every other.
4. Whatever predictability is coded in gets discovered.

**The structural defences**

- The `realistic` regime contains **no directional predictability at all**. Drift
  is exactly zero and order flow carries no information about the next price
  move — because that is the honest position for real markets too. Volatility is
  forecastable, which is real and is the actual source of the product's
  probabilities.
- Hyperparameter search on simulated data is **refused in code**, not discouraged
  in a comment. `GradientBoostedCorrection.fit(tune=True)` raises `TuningRefused`
  when the data source is simulated.
- Every artifact trained on simulated data carries `.sim.` in its version string,
  is registered `quarantined`, and its model card opens with a warning.
- Simulated and live metrics are **never** aggregated together.

**What sim-only validation supports**

- The pipeline recovers known probabilities to a stated tolerance.
- The harness does not leak (skill ≈ 0 on a martingale).
- The system runs end to end and degrades correctly on bad data.
- Served output satisfies its coherence guarantees on every input tested.

**What it does not support, at all**

- Any statement about accuracy, calibration, feature usefulness, model ranking or
  confidence thresholds **in real markets**.

---

## 8. Void outcomes are a selection bias, not a neutral exclusion

A forecast whose expiry has no defensible price nearby resolves as VOID.

This is not neutral. Feeds drop when markets move, so voided forecasts are
disproportionately the volatile ones, and quietly excluding them flatters
accuracy exactly where it should not. So the system reports:

- the void rate,
- accuracy assuming **every** void was wrong,
- accuracy assuming **every** void was right.

The truth is between those bounds, and showing both is the honest way to say so.

---

## 9. How to reproduce every result

```bash
cd forecaster/engine
make verify            # the full offline suite
forecaster simulate --duration 288000 --regime realistic --anchor-now
forecaster train --data-source simulated --venue simulator
forecaster backtest --data-source simulated --venue simulator --json report.json
forecaster report --data-source simulated
```

Everything is seeded. The same seed produces the same market, the same training
data and the same numbers.

---

## 10. The honest summary

The measurement machinery is built and tested: leakage controls work, calibration
is measurable, the metrics distinguish a calibrated forecaster from an
overconfident one, and confidence intervals account for dependence.

**No claim of predictive edge in real markets is made, because no evidence for
one exists.** The next step is not a better model. It is a week of real data.
