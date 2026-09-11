# LIVE_VALIDATION.md — the real-market validation phase

> ## STATUS: BLOCKED ON NETWORK ACCESS, NOT ON CODE
>
> **No real BTC or ETH market data has been ingested. No live forecast has been
> made. No live forecast has been resolved. This system still has no real-market
> track record.**
>
> The reason is external and was verified again at the start of this phase:
> every exchange host is refused by this environment's egress proxy. The work
> that could be done without a venue was done, and the one thing that needs a
> venue is one command away.

---

## 1. What was actually tried

Coinbase first, then Kraken, then Binance, over both transports. Every attempt,
verbatim:

```
$ forecaster live-check --seconds 30 --transport websocket
  ERROR: no market data in 25s.
  last provider error: InvalidProxyStatus: proxy rejected connection: HTTP 403

$ forecaster live-check --seconds 30 --transport poll
  ERROR: no market data in 23s.
  last provider error: ProviderError: coinbase ticker request failed: 403 Forbidden

$ forecaster live-check --venue kraken --transport poll
  ERROR: last provider error: ProxyError: 403 Forbidden

$ forecaster live-check --venue binance --transport poll
  ERROR: last provider error: ProxyError: 403 Forbidden
```

At the socket level:

```
$ curl -v https://api.exchange.coinbase.com/products/BTC-USD/ticker
> CONNECT api.exchange.coinbase.com:443 HTTP/1.1
< HTTP/1.1 403 Forbidden
```

This is an organisation egress policy, not a bug, a rate limit, or a missing
credential. The environment's own documentation says not to route around a policy
denial, so it was not routed around. `api.exchange.coinbase.com`,
`ws-feed.exchange.coinbase.com`, `api.kraken.com`, `ws.kraken.com` and
`api.binance.com` are all refused identically.

**The gap is therefore exactly one thing: network egress to an exchange.** Every
other part of real-market validation is implemented, and most of it is now
tested against a real socket.

---

## 2. What to run on a normal network

Three commands, in order. Nothing else is needed and nothing needs editing.

```bash
cd forecaster
make setup                    # once

# 1. Prove the venue. ~30 seconds. Exits non-zero if anything is wrong.
make live-check

# 2. Collect. Runs until you stop it. Leave it running for days.
FORECASTER_PROVIDER=live FORECASTER_VENUE=coinbase make collect-live

# 3. At any point, from another terminal:
make live-status              # is it running, and how far along
make live-report              # the validation report
```

`make live-check ARGS="--transport poll"` if WebSockets are blocked where you
are; the polling transport is a real transport, not a stub.

### What `live-check` actually verifies

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

## 3. What was proved here, without a venue

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

## 4. Two defects found and fixed during this phase

Both were pre-existing, both were reachable in production, and neither would have
announced itself.

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

---

## 5. Live and simulated cannot be mixed

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

## 6. The learner is still quarantined, and the threshold is unchanged

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

## 7. The rule that governs the first live run

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

## 8. What would make this COMPLETE

Run the three commands in section 2 on a network that can reach Coinbase, then:

1. `make live-check` passes with real prices for BTC-USD and ETH-USD.
2. `make collect-live` runs for at least a few days.
3. `make live-report` shows resolved live forecasts in all four cells
   (BTC 5m, BTC 20m, ETH 5m, ETH 20m).
4. Paste that report into section 9 below, and update `VALIDATION.md`'s banner —
   **only then**, and only to say what the numbers actually support.

Even at that point the honest claim is *"the application works on live market
data and its probabilities are calibrated to within X over N observations"*. It
is **not** *"the model predicts the market"*. Those are different claims, the
second one is much stronger, and nothing in this repository supports it.

---

## 9. Live results

*(empty — no live forecasts have been made)*
