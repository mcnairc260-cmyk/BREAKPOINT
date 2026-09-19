# ARCHITECTURE.md

## The shape of it

```
forecaster/
├── engine/                       Python 3.11 — all of the thinking
│   └── src/forecaster/
│       ├── types.py              the vocabulary; imports nothing of ours
│       ├── clock.py              exchange time vs receipt time vs monotonic
│       ├── config.py             every threshold, with its reasoning
│       ├── marketdata/           the boundary between "the market" and "us"
│       │   ├── provider.py         the protocol + shared failure handling
│       │   ├── simulator.py        seeded synthetic market, five regimes
│       │   ├── replay.py           NDJSON capture: write, read, replay
│       │   ├── bars.py             trades → OHLCV at five resolutions
│       │   ├── book.py             snapshot + delta, with gap detection
│       │   ├── conformance.py      a venue's wire protocol, on localhost
│       │   └── venues/             coinbase · binance · kraken
│       │       └── endpoints.py      which hosts are real, and nothing else is
│       ├── store/                 SQLAlchemy Core; SQLite dev, Postgres ready
│       │   ├── schema.py           tables, constraints, the append-only rule
│       │   ├── hashchain.py        the tamper-evident prediction log
│       │   └── repositories.py     the only module that knows SQL
│       ├── features/              window → numbers, causally
│       ├── labels/                the equality rule and outcome resolution
│       ├── models/                baseline · learned corrections · artifacts
│       ├── calibration/           identity · temperature · beta · isotonic
│       ├── validation/            splits · metrics · block bootstrap
│       ├── confidence/            the LOW/MODERATE/HIGH rule
│       ├── quality/               stale · duplicate · anomaly · crossed book
│       ├── backtest/              point-in-time replay through the real engine
│       ├── service/               collector · evaluator · engine · FastAPI
│       │   ├── liverunner.py       the unattended collect-and-forecast loop
│       │   ├── livecheck.py        does this feed say what we think it says?
│       │   ├── livereport.py       the real-market validation report
│       │   └── livestatus.py       progress toward the learner threshold
│       └── cli/                   simulate · collect · live-proof · …
│           ├── live_proof.py       the one command that proves a real market
│           └── conformance_run.py  the same path, no exchange needed
└── web/                          Next.js 15 · React 19 · TypeScript strict
    └── src/{core,components,app}/
```

## Why two runtimes

The modelling genuinely needs Python — NumPy, SciPy, scikit-learn, LightGBM. The
interface genuinely needs to be good, and the repository already has a tested
Next.js house style in `proofhound/`.

In development, `make dev` runs both and Next proxies `/api/*` to the engine. In
production the Next app is exported to static files and served by FastAPI itself,
so it is one process on one origin, with no CORS and nothing to configure.

## The three boundaries that carry the design

### 1. `MarketDataProvider` — where the market ends and the system begins

A protocol with three implementations that matter:

- **venue adapters** (Coinbase, Binance, Kraken): thin HTTP/WebSocket parsers,
  no vendor SDKs, so adding a venue is one file and no new dependency.
- **`ReplayProvider`**: streams a recorded capture in its original order. This is
  what makes a backtest a backtest rather than a second simulation of one.
- **`SimulatedProvider`**: a seeded synthetic market. It exists because the build
  environment cannot reach any exchange, and it is what makes end-to-end
  verification possible at all.

Reconnection, backoff with jitter, rate-limit handling, malformed-message
counting and the staleness clock live in the shared base class, because every
venue fails the same handful of ways and an adapter that had to re-solve all of
that is an adapter nobody writes correctly.

**The label is not the adapter's to choose.** Each adapter takes `ws_url` and
`rest_url`, because a test double and a staging endpoint both need somewhere to
point — so an adapter that also hardcoded `DataSource.LIVE` would write rows
labelled LIVE from a local server, permanently, into an append-only log. The
`data_source` is therefore *derived* from the host being connected to, by exact
match in `venues/endpoints.py`. A host that is not on that list cannot produce
live data, whatever it serves and whatever it is called. There is no override.

`conformance.py` is what that guarantee makes safe: a server speaking Coinbase's
wire protocol on `127.0.0.1`, so the unmodified production adapter can be driven
over a real socket — handshake, subscribe, frame loop, reconnect, stale feed,
malformed frame — in an environment with no exchange. It proves the client. Only
`forecaster live-check` can prove the venue.

### 2. `MarketWindow` — where causality is enforced

One type, built with an explicit cutoff, physically excluding anything after it.
Three sources produce it:

| Source | Used by | Data from |
|---|---|---|
| `RollingWindowSource` | the live server | an in-memory buffer |
| `StoreWindowSource` | ad-hoc queries | the database, per call |
| `CachedWindowSource` | training, backtesting | the database, loaded once |

All three must produce **identical** windows, and `tests/test_feature_parity.py`
asserts it field by field on generated data. That equality is the defence against
training-serving skew — the failure that does not announce itself, where a model
validates beautifully and then quietly underperforms because production feeds it
something subtly different.

`CachedWindowSource` exists purely for speed: the per-call source made training
time out, and loading the range once with binary-search slicing measured 308×
faster. The optimisation is in how data is fetched, never in what the window
contains.

### 3. `ForecastDistribution` — where coherence is enforced

Models produce a **distribution over the future price**, not a probability for one
target. The target is applied afterwards. Three consequences:

- One model serves every possible target, so all the training data trains one
  thing.
- Raising the target can never raise the probability of clearing it, because the
  distribution is monotone by construction.
- The median and the expected range come off the same object as the probability,
  so the product cannot claim a 70% chance of finishing above a price its own
  predicted range excludes.

When a learner or a calibrator adjusts the probability, the shift is absorbed back
into the distribution's location (`with_probability`), so every number the user
sees still comes from one coherent object.

## Data flow

```
venue / simulator / capture
        ↓  MarketDataProvider
   QualityMonitor           ← rejects duplicates, anomalies, crossed books
        ↓
   Collector ──→ store (trades, quotes, books, bars)
        ↓
   RollingWindowSource ──→ MarketWindow ──→ compute_features
                                                  ↓
                            BaselineModel → ForecastDistribution
                                                  ↓
                              learned correction (if permitted)
                                                  ↓
                                      calibration
                                                  ↓
                              ForecastEngine → Forecast
                                                  ↓
              append-only, hash-chained predictions table
                                                  ↓
                    Evaluator (after the horizon passes)
                                                  ↓
                       outcomes → reporting → the interface
```

## The database

SQLAlchemy Core rather than the ORM: the SQL stays explicit and readable, and
PostgreSQL becomes a connection-string change instead of a rewrite.

**Predictions are append-only.** A row is written before its outcome could be
known, is never updated, and carries the hash of the row before it. Outcomes live
in a separate table keyed to the prediction, so resolving a forecast cannot touch
the row that was committed to. The rule is enforced by database triggers, not by
discipline — application code that forgets is a bug, a trigger that raises is a
wall.

Three source fields, deliberately separate:

- `data_source` — where the market data came from
- `model_train_source` — what the model was trained on
- `calibration_source` — what the calibration was fitted on

A model trained on simulated data serving a live feed is not a live result, and
one column would let exactly that be reported as clean.

`p_above` carries a `CHECK (p_above > 0 AND p_above < 1)`. A probability of
exactly zero is a claim of certainty and makes log loss infinite; one such row
would poison an entire aggregate.

**The tick layer is sampled, not exhaustive.** Trades and top-of-book are stored
in full; book depth is a periodic top-N snapshot. A full level-2 delta stream for
one pair runs to gigabytes a day, which SQLite should not be asked to hold, and a
one-second top-ten snapshot carries almost all of the signal available at a
five-minute horizon. Reversing this means a columnar store, and that is a
deliberate later decision rather than an accident.

## Degradation

Automatic, never a human judgement:

| Level | Trigger | Behaviour |
|---|---|---|
| `FULL` | everything healthy | normal |
| `DEGRADED` | top of book lagging > 5s | baseline only, confidence capped |
| `STALE` | no trade for 120s | **refuses to forecast** |
| `DOWN` | no data at all | refuses to forecast |

A refusal is a feature. The alternative — a plausible number derived from a stale
feed — is worse in every way that matters, because nothing about it looks wrong.

## Security

Market data on the default venue needs no API key, which removes a whole class of
problem before it exists. Nothing in `.env.example` is required for the system to
run. No secret is ever read in the web app, and the engine reads configuration
only from environment variables.

## What is deliberately not here

- **No user accounts, no authentication.** Nothing to protect yet; adding it
  before there is something to protect is how a project acquires attack surface
  and no users.
- **No order execution, ever.** This estimates probabilities. It does not trade,
  and the boundary is worth keeping architectural rather than a matter of
  restraint.
- **No cross-venue arbitrage signals.** The provider abstraction leaves room for
  them; adding them now would be adding complexity ahead of evidence.
