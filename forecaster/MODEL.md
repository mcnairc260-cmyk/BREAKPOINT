# MODEL.md — what the model actually does, in plain English

This document avoids jargon where it can and defines it where it cannot. If
anything here reads as more confident than the numbers support, that is a bug in
the document.

---

## 1. The question

You choose a price. The system answers one question:

> What is the chance that BTC (or ETH) is **above** that price in 5 minutes, and
> in 20 minutes?

The target can be above or below the current price. That matters: this is not a
system that predicts whether the price goes up. It predicts whether the price
ends up above **your** number.

**The exact rule**, used everywhere and never varied:

```
ABOVE   if   price at expiry  >  your target
BELOW   if   price at expiry  <= your target
```

Equality counts as BELOW. Any consistent rule works; an inconsistent one does
not. Exact ties are more common than you would think — people pick round numbers
and prices pin to round numbers — so ties are counted and reported, and if the
rate ever becomes material the rule can be revisited with evidence.

**The price at expiry** is the last trade on the venue at or before the expiry
instant, read from the recorded feed. It is never re-fetched from the exchange
later. A history that changes depending on when you look at it is not a history.

---

## 2. The one idea everything rests on

Most of the answer is not about direction. It is about **distance**.

Ask "will BTC be above $79,460 in five minutes" when it is at $79,434, and the
honest answer is close to a coin flip, because $26 is small compared with how far
BTC typically moves in five minutes. Ask about $80,500 and the answer is close to
zero, because that is a very long way in five minutes.

So the system does not try to guess where the price is going. It estimates **how
far the price is likely to move**, and then measures how far away your target is
in those units.

That measurement has a name in the code: **z**.

```
z  =  how far your target is, measured in standard deviations of the
      expected move over the horizon
```

- z = 0 → your target is the current price → about 50%
- z = +1 → your target is one typical move above → about 16% chance of clearing it
- z = −1 → one typical move below → about 84%
- z = +3 → three typical moves above → a fraction of one percent

**This is the whole product.** Everything else is refinement.

---

## 3. Why the number is usually near 50%, and why that is correct

Here is a real calculation from the system's own defaults, at BTC $79,434 with a
target of $79,460 (+$26):

| Horizon | One typical move | z | P(ABOVE) |
|---|---|---|---|
| 5 minutes | ~0.15% (~$122) | +0.19 | **~42%** |
| 20 minutes | ~0.31% (~$245) | +0.10 | **~46%** |

If a system showed you 62% for that target, it would be claiming to detect a
directional signal worth about half a typical move — an enormous edge at a
five-minute horizon. Nothing in short-horizon crypto price data supports that.

So: **calibrated five-minute probabilities for nearby targets sit near 50%, mostly
between 40% and 60%.** Probabilities move away from 50% because the target is far
away, not because the model has become confident about direction. If this product
routinely showed 70% for a target a few dollars away, that would be evidence of a
bug or a data leak, not of insight.

---

## 4. How the size of the likely move is estimated

This is the part that is genuinely forecastable. Volatility clusters: calm
minutes follow calm minutes, violent ones follow violent ones. That is a
well-established property of financial prices and it is what makes this product
possible at all.

The estimate combines:

1. **Realized volatility over several windows** — the last minute, the last five
   minutes, and the last hour, measured from one-second price bars. Short windows
   react fast; long windows are stable. Blending them beats any single one.
2. **An exponentially weighted estimate**, which reacts within seconds to a burst
   of activity.
3. **A time-of-week adjustment**, when one has been learned from real data.
   Crypto trades all day, but not evenly — Sunday at 04:00 UTC is reliably
   quieter than Wednesday at 14:00. Dividing out the usual pattern leaves what is
   unusual about right now.
4. **A jump adjustment.** A single large one-off move and a genuine rise in
   volatility look the same to a naive estimator, but only one of them persists.
   The system separates them, so it stops forecasting wide ranges twenty minutes
   after a one-off spike.

The result is scaled to the horizon by the square root of time: a 20-minute move
is about twice a 5-minute move, not four times.

---

## 5. The shape of the distribution

Knowing the typical size of a move is not enough. You also need to know how often
much larger moves happen, because that is where an ambitious target lands.

Crypto returns have **fat tails**: extreme moves happen far more often than a
normal bell curve predicts. A system assuming a bell curve would report
reassuringly tiny probabilities for moves that actually happen most weeks.

The system uses, in order of preference:

1. **The actual historical shape.** Past moves, divided by what the volatility
   model expected at the time. These standardised leftovers are pooled across all
   of history, so the shape is estimated from a great deal of data even though
   the volatility is estimated fresh each time. (The technical name is *filtered
   historical simulation*.)
2. **A fitted extreme-value tail** beyond roughly the 95th percentile, where
   history runs out. Without this, a target beyond anything seen before would get
   a probability of exactly zero — a claim of impossibility, and the most
   embarrassing thing a probability product can print.
3. **A Student-t fallback** before enough history exists. Fatter-tailed than a
   bell curve, which is the safe direction to be wrong in.

**No probability is ever exactly 0% or 100%.** There is a floor in the model and
a second one enforced by the database.

---

## 6. Drift is zero, deliberately

The model assumes the expected move over the next five or twenty minutes is
**exactly zero**. Not "small". Zero.

This is not laziness. It is the honest starting point at these horizons, and it
is a genuinely hard benchmark to beat. Assuming otherwise is where most
forecasting projects begin to mislead themselves: a drift estimated from recent
data is almost entirely noise, and building it in creates the appearance of
directional skill that is not there.

---

## 7. The models, in order

| Name | What it is | Needs training data |
|---|---|---|
| `baseline-t` | The volatility model above. Zero drift, fat tails. | **No** |
| `logistic-z` | A simple linear **correction** to the baseline. | Yes |
| `lgbm-monotone` | A gradient-boosted **correction** to the baseline. | Yes |

The word **correction** is doing real work. The learned models do not produce a
probability. They produce an adjustment to the baseline's probability:

```
final answer  =  baseline answer  +  learned correction
```

Three things follow, and all of them matter:

1. **"Does machine learning help?" becomes a question with a testable answer.**
   It is exactly the question of whether the correction is zero. A standalone
   classifier given the distance as an input would rediscover the baseline, score
   almost identically, and be reported as "the model beats the volatility
   baseline" — a claim about nothing.
2. **The answer can never contradict itself.** A higher target must never get a
   higher chance of being cleared. The baseline guarantees this by construction,
   and the correction is constrained so that it cannot undo it.
3. **It fails safely.** In market conditions unlike anything in training, the
   correction shrinks and the answer falls back toward the baseline, instead of a
   decision tree extrapolating confidently off the end of what it has seen.

**A learned model is only trained when there are at least 750 genuinely
independent observations.** With less, twelve inputs fitted to a few hundred
points will find patterns that are not there — and will validate, because the
validation set is just as small.

---

## 8. Calibration

Calibration means: when the system says 70%, it should be right about 70% of the
time.

After a model is trained, its probabilities are compared against what actually
happened on a held-out slice of time it never saw, and a small adjustment is
fitted if one helps. Three adjustments are tried, plus **doing nothing** — and
doing nothing frequently wins. "Not calibrated, because calibration did not
improve anything" is a legitimate and honestly reported result.

One rule governs the whole calibration layer:

> **The adjustment may only look at the probability itself.**

Never at your target price, never at how far away it is. It is tempting to fit
separate adjustments by distance, because errors genuinely do vary with distance
— and it is exactly the wrong thing to do, because it would break the guarantee
that a higher target never gets a higher probability. Where the model is wrong by
distance, that gets fixed in the model, not papered over in the calibrator.

---

## 9. Confidence

`LOW` / `MODERATE` / `HIGH` is not a restatement of the probability. A
well-calibrated 55% is a good forecast; a 75% built on a stale feed is not.

Confidence is computed from things that actually bear on reliability:

- how fresh the market data is
- how many of the twelve inputs could be computed at all
- whether the order book is present and sane
- **how unusual current conditions are** compared with the training data
- how much the baseline and the learned model disagree
- whether your target is beyond the range where calibration has any evidence

**Confidence never changes the probability.** A LOW-confidence 62% is still a
62%. Shrinking it toward 50% would destroy calibration and would break the
target-ordering guarantee at the same time.

The thresholds are currently **provisional** and the interface says so. Making
them empirical requires showing that the three buckets have measurably different
scores, which needs live outcomes that do not exist yet. The Performance page
reports whether the buckets separate, so the claim can be checked rather than
assumed.

---

## 10. What this system does not do

- It does not know where the price is going.
- It does not have an edge, and does not claim one. The volatility baseline is
  hard to beat because there is very little short-horizon directional information
  to find.
- It is not investment advice, and produces no buy or sell signal.
- **It has never been validated against a real market.** See `VALIDATION.md`.
  Everything measured so far was measured on simulated and replayed data, because
  the environment this was built in cannot reach any exchange.

---

## 11. What would make it better

In the order that would actually help:

1. **Real data.** A week of continuous collection makes the 5-minute learner
   trainable; about a month makes the 20-minute one trainable. Nothing else on
   this list matters until that exists.
2. **Fitted seasonality.** The time-of-week volatility pattern is real, stable
   and free to exploit — but it must be estimated from real data, so it ships as
   flat.
3. **Empirical confidence thresholds**, once there are enough live outcomes to
   show whether the buckets separate.
4. **Perpetual-futures basis and funding rates**, which carry genuine information
   about positioning and predict liquidation cascades — which are volatility.
5. **A second venue**, as a cross-check on the first, which is how a bad feed gets
   caught.

---

## Appendix — a bias found and fixed during the build

Worth recording, because it is the single largest error the project has caught in
itself, and because the same trap is waiting in any system that measures
volatility from traded prices.

**What went wrong.** The volatility estimator read one-second bars built from
trade prices. Measured against a simulator where the true volatility is known,
it came out **1.735 times too large** — a 74% overestimate.

**Why.** Bid–ask bounce. A traded price is not the "true" price; it is the true
price plus or minus roughly half the spread, depending on whether the trade hit
the bid or lifted the offer. Consecutive one-second closes therefore bounce
across the spread even when nothing has moved, and every one of those bounces was
being counted as volatility.

**Why it mattered here specifically.** An inflated volatility makes every target
look *closer* in standard deviations than it really is, which drags every
probability toward 50%. The product would have been systematically
under-confident — and would have looked reassuringly humble while being wrong.

**The fix**, in two parts, both standard econometrics rather than anything fitted
to the simulator:

1. **Use midpoint quotes where they exist.** A midpoint sits between the bid and
   the offer, so it does not move when a trade happens to hit one side.
2. **Where only trades are available, apply the first-order autocovariance
   correction** (Zhou; Hansen and Lunde). Bounce induces negative
   autocorrelation — an up-tick from lifting the offer tends to be followed by a
   down-tick from hitting the bid — while genuine price moves do not. Adding
   twice the first autocovariance removes the noise and leaves the signal.

**Result**, over six independent runs against a known truth:

| | ratio of estimated to true volatility |
|---|---|
| Before | 1.735 |
| Correction applied to midpoints too (over-corrected) | 0.915 |
| **Correction applied only to trade prices** | **0.954** (range 0.84–1.07) |

The remaining spread is ordinary estimation noise from a finite sample, not bias.

This is also the clearest illustration of what the simulator is *for*. It cannot
tell you whether the product has an edge. It can tell you that your volatility
estimator is 74% wrong, because it is the only place where the true answer is
known.
