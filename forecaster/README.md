# Forecaster

Calibrated probabilities that BTC or ETH finishes above a price you choose, at 5
and 20 minutes — with every forecast recorded before its outcome is knowable and
scored automatically afterwards.

> ### NO REAL-MARKET VALIDATION HAS BEEN PERFORMED
>
> Every result in this repository was produced on **simulated or replayed** data.
> The environment this was built in cannot reach any exchange — every venue and
> market-data host tested is blocked by network policy, and WebSocket upgrades
> are unsupported through its proxy.
>
> So: the pipeline is built and tested, the maths is checked, the leakage
> controls work, and the product runs end to end. **Nothing here is evidence
> about real markets.** See [`VALIDATION.md`](VALIDATION.md).

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
make setup                    # Python venv + npm install

# Generate a simulated market, train on it, and see it work end to end
cd engine
.venv/bin/forecaster simulate --duration 288000 --regime realistic --anchor-now
.venv/bin/forecaster train    --data-source simulated --venue simulator
.venv/bin/forecaster backtest --data-source simulated --venue simulator

# Run it
cd .. && make dev             # engine on :8099, interface on :3220
```

To point it at a real exchange, from a machine with ordinary network access:

```bash
cd engine
python scripts/smoke_live.py            # ~30s: proves the adapter works
FORECASTER_PROVIDER=live FORECASTER_VENUE=coinbase .venv/bin/forecaster serve
```

No API key is needed. Coinbase's market data is public, which is a large part of
why it is the default.

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
| `forecaster verify` | The full offline verification suite. |

`make verify` runs everything: lint, types, the Python suite, the offline suite,
and the web app's typecheck, lint, tests and production build.

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
environment.** They are unit-tested against fixtures written from each exchange's
published API documentation — which proves the parsing and proves nothing about
the connection. `scripts/smoke_live.py` closes that gap in about thirty seconds
on a machine with network access.

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
