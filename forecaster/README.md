# Forecaster

Calibrated probabilities that BTC or ETH finishes above a price you choose, at 5
and 20 minutes — with every forecast recorded before its outcome is knowable and
scored automatically afterwards.

> ### NO REAL-MARKET VALIDATION HAS BEEN PERFORMED
>
> **No real BTC or ETH data has been ingested. No live forecast has been made or
> resolved.** Every result here was produced on **simulated, replayed or
> conformance** data. The environment this was built in cannot reach any exchange:
> Coinbase, Kraken and Binance are each refused with `HTTP 403` at the egress
> proxy, on both transports.
>
> So: the pipeline is built and tested, the maths is checked, the leakage
> controls work, the live data path is exercised over a real socket, and the
> product runs end to end. **Nothing here is evidence about real markets.**
>
> The remaining gap is exactly one thing — network access to an exchange — and
> three commands close it. See [`LIVE_VALIDATION.md`](LIVE_VALIDATION.md) and
> [`VALIDATION.md`](VALIDATION.md).

---

## What it does

You pick an asset and type a price. It answers:

```
BITCOIN
Current   $79,434.27
Target    $79,460.00      +$25.73  ·  +0.0324%

5 MINUTES              20 MINUTES
ABOVE   41.7%          ABOVE   45.8%
BELOW   58.3%          BELOW   54.2%
MODERATE confidence    MODERATE confidence
80% range              80% range
$79,277 – $79,591      $79,121 – $79,749
Scores at 6:37:00 PM   Scores at 6:52:00 PM
```

Those numbers are not an example of what a good model might produce. They are
what an honest model *does* produce for a target $26 away: **close to a coin
flip**, because $26 is small compared with how far BTC moves in five minutes. A
system showing 62% there would be claiming a directional edge that nothing in
short-horizon crypto data supports. See [`MODEL.md`](MODEL.md) §3.

The target may sit **above or below** the current price. This does not predict
whether the price rises; it predicts whether it ends up above *your* number.

---

## Quick start

```bash
cd forecaster
make setup     # Python venv + npm install
make dev       # engine on :8099, interface on :3220 — ctrl-c stops both
```

That is enough to use it: the engine starts on a simulated market, warms itself
up from the recent past, and forecasts immediately. Everything on screen is
labelled SIMULATED.

To run the whole pipeline end to end — generate a market, train, backtest:

```bash
make demo      # ~45 minutes; writes reports/backtest.json
```

To point it at a real exchange, from a machine with ordinary network access:

```bash
make live-check                               # ~30s: verifies the venue's prices
FORECASTER_PROVIDER=live make collect-live    # then collect, for days
make live-status                              # progress and feed health
make live-report                              # the validation report
```

`make live-check` does not just confirm that bytes arrived. Per symbol it checks
sixteen things and prints what it observed for each — symbol mapping, decimal
precision, both timestamps, bid, ask, midpoint, spread, freshness, whether the
book is crossed — and exits non-zero on any impossible value. Run it before a
long collection run, which is what it is for.

Without an exchange you can still exercise the entire live path:

```bash
make conformance      # ~60s: the real adapter against a local wire-protocol server
```

No API key is needed for any of this. Coinbase's market data is public, which is
a large part of why it is the default.

Other useful targets: `make verify` (lint, types, tests, offline suite, the
conformance run, web build), `make test`, `make stop`, `make clean`. `make help`
lists them.

---

## The idea in one paragraph

You choose the target, so training a separate classifier per target price would
be hopeless — and would eventually print a higher chance of clearing a *higher*
price, which is incoherent. Instead the system models the **distribution of the
future price** and reads your target off it. One model serves every target, the
answer can never contradict itself, and the median and the expected range come
off the same object as the probability — so it cannot claim a 70% chance of
finishing above a price its own predicted range excludes.

Almost all of the answer comes from **how far away your target is, measured in
standard deviations of the likely move**. Not from an opinion about direction.
Direction is not forecastable at these horizons; the size of the likely move very
much is, and that is what makes the product possible.

---

## Commands

| Command | What it does |
|---|---|
| `forecaster simulate` | Generate a seeded synthetic market. Five regimes. |
| `forecaster collect` | Collect live market data. The one that must keep running. |
| `forecaster train` | Fit the baseline, then a learner if the data can support one. |
| `forecaster backtest` | Replay history, forecasting from what was known at each instant. |
| `forecaster evaluate` | Score forecasts whose horizon has passed. |
| `forecaster report` | Performance statistics, grouped and caveated. |
| `forecaster serve` | Run the API, the collector and the evaluator. |
| `forecaster live-check` | Connect to a real venue and verify every price it reports. |
| `forecaster collect-live` | Collect live data and forecast against it, unattended. |
| `forecaster live-status` | Feed health and progress toward the learner threshold. |
| `forecaster live-report` | The real-market validation report. Live rows only. |
| `forecaster conformance` | The whole live path against a local server, no network. |
| `forecaster verify` | The full offline verification suite. |

`make verify` runs everything: lint, types, the Python suite, the offline suite,
the conformance run, and the web app's typecheck, lint, tests and production
build.

---

## Data providers

| Provider | Use | Notes |
|---|---|---|
| `coinbase` | **default** | Public data, no API key, works in the US. WebSocket or REST polling. |
| `binance` | secondary | Deepest book by a distance. `binance.com` is blocked to US users. |
| `kraken` | secondary | Public data, US-accessible. A useful cross-check on Coinbase. |
| `replay` | backtesting | Replays a recorded capture in its original order. |
| `simulated` | development, CI | Seeded, deterministic, five regimes. |

Adding a venue is one file. Reconnection, backoff with jitter, rate limiting,
malformed-message handling and the staleness clock are shared.

**The venue adapters have never been run against a live venue in this
environment**, because no venue is reachable from it.

They are, however, no longer only fixture-tested. `make conformance` runs a
server speaking Coinbase's wire protocol on `127.0.0.1` and connects the
unmodified production adapter to it over a real socket — handshake, subscribe,
frame loop, book building, reconnects, stale feeds, malformed frames, restarts.
That proves the client. It cannot prove the venue emits these shapes today;
`make live-check` is the only thing that can, and it needs a network.

A provider's `data_source` is **derived from the host it connects to**, never
asserted. Anything that is not a venue hostname — a local server, a staging
endpoint, a typo, a look-alike domain — produces `SIMULATED` rows that no live
metric will ever count. There is no override flag.

---

## Honesty rules, enforced in code

- **Simulated data is labelled everywhere it appears** — in the API response, in
  a banner the interface cannot render without, in every model version string
  (`.sim.`), and in every model card.
- **A model trained on simulated data cannot serve a live forecast.** The check
  is in the engine, on by default, and overriding it requires setting an
  environment variable whose name says what it does — and the warning still
  reaches the interface.
- **Predictions are append-only and hash-chained.** A forecast is written before
  its outcome could be known, is never updated, and carries the hash of the row
  before it. Database triggers enforce it. This is what makes a track record
  checkable rather than trusted.
- **No probability is ever 0% or 100%.** Floored in the model and again by a
  database constraint. Displayed as `<1%` and `>99%`, because the difference
  between 0.3% and 0.7% is far below what any realistic amount of data can
  establish.
- **A bad feed reduces what the system claims.** Stale data drops it to the
  baseline, then to refusing outright. A refusal is a feature; a plausible number
  from a stale feed is worse in every way, because nothing about it looks wrong.
- **Metrics are never pooled** across symbol, horizon, model version or data
  source.
- **Sample size is reported four ways**, and the smallest — genuinely independent
  observations — is the one every claim is judged against. One day of one-second
  sampling gives 288 independent 5-minute observations, not 86,400.
- **Learners are not trained below 750 independent observations.** The threshold
  was fixed before any result was seen.
- **The identity calibrator is a real candidate**, and often wins. "Uncalibrated,
  because calibration did not help" is a legitimate result.

---

## Forecasting methodology

Read [`MODEL.md`](MODEL.md) — it is written in plain English and is the document
to start with. In brief:

1. Estimate how far the price is likely to move (volatility over several windows,
   jump-adjusted, seasonally adjusted where data allows).
2. Apply a distribution shape with fat tails, fitted from history where possible
   and spliced with an extreme-value tail beyond it.
3. Measure how far your target is in those units. That is nearly the whole answer.
4. Apply a learned **correction** to that baseline, if one has earned the right to
   exist.
5. Calibrate against recorded outcomes, if calibration helps.

Drift is assumed to be exactly zero, deliberately. That is the honest null at
these horizons and a genuinely hard benchmark to beat.

---

## Interpreting a probability

- **62% ABOVE** means: if the system says this a thousand times, it should be
  right about 620 times. It does **not** mean the price will go up.
- **The 80% range** is a prediction interval, labelled as such. One time in five
  the price finishes outside it — by design.
- **Confidence is not the probability.** A well-calibrated 55% is a good
  forecast. A 75% from a stale feed is not. Confidence never changes the number,
  only the label and the warnings.
- **A near-the-money 5-minute forecast will sit near 50%.** That is the system
  working, not failing.

---

## How much data before it means anything

| Horizon | Independent observations per day | Days to ~2,000 |
|---|---|---|
| 5 min | 288 | **~7** |
| 20 min | 72 | **~28** |

This is why the system ships baseline-only and starts collecting immediately. The
learner appears when the data can support it, not before.

---

## Testing

```bash
cd engine && .venv/bin/python -m pytest -q
```

Network access is blocked for the whole suite (`--disable-socket`). That is
hermeticity and also proof that the venue fixtures really are fixtures.

The tests that matter most:

- `test_leakage.py` — declared lookbacks, the causality checkpoint, purge and
  embargo, plus a deliberately leaking feature that must be caught.
- `test_monotonicity.py` — the probability never rises as the target rises,
  through the **fully served** output: model, correction, calibration, rounding.
- `test_feature_parity.py` — the live path and the training path produce
  identical windows and identical features. This is the guard against
  training-serving skew.
- `test_persistence.py` — append-only enforcement, hash-chain verification, and a
  tampered row being detected.
- `test_api_and_end_to_end.py` — forecast, persist, expire, evaluate, report.

---

## Deployment

The engine is a single Python process. In production, build the interface to
static files and let the engine serve them — one process, one origin, no CORS:

```bash
cd web && NEXT_EXPORT=1 npm run build
cd ../engine && FORECASTER_PROVIDER=live .venv/bin/forecaster serve --host 0.0.0.0
```

SQLite is fine for a single instance. For anything more, point `FORECASTER_DB` at
PostgreSQL — the schema is SQLAlchemy Core and portable, no code changes.

Run the collector as its own always-on process. It is the part whose data cannot
be recovered later.

---

## What has been measured

On 80 hours of simulated market (2.9M trades, seed 4242). Full detail and
caveats in [`VALIDATION.md`](VALIDATION.md).

| | 5 min | 20 min |
|---|---|---|
| Independent observations | 947 | 236 |
| Baseline Brier | 0.13529 | 0.12640 |
| Baseline calibration error | 0.00441 | 0.00012 |
| Learner trained? | yes | **no** — 236 < 750 |
| Learner promoted? | **no** — significantly worse | — |

The learner was trained at 5 minutes and **rejected**: Brier 0.1395 against the
baseline's 0.1353, with a 95% interval of −0.0061 to −0.0022 that sits entirely
below zero. That is the correct outcome. The simulator's realistic regime
contains no directional predictability by construction, so a learner beating the
baseline there would have found something that is not there.

`forecaster verify` passes 11 checks including the null-alpha gate: on a
martingale the best learner skill over the baseline is −0.078, well under the
+0.02 that would indicate a leak.

132 Python tests, 20 web tests, 18 browser checks across desktop and iPhone
viewports. `ruff` and `mypy --strict` clean across 57 source files.

**None of this is evidence about real markets.** It is evidence the pipeline is
correct.

---

## Limitations

1. **No real-market validation.** The largest limitation by a distance.
2. **No learner ships trained.** There is not enough independent data yet, and the
   system says so rather than training one anyway.
3. **Confidence thresholds are provisional**, and labelled as such.
4. **Book depth is sampled, not streamed.** A one-second top-ten snapshot, not the
   full delta stream. Reversing this means a columnar store.
5. **Seasonality ships flat.** The weekly volatility pattern is real but must be
   estimated from real data.
6. **Single venue at a time.** Cross-venue signals are architecturally possible
   and deliberately not built.
7. **SQLite will not hold months of tick data.** Plan the move, or thin the
   history.

---

## Not investment advice

This estimates probabilities. It produces no buy or sell signal, executes
nothing, and makes no claim of profitability. Short-horizon crypto forecasting is
close to the hardest case there is, and the honest expectation is that a
well-built system here is only slightly better than a coin flip — which is
exactly why calibration, not accuracy, is the thing being measured.
