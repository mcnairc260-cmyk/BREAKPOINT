# VALIDATION.md — how forecast quality is measured, and what has been shown

> ## NO REAL-MARKET VALIDATION HAS BEEN PERFORMED
>
> **No real BTC or ETH market data has been ingested. No live forecast has been
> made. No live forecast has been resolved.** Every number in this document was
> produced on **simulated, replayed or conformance** data.
>
> The environment this system was built in cannot reach any exchange. Re-verified
> at the start of the real-market validation phase: Coinbase, Kraken and Binance
> are each refused with `HTTP 403` at the egress proxy, on both the WebSocket and
> the REST transport. Bitstamp, Gemini, OKX, Bybit, Bitfinex, CoinGecko, CoinCap,
> CryptoCompare, Finnhub, AlphaVantage and Yahoo Finance were blocked too.
>
> That means the results here show the **pipeline is correct**. They are not
> evidence about real markets, and none of them should be quoted as if they were.
> This banner stays until real outcomes exist.
>
> **What did change:** the live data path is no longer only fixture-tested. The
> production adapter is now exercised over a real socket against a server
> speaking Coinbase's wire protocol, including reconnects, stale feeds, malformed
> frames and restarts — `make conformance`, 11/11. That proves the **client**. It
> proves nothing about the venue and nothing whatever about forecast accuracy.
>
> The gap is exactly one thing: network egress to an exchange, and **one command**
> closes it — `make live-proof`, about an hour, unattended. It ends in PROVEN,
> NOT LIVE or BLOCKED and exits zero only for PROVEN, so a run against anything
> that is not a venue can never be mistaken for a real-market result.
>
> That procedure has been run end to end at the **actual 300-second and
> 1200-second horizons** against a wire-protocol server: 504 forecasts, 204
> resolved with 0 void, both horizons scored, 0 monotonicity violations in 420
> adjacent target pairs, all 504 surviving a restart with 0 duplicate outcomes —
> and a verdict of NOT LIVE, because the endpoint was not an exchange. Against
> Coinbase itself the same command reports BLOCKED with the 403.
>
> See **[LIVE_VALIDATION.md](LIVE_VALIDATION.md)** for the full output, for the
> three defects found in code that was already shipping, and for what remains.

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
cd forecaster
make verify     # lint, types, 132 tests, the offline suite, the web build
make demo       # simulate 80h -> train -> backtest, about 45 minutes
```

Or step by step, from `forecaster/engine`, using the project's interpreter:

```bash
.venv/bin/forecaster simulate --duration 288000 --regime realistic --anchor-now
.venv/bin/forecaster train    --data-source simulated --venue simulator
.venv/bin/forecaster backtest --data-source simulated --venue simulator \
    --json ../reports/backtest.json
.venv/bin/forecaster report   --data-source simulated
```

Everything is seeded. The same seed produces the same market, the same training
data and the same numbers.

---

## 10. What was actually measured

All on the simulator's `realistic` regime: 80 hours of BTC-USD and ETH-USD,
2,925,891 trades, seed 4242. **These numbers say the pipeline works. They say
nothing about real markets.**

### The volatility baseline

| Horizon | Independent observations | Brier | Calibration error (ECE) |
|---|---|---|---|
| 5 min | 947 | 0.13529 | 0.00441 |
| 20 min | 236 | 0.12640 | 0.00012 |

A calibration error of 0.004 means that when the baseline said 70%, it happened
about 70.4% of the time. That is very good — and it is exactly what should
happen, because the simulator's returns are generated by a stochastic-volatility
process and the baseline assumes stochastic volatility. Live data will be worse.
The number is reported to show the machinery works, not to claim skill.

### The learner: trained, and correctly rejected

At the 5-minute horizon there were 947 independent observations, past the
threshold of 750, so a gradient-boosted correction was trained and evaluated
under walk-forward validation with purge and embargo.

| | Brier | ECE |
|---|---|---|
| Baseline | 0.13529 | 0.00441 |
| Learner | 0.13950 | 0.01902 |

Paired block bootstrap on the difference: **−0.00421, 95% interval −0.00613 to
−0.00217**. The interval sits entirely below zero: the learner is reliably
*worse*, not merely unproven. It was **not promoted**.

**This is the correct answer, and it is the single most reassuring result here.**
The `realistic` regime contains no directional predictability by construction —
drift is exactly zero and order flow carries no information about the next price
move, because that is the honest position for real markets too. A learner that
had beaten the baseline on this data would have found something that is not
there, and the promotion rule would have shipped it.

At the 20-minute horizon there were only 236 independent observations, so **no
learner was trained at all**. Eighty hours of data is not enough to fit twelve
features to a twenty-minute horizon, and the system says so rather than fitting
one anyway. This is the schedule from §3 arriving exactly as predicted.

### Calibration

The identity calibrator won at both horizons: adjusting the probabilities made
held-out log loss worse. "Uncalibrated, because calibration did not help" is a
legitimate result and is reported as one.

### The backtest

37,760 forecasts replayed over the 80 hours, one every two minutes, eight
targets per horizon placed in standard deviations rather than dollars.

| | n | Brier | ECE | Accuracy |
|---|---|---|---|---|
| 5 min | 18,880 | 0.15658 | 0.00502 | 77.0% |
| 20 min | 18,880 | 0.14871 | 0.00325 | 78.4% |

**Read the accuracy figure with the next table, not on its own.** 77% sounds
like skill and is almost entirely target distance:

| Distance to target | n | Brier | Accuracy | Model said | Actually happened |
|---|---|---|---|---|---|
| 0.0–0.5σ | 14,370 | 0.2322 | 62.8% | 49.5% | 49.4% |
| 0.5–1.0σ | 9,422 | 0.1707 | 77.3% | 49.2% | 49.7% |
| 1.0–2.0σ | 9,149 | 0.0772 | 91.1% | 49.6% | 49.7% |
| 2.0–3.0σ | 4,819 | 0.0233 | 97.6% | 53.4% | 53.4% |

Near the money the Brier score is 0.232 and accuracy is 63%. Three standard
deviations out it is 0.023 and 98%, because "will the price move 3σ in five
minutes" is an easy question. A single headline number hides that completely,
which is why this breakdown is produced by default rather than on request.

The last two columns are the ones that matter: what the model said and what
happened agree to within half a percentage point in every band.

By confidence band, over all 37,760 forecasts:

| Band | n | Model said | Actually happened | 95% interval |
|---|---|---|---|---|
| 55–60% | 2,360 | 59.0% | 58.7% | 56.7–60.7% |
| 60–65% | 7,080 | 60.5% | 60.4% | 59.2–61.5% |
| 65–70% | 4,720 | 68.6% | 68.3% | 66.9–69.6% |
| 70–75% | 4,720 | 70.4% | 70.0% | 68.7–71.3% |
| 80%+ | 18,880 | 90.7% | 90.9% | 90.4–91.3% |

Murphy decomposition: reliability 0.00002 (essentially perfect honesty),
resolution 0.0969, uncertainty 0.2500. The model is informative — but the
information is *how far away the target is*, not which way the price will go.

Skill against the volatility baseline is exactly +0.00000, because no learner was
promoted, so the model being backtested **is** the baseline. That zero is the
system reporting its own state accurately.

**One caveat, stated by the tool itself.** This backtest ran over the same window
the baseline's residual shape and seasonal factors were fitted on, so these
figures are in-sample and flatter the model. `forecaster backtest` detects the
overlap and prints a warning saying so. The out-of-sample numbers are the
walk-forward ones above, which is where the learner was rejected.

### The offline suite

`forecaster verify` — 11 checks, all passing:

| Check | Result |
|---|---|
| Runs with the network off | sockets blocked for the whole run |
| Persistence and hash chain | 20 rows chained, 2/2 edits blocked, 2/2 certainties refused, tamper caught |
| Tuning refused on simulated data | raises `TuningRefused` |
| Leakage canary caught | a mis-declared feature is detected |
| Determinism | same seed identical, different seed differs |
| Feature parity across sources | 20 instants, 3 window sources, 0 mismatches |
| Refusals on bad input | short history, stale feed and dead feed all refuse |
| Dirty feed handled | duplicates, anomalies and crossed books all caught |
| Served output ordering | 603 forecasts, 0 ordering violations, 0 outside the floor |
| Known analytic answer | worst gap 0.070 from the closed-form truth |
| **Null-alpha gate** | **best learner skill on a martingale −0.0782** (must stay under +0.02) |

The last one is the one that matters most. On a market with no predictable
structure whatsoever, the learned model scored *worse* than the volatility
baseline — which is the only acceptable answer. A learner that had found skill
there would have found something that does not exist, and every other result in
this document would be worthless.

### Browser verification

18 checks across a desktop and an iPhone 13 viewport, against the production
build: the simulated-data banner renders, both horizons appear, both
probabilities are visible on both cards, the countdown runs, the advanced panel
opens, a target below spot gets a higher probability than one above it, history
and performance render, no horizontal overflow, and no console errors.

### Test suite

132 Python tests and 20 web tests. `ruff` and `mypy --strict` clean across 57
source files.

---

## 11. The honest summary

The measurement machinery is built and tested: leakage controls work, calibration
is measurable, the metrics distinguish a calibrated forecaster from an
overconfident one, and confidence intervals account for dependence.

**No claim of predictive edge in real markets is made, because no evidence for
one exists.** The next step is not a better model. It is a week of real data.
