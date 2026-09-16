# LIVE_VALIDATION.md — the real-market validation phase

> ## STATUS: LIVE-MARKET OPERATIONAL CORRECTNESS — PROVEN
>
> **15 September 2026, 09:04–10:16 UTC. Coinbase. WebSocket. 11 stages of 11.**
>
> Real BTC-USD and ETH-USD data, 132 live forecasts, 108 resolved from the
> venue's own prints, 0 void, 0 monotonicity violations, 0 reconnects, restart
> survived with 0 duplicate outcomes. Verdict **PROVEN**, exit 0.
>
> This proves the application. It says nothing about forecast skill: 18
> independent observations is a smoke test, the report labels it as one, and
> that stays true until days of collection say otherwise.

---

## 1. The development environment cannot reach a venue. A GitHub runner can.

The proof in section 10 ran on a GitHub Actions runner, not here. This section
records why that was necessary, because the diagnosis took interpreting and the
same trap catches anyone behind a corporate proxy.

Eight exchanges, five layers each, probed programmatically:

```
$ forecaster probe-venues

  venue       dns   tcp   tls   rest            websocket       adapter  usable
  kraken      ok    ok    FAIL  ProxyError      InvalidProxySta yes      no
  coinbase    ok    ok    FAIL  ProxyError      InvalidProxySta yes      no
  binance     ok    ok    FAIL  ProxyError      ConnectionReset yes      no
  binance.us  ok    ok    FAIL  ProxyError      ConnectionReset yes      no
  bitstamp    ok    ok    FAIL  ProxyError      InvalidProxySta no       no
  gemini      ok    ok    FAIL  ProxyError      InvalidProxySta no       no
  okx         ok    ok    FAIL  ProxyError      ConnectionReset no       no
  bitfinex    ok    ok    FAIL  ProxyError      InvalidProxySta no       no
```

Every hostname resolves. Every TCP connection to port 443 succeeds. Every REST
request returns **HTTP 403** and every WebSocket upgrade is refused.

### The part that took interpreting

TCP succeeds and TLS completes. Read quickly, that says the exchanges are
reachable and something higher up is at fault. It says the opposite.

Inspecting the certificates from those handshakes:

```
api.kraken.com             subject *.kraken.com
                           issuer  Anthropic / Egress Gateway SDS Issuing CA (production)
api.exchange.coinbase.com  subject *.exchange.coinbase.com
                           issuer  Anthropic / Egress Gateway SDS Issuing CA (production)
api.gemini.com             subject *.gemini.com
                           issuer  Anthropic / Egress Gateway SDS Issuing CA (production)
```

No public CA signed any of them. The connections terminate at the environment's
own egress gateway, which presents a substituted certificate for whatever
hostname was asked for and then refuses the request. **There is no direct route
either** — proxied or not, every path out of this machine ends at the same
gateway. Nothing here can reach an exchange by any means, and no choice of venue,
transport or port changes that.

`probe-venues` now reports this rather than "tls ok", because "tls ok" invites
exactly the wrong conclusion — here, and on anyone's corporate network doing the
same thing.

The full record is in `reports/venue-reachability.json`.

### Providers tried, in the priority order requested

| # | venue | adapter | REST | WebSocket | verdict |
|---|---|---|---|---|---|
| 1 | Kraken | yes | 403 | refused | blocked at gateway |
| 2 | Binance | yes | 403 | reset | blocked at gateway |
| 2 | Binance.US | yes | 403 | reset | blocked at gateway |
| 3 | Bitstamp | no | 403 | refused | blocked at gateway |
| 4 | Gemini | no | 403 | refused | blocked at gateway |
| 5 | OKX | no | 403 | reset | blocked at gateway |
| 6 | Bitfinex | no | 403 | refused | blocked at gateway |
| — | Coinbase | yes | 403 | refused | blocked at gateway |

Writing adapters for Bitstamp, Gemini, OKX or Bitfinex would not have helped: all
four are refused at the same layer as the three that already have adapters. An
adapter cannot fix a connection that never opens, and writing four of them to
discover that would have been work done in the wrong order.

---

## 2. What to run on a normal network

### The easiest way: one button, nothing installed

**GitHub → Actions → "Live market proof" → Run workflow.**

A GitHub runner has ordinary internet, six hours of budget and no egress policy,
which makes it a better host for this than most laptops. Nothing to install, no
Python, no command line. The run takes about an hour and writes its verdict into
the job summary; `live-proof.json` and the venue table are attached to the run as
a downloadable artifact, kept for 90 days.

Tick **probe_only** to just ask which exchanges the runner can reach — about a
minute, and worth doing first if anything is uncertain.

The job **fails unless the verdict is PROVEN**. A run that completes perfectly
against something that is not an exchange is NOT LIVE and still fails: a green
tick that did not require real market data would be worse than no check at all.

### On your own machine

**One command**, and it needs nothing installed beyond Python 3.11 or newer — no
virtual environment, no `make`, no `pip install`, no API key. It works the same
on Windows, macOS and Linux.

```
python scripts/live_proof.py
```

That script creates its own environment, installs the engine, probes every
exchange it knows, picks the first that answers and has an adapter, and runs the
whole proof against it. It writes `reports/live-proof.json` and prints a block to
copy. `make` is deliberately not required: the machine that can reach an exchange
is usually not the machine the code was written on, and a stock Windows install
has no `make`.

If you already have the project set up, the make targets do the same things:

```bash
make probe-venues                  # ~15s: which exchanges can this machine reach
make live-proof                    # ~1h: probes, picks a venue, proves it
make live-proof PROVIDER=kraken    # ~1h: a specific venue
```

**Run `probe-venues` first if anything is doubtful.** Fifteen seconds, and it
answers "is it me, the network, or the venue?" per exchange and per layer instead
of leaving it to guesswork.

That is the whole external procedure. It verifies that every price the venue
reports means what the code thinks it means, collects until the volatility model
has enough history to speak, forecasts BTC and ETH at both horizons across six
target distances, waits for those forecasts to expire, resolves them from the
venue's own prints, restarts itself against the same database to prove nothing is
lost or double-counted, and writes `reports/live-proof.json`.

It ends in exactly one of three states:

| verdict | meaning | exit |
|---|---|---|
| **PROVEN** | live venue data in, forecasts out, horizons expired, outcomes recorded, survived a restart | 0 |
| **NOT LIVE** | every stage ran, against something that is not a venue endpoint — nothing is proven about a real market | 1 |
| **BLOCKED** | no market data arrived, reported with the exact transport error | 1 |

`make live-proof ARGS="--transport poll"` if WebSocket upgrades are blocked where
you are. The polling transport is a real transport, not a stub.

### Why it takes an hour

Nearly all of it is waiting, and neither wait can be removed without weakening
something:

* **~30 minutes of warm-up.** The volatility model refuses to forecast until it
  has seen thirty minutes of market. A shortcut exists — Coinbase publishes
  60-second candles going back hours — and it is deliberately not taken, because
  those candles cannot feed the one-second bars the estimator actually reads, and
  widening the estimator to accept coarser data so that a demo finishes sooner
  would weaken the safeguard it exists to enforce. The refusal is the product
  working.
* **~20 minutes for the longer horizon to expire.** A 20-minute forecast cannot
  be resolved in less than 20 minutes. There is no version of this that is fast.

### Afterwards, for an actual track record

One run proves the application works. It does not produce evidence about forecast
quality — for that the collector has to run for days:

```bash
FORECASTER_PROVIDER=live FORECASTER_VENUE=coinbase make collect-live
make live-status              # is it running, and how far along
make live-report              # the validation report
```

`make live-check ARGS="--transport poll"` if WebSockets are blocked where you
are; the polling transport is a real transport, not a stub.

### What `live-check` actually verifies

`live-proof` runs these checks as its second stage; `make live-check` runs them
alone in about thirty seconds, which is the right thing to try first if you are
not sure the network will cooperate.

Not "did bytes arrive". For each of BTC-USD and ETH-USD it checks sixteen
things and prints the number it observed for every one: symbol mapping, trade
price plausibility, positivity, sub-unit decimal precision, trade size, whether
the aggressor side is published, exchange timestamp sanity against local time,
receipt-after-exchange ordering, receipt monotonicity, feed freshness, book not
crossed, bid and ask positive, midpoint inside the spread, spread plausibility,
trade price agreeing with the midpoint, and order-book depth arriving.

Any impossible value — a negative price, a crossed book, a timestamp from next
week — fails the run and exits non-zero. It is safe to put in front of a long
collection run, and that is the intended use.

### What `collect-live` does

Subscribes to both symbols, maintains rolling windows, forecasts on a schedule,
writes every forecast to the append-only log, resolves each one when its horizon
passes, records market data, reconnects automatically, publishes health to
`engine/data/live_runner_status.json`, and does not stop for any single failure.

**Sampling interval: one forecast per horizon per symbol.** A 5-minute forecast
made now and another made a second from now share 299 of their 300 seconds; they
are one piece of evidence counted twice. Sampling at the horizon makes every
forecast disjoint from the last, so the row count *is* the evidence count and
there is nothing to correct for later. At the defaults that is 288 five-minute
and 72 twenty-minute sampling instants per symbol per day.

**Six targets per instant**, placed in volatility units rather than dollars so
they mean the same thing in a calm market and a violent one:

| rung | z | what it asks |
|---|---|---|
| A | 0.00 | essentially the current price |
| B | +0.25 | modestly above |
| C | −0.25 | modestly below |
| D | +1.00 | about one expected move above |
| E | −1.00 | about one expected move below |
| F | +2.50 | substantially farther than the market should go |

Those six are **not** six independent observations. They are six views of one
future price, which is why the report counts rows, timestamps and non-overlapping
observations as three separate numbers.

---

## 3. The proof procedure, run at the real product horizons

`make live-proof` has been run end to end against the conformance server at the
**actual 300-second and 1200-second horizons** — not shortened ones. Twenty-two
minutes of wall clock, because a 20-minute forecast cannot resolve any sooner:

```
[FAIL] endpoint is a real venue              data_source=SIMULATED  (not a venue host)
[PASS] live prices verified                  32 checks passed, 0 failed, 12,517 events
       BTC-USD: 79,093.24  bid 79,089.71 / ask 79,097.62  mid 79,093.67  spread 1.00 bps
       ETH-USD:  3,103.09  bid  3,102.81 / ask  3,103.12  mid  3,102.97  spread 1.00 bps
[PASS] real BTC and ETH trades received      trades for BTC-USD, ETH-USD
[PASS] forecasts generated                   504 forecasts from 84 sampling instants
[PASS] forecasts expired and were scored     204 resolved, 0 void
[PASS] every horizon produced a resolved forecast   resolved at 300s, 1200s
[PASS] probability never rises with the target      0 violations in 420 adjacent pairs
[PASS] predictions survive a restart         504 of 504 present, chain intact
[PASS] no outcome recorded twice             204 before, 204 after a second pass, 0 duplicates
[PASS] validation report generated

VERDICT: NOT LIVE                                                    exit 1
```

Per cell: BTC 300s 126 generated / 96 resolved, ETH 300s 126 / 96, BTC 1200s
126 / 6, ETH 1200s 126 / 6. The 20-minute cells resolve fewer because the run was
only just longer than one 20-minute horizon — which is the honest arithmetic, not
a fault.

**The verdict is NOT LIVE and the exit code is 1**, because the endpoint was not
a venue. Every other stage passed. That is the distinction this command exists to
enforce: a flawless run against something that is not an exchange proves the
software and proves nothing about a market, and it must never be able to exit
zero.

Run against the real Coinbase endpoint, the same command reports:

```
[PASS] endpoint is a real venue      data_source=LIVE
[FAIL] live prices verified          0 checks passed, 2 failed, 0 events
                                     — ProviderError: coinbase ticker request failed: 403 Forbidden
VERDICT: BLOCKED                                                     exit 1
```

Note the first line inverts. Against Coinbase the endpoint *is* a venue and the
data cannot arrive; against the conformance server the data arrives and the
endpoint is not a venue. Neither can be mistaken for the other, and neither
exits zero.

### A bug this found, which is why it was run rather than reasoned about

The first attempt made **zero forecasts in twenty-two minutes** and reported
"service level down". `live_check` closes the feed it samples — correctly — and
the proof then handed that same closed object to its collector, which streamed
nothing. Against a real exchange this would have been indistinguishable from a
dead venue and would have cost an hour to diagnose. Each stage now opens its own
connection, and a test pins the behaviour so the assumption cannot return.

---

## 4. What was proved here, without a venue

A server that speaks Coinbase's WebSocket and REST wire protocol runs on
`127.0.0.1`, and the **unmodified production adapter** connects to it over a real
TCP socket: real handshake, real subscribe frame, real JSON off the wire.

```bash
make conformance      # ~60 seconds, no network needed
```

```
[PASS] endpoint guard downgrades a non-venue host    data_source=simulated
[PASS] live price checks pass over a real socket     32 checks, 1,446 events
[PASS] dirty feed survived and bad data rejected     400 events, 37 rejected, 1 reconnects
[PASS] forecasts produced on live-path data          120 forecasts across 2 symbols
[PASS] forecasts resolved automatically at expiry    96 resolved, 0 void
[PASS] probability never rises with the target       0 violations in 100 adjacent pairs
[PASS] append-only chain intact under concurrency    120 rows chained
[PASS] predictions survive a restart                 120 of 120 still present
[PASS] resolution is idempotent across restarts      24 first pass, 0 second
[PASS] conformance rows never appear in live metrics live=0, simulated=120
[PASS] a small sample refuses to report calibration  2 groups labelled insufficient

11/11 checks passed
```

Before this phase, the venue adapters were tested by calling their parse
functions on dictionaries loaded from a JSON file. That proved the parsing and
nothing else — not the handshake, not the subscribe message, not the frame loop,
not the reconnect path, not the REST client, not timeout handling. All of that is
now exercised.

**This is a large step and it is not the whole distance.** It proves the client.
It cannot prove that Coinbase emits these shapes today, because the only thing
that can prove that is a connection to Coinbase.

### Fault injection

The conformance server can be told to misbehave, and each failure has a test
asserting the system either recovers or refuses:

| injected fault | required behaviour | tested |
|---|---|---|
| socket dropped mid-stream | reconnect with backoff, keep the sequence | ✓ |
| socket open but silent | detected as stale by the clock, service level drops | ✓ |
| REST request hangs past timeout | surfaces as a reconnect, never a hang | ✓ |
| REST returns 500 | reconnect, error recorded | ✓ |
| malformed JSON frame | counted, discarded, stream continues | ✓ |
| duplicate message | dropped, never counted twice | ✓ |
| timestamp steps backwards | accepted but flagged, never silent | ✓ |
| quote missing entirely | midpoint unavailable, reported not invented | ✓ |
| crossed book (bid ≥ ask) | rejected before it reaches a feature | ✓ |
| zero / negative / NaN / infinite price | rejected before it reaches a feature | ✓ |
| spread explosion | flagged as implausible | ✓ |
| restart during an open prediction | prediction survives, resolves exactly once | ✓ |

Nothing in that table is asserted by inspection. Each row is a test that fails if
the behaviour changes.

---

## 5. Five defects found and fixed, none of which announced itself

The first three were found offline. The last two took real market data and could
not have been found any other way — which is the strongest argument in this
document for why the live proof had to happen at all.

### The append-only log forked under concurrency

Every prediction is hash-chained to the one before it, and the chain is the
product's evidence that a forecast was not edited after the fact. Extending it
read the current head and inserted a new row — a read-modify-write that was **not
atomic**. Two threads could read the same head and both append to it. Neither
insert failed. The chain forked, and the next verification reported a break
indistinguishable from tampering.

The API serves requests on a thread pool, so this was reachable before the live
runner existed. Reproduced with eight threads appending concurrently: 40 rows, 8
forks, no error raised.

Fixed with two defences: a unique index on `prev_hash`, which makes a fork
structurally impossible rather than unlikely, and a process-wide lock plus a
bounded retry so the loser of a race re-reads the head instead of failing. Same
test after the fix: 80 rows, 0 forks, chain verifies.

### REST receipt timestamps were recorded before the request

The polling transport stamped `received_ns` *before* issuing the HTTP request
rather than when the response arrived. On a real venue with a 50ms round trip
every polled event would claim to have been received 50ms before the exchange
stamped it — negative latency. It corrupts the clock-skew estimate and makes a
poll look fresher than it is. Present in all three adapters; fixed in all three.

Found by a test asserting `received_ns >= exchange_ns`, which is the kind of
invariant that is obvious once written and invisible until then.

### The live proof reused a provider it had already closed

`live_check` closes the feed it samples, which is correct: it owns that
connection's lifecycle. The proof then passed the same object to its collector,
whose stream ended immediately because `close()` is permanent. The result was a
run that collected for twenty-two minutes, produced zero forecasts, and reported
"service level down" — indistinguishable from a dead exchange.

Against Coinbase that would have burned an hour before anyone could tell whether
the venue or the code was at fault. Each stage now opens its own connection, and
a test asserts that a closed provider yields nothing and that a fresh one against
the same venue works, so the assumption cannot come back quietly.

### The live proof budgeted one horizon where it needed two

*Found by the first live run.* It reached Coinbase, verified real prices, made 72
forecasts and resolved 48 — and returned FAILED on the one stage the procedure
exists to demonstrate: no 20-minute forecast resolved.

The budget assumed a forecast is made the instant the warm-up ends. It is not. A
horizon-H forecast is sampled once every H seconds — deliberately, so that no two
overlap — so the first tick after a thirty-minute warm-up can be almost a full H
away, and only then does the horizon begin. Worst case is warm-up + 2H. Budgeting
warm-up + H gave 52 minutes; the 20-minute forecasts were made at minute 40 and
would have expired at minute 60.

The arithmetic was exactly right and the formula was wrong, which is the hardest
combination to notice.

### The WebSocket frame limit was one megabyte

*Found by the second live run, by a check added after the first.* The run resolved
both horizons and failed on the reconnect stage, which reported what no previous
run had:

```
ConnectionClosedError: sent 1009 (message too big)
```

Close code 1009 is the client refusing a frame. Coinbase opens the `level2_batch`
channel by sending the entire order book per product, and the `websockets`
default caps a frame at 1 MiB. So: connect, subscribe, receive an oversized
snapshot, close, reconnect, resubscribe, receive it again — **6,177 times in 72
minutes**, while still passing enough trades and quotes between reconnects that
every other stage went green.

No fixture could have found this. Fixtures are small because a person typed them;
only a venue sends a real book. And it needed the reconnect stage to be *visible*
rather than merely present: the first live run had the identical storm and
reported nothing, because data was arriving and that is easy to mistake for a
connection being healthy.

All three adapters now cap at 32 MiB — generous for a book, still a bound.
Removing the limit would drop the only defence against a feed that misbehaves.
The test pads a conformance snapshot to 2.39 MiB and was checked against a
reverted fix to confirm it actually fails there.

---

## 6. Live and simulated cannot be mixed

Section 7 of the brief asks that real data never mix with simulation. The
previous design relied on each adapter asserting its own label, and every adapter
hardcoded `DataSource.LIVE` — while also accepting `ws_url` and `rest_url` as
constructor arguments. Point an adapter at a local server and it would write rows
labelled LIVE. The log is append-only, so that contamination would be permanent.

The label is now **derived from the host actually connected to**, matched exactly
against a list of venue hostnames:

```
CoinbaseProvider()                                    -> LIVE
CoinbaseProvider(ws_url="ws://127.0.0.1:9001")        -> SIMULATED
CoinbaseProvider(rest_url="http://127.0.0.1:9002")    -> SIMULATED   (one bad URL is enough)
CoinbaseProvider(ws_url="wss://ws-feed.exchange.coinbase.com.attacker.example")
                                                      -> SIMULATED   (no suffix matching)
```

There is deliberately no override flag. An escape hatch here would be used exactly
once, on the day it mattered most. A venue that renames a host makes the adapter
downgrade to SIMULATED rather than mislabel — the right way round, because a track
record that is too small is repairable and one that is quietly wrong is not.

`live-report` filters every query on `data_source`. Run against a database full of
conformance rows it reports zero live forecasts and says *"This system has no
real-market track record"*, which is the correct answer.

---

## 7. The learner is still quarantined, and the threshold is unchanged

`MIN_INDEPENDENT_FOR_ML = 750` **non-overlapping** observations, per symbol and
horizon. It was not lowered for this phase and must not be.

Counted honestly, that is:

| horizon | independent observations per day per symbol | days to 750 |
|---|---|---|
| 5 min | 288 | ~2.6 |
| 20 min | 72 | ~10.4 |

`make live-status` reports progress toward it, and reports the implied number of
days **as arithmetic on the rate observed so far, explicitly not as a promise
about the calendar**. Outages, halts and voided forecasts all slow it down and
none of them are known in advance.

Sampling faster does not move this number. Two forecasts five seconds apart at a
five-minute horizon share 295 of their 300 seconds, and six targets at one instant
are six views of one future price.

---

## 8. The rule that governs the first live run

**The first live collection period is evidence, not a tuning playground.**

When live data starts arriving, do not change features, probability formulas,
calibration, confidence thresholds or model parameters because an early sample
looks bad. A few hundred overlapping forecasts from one afternoon cannot
distinguish a miscalibrated model from an ordinary afternoon, and adjusting the
model to fit them converts the only out-of-sample data in existence into
in-sample data. There is no way to undo that.

An implementation *bug* — a wrong unit, a crossed field, a parse error — is a
different thing. Fix it, and write down what it was.

---

## 9. What is done, and what would make the rest COMPLETE

**Done — 15 September 2026.** `live-proof` ended in PROVEN and exited 0. Real BTC
and ETH data in, real forecasts out, both horizons expired, outcomes recorded
from the venue's own prints, survived a restart. `reports/live-proof.json` is in
the repository. `VALIDATION.md`'s banner now says the application has been shown
to work on live market data — and nothing more than that.

**Not done, and a different thing entirely** — a track record rather than a
proof:

4. `make collect-live` runs for at least a few days.
5. `make live-report` shows resolved live forecasts in all four cells
   (BTC 5m, BTC 20m, ETH 5m, ETH 20m) with enough independent observations that
   it stops labelling them INSUFFICIENT.

Even at that point the honest claim is *"the application works on live market
data and its probabilities are calibrated to within X over N observations"*. It
is **not** *"the model predicts the market"*. Those are different claims, the
second one is much stronger, and nothing in this repository supports it.

---

## 10. Live results

**Run 34950384459 — 15 September 2026, 09:04:07 to 10:16:07 UTC (72 minutes).**

```
FORECASTER LIVE MARKET PROOF
verdict          : PROVEN
scope            : Real venue market data, forecast and resolved end to end.
venue            : coinbase over websocket
data source      : LIVE
real BTC received: True
real ETH received: True
forecasts        : 132 generated, 108 resolved, 0 void
restart recovery : ok  (duplicate outcomes: 0)
monotonicity     : 0 violations
reconnects       : 0
per cell         :
  BTC-USD 5m : 54 generated, 48 resolved
  BTC-USD 20m: 12 generated,  6 resolved
  ETH-USD 5m : 54 generated, 48 resolved
  ETH-USD 20m: 12 generated,  6 resolved
stages           :
  [PASS] endpoint is a real venue — data_source=LIVE
  [PASS] live prices verified — 32 checks passed, 0 failed, 1,581 events
  [PASS] real BTC and ETH trades received
  [PASS] forecasts generated on live data — 132 from 22 sampling instants
  [PASS] forecasts expired and were scored — 108 resolved, 0 void
  [PASS] every horizon produced a resolved forecast — resolved at 300s, 1200s
  [PASS] feed stayed connected — 0 reconnects in 72 min (0.0/min)
  [PASS] probability never rises with the target — 0 violations in 110 pairs
  [PASS] predictions survive a restart — 132 of 132, chain intact
  [PASS] no outcome recorded twice after restart — 0 duplicates
  [PASS] validation report generated
```

### The per-cell report, and why none of it is quotable

| cell | forecasts | resolved | void | independent | Brier | ECE | sufficiency |
|---|---|---|---|---|---|---|---|
| BTC-USD 5m | 54 | 48 | 0 | **8** | 0.17773 | — | INSUFFICIENT |
| BTC-USD 20m | 12 | 6 | 0 | **1** | 0.13501 | — | INSUFFICIENT |
| ETH-USD 5m | 54 | 48 | 0 | **8** | 0.15634 | — | INSUFFICIENT |
| ETH-USD 20m | 12 | 6 | 0 | **1** | 0.09193 | — | INSUFFICIENT |

Read the **independent** column, not the Brier column. Eighteen independent
observations in total, one of them per twenty-minute cell. The ECE column is
empty because the report refuses to compute a calibration error below 100
independent observations — from eighteen, the confidence interval on that number
would be wider than the number.

ETH-USD 20m shows 100% accuracy on six forecasts derived from **one** instant.
That is a coin landing heads once, not a model working. The Brier scores are
printed because the code prints them; they are not evidence and must not be
quoted as though they were.

### What this does and does not establish

**A. Live-market operational correctness — ESTABLISHED.** Real exchange data is
ingested, parsed, quality-checked, stored, forecast against, expired, resolved
from recorded prints, and survives a restart without loss or duplication. The
probability curve never contradicts itself on live output. The feed stays up.

**B. Forecast skill — NOT ESTABLISHED, AND NOT ADDRESSED.** Nothing in this run
bears on whether the probabilities are calibrated or whether they beat the
baseline. That needs days, is measured by `forecaster live-report`, and the
learner stays quarantined behind its unchanged 750-observation threshold until
it is genuinely met.

Confusing A for B is the single most likely way this project could start lying
about itself, which is why the two are reported separately everywhere.

---

## 11. The track record, and why it takes a fortnight

The proof answered *does this work on a real market*. The separate question —
*are the probabilities any good* — is running now, and cannot be hurried.

**Actions → Live collection.** Every six hours, automatically. Each run collects
for 320 minutes and commits what it found.

The arithmetic that sets the pace: the honest unit is the **non-overlapping
observation**, and a day holds only 288 five-minute and 72 twenty-minute ones per
symbol. Against the learner's unchanged threshold of 750:

| horizon | independent observations per day | days to 750 |
|---|---|---|
| 5 minutes | ~212 | **~4** |
| 20 minutes | ~52 | **~14** |

Sampling faster does not move those numbers. Two forecasts five seconds apart at
a five-minute horizon share 295 of their 300 seconds, and six targets at one
instant are six views of one future price.

### Three details that make segmented collection honest

**Each segment self-contains.** A run stops *sampling* twenty minutes before it
stops *collecting*, so every forecast it starts also expires inside it. Without
that, each segment would end with a tail of forecasts that can never resolve and
are scored VOID — and across a fortnight that scheduling artefact would become
the dominant term in the void rate, looking exactly like a data-quality problem.

The cutoff is deliberately **off by default**, because it is wrong for a one-shot
run. `live-proof` budgets warm-up + twice the longest horizon precisely so that
forecasts can be made and then expire; taking another horizon off the end
double-counts that and would cut the proof from 22 sampling instants to about 10.

**Each segment then drops its ticks.** A resolved outcome already stores the
price it was scored at, immutably, so deleting the feed cannot alter a recorded
result — and it takes the database from megabytes to kilobytes. Measured on a
test segment: 5,004 KiB to 124 KiB, every prediction and outcome kept, hash chain
still verifying. `forecaster compact` refuses to run while any prediction is
still open, because those are exactly the ones deleting the feed would strand.

**The chain spans segments.** Predictions accumulate in one append-only log
across the whole collection, and `verify_chain` covers all of it — not one
segment at a time.

### Two ways the hand-off between segments can fail quietly

Both were found by reproducing them rather than by reading, and both are fixed.

**A rebase over the database used to lose a whole segment, silently.** The commit
step rebased onto the branch tip. Git cannot merge two versions of a SQLite file,
so a rebase that met one stopped on a conflict and left the repository
mid-rebase; the retry loop then retried straight back into the same wedge, and
the `git push` that followed reported *"Everything up-to-date"* and **exited
zero**. A green job, five hours of collection gone, nothing to notice. It now
replants instead — keep the three files this job owns, reset onto the tip, put
them back, commit, push, and retry the whole cycle on rejection. Any unrelated
commit pushed during the run survives, because the reset lands on it, and there
is no conflict to have because these three paths have exactly one author.

**The record cannot live in git forever.** Git stores a whole new copy of the
database every segment and the database itself grows, so the cost is quadratic
in segments. Measured, not estimated: a full 320-minute segment writes 876
prediction rows — 73 sampling instants per symbol across both horizons, six
ladder rungs each — at 1,213 bytes a row, compressing about 7.4×.

| running for | segments | git objects |
|---|---|---|
| 13.4 days — the 750-observation goal | 54 | ~200 MiB |
| 30 days | 120 | ~1.0 GiB |
| 90 days | 360 | ~8.7 GiB |

The goal is worth its 200 MiB. Leaving the schedule on afterwards is not, so the
workflow warns at 64 MiB and fails at 192 MiB — always *after* the segment is
committed and pushed, so the check can never cost evidence.

### What will come out of it

`forecaster live-report` will fill in Brier, log loss, calibration error and
probability-bucket performance per cell, and stop printing INSUFFICIENT once
each has enough independent observations to mean something.

Nothing is trained or tuned along the way. The first live sample is evidence, not
a tuning set: changing features or calibration because early numbers look
unflattering would convert the only out-of-sample data in existence into
in-sample data, irreversibly. If the answer turns out to be *"the probabilities
are roughly right and the learner does not beat the baseline"*, that is a real
result and it gets reported as one.

---

## 12. Reproducing it

Actions → **Live market proof** → Run workflow. About 72 minutes. The run commits
its own evidence to `reports/live-proof.json` and attaches it to the run.
