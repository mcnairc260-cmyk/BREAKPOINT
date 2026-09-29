"""Does this feed actually say what we think it says?

Between "the socket connected" and "the forecast is trustworthy" there is a
layer that almost never gets checked and fails quietly when it is wrong: the
feed is fine, and the *interpretation* of it is not. A price scaled by a hundred,
a symbol that silently mapped to the wrong product, a timestamp in milliseconds
read as seconds, bid and ask the wrong way round — none of these raise an
exception. They produce a working application that is confidently wrong, which is
the failure this whole repository is built to avoid.

So this module asks a fixed list of questions of whatever feed it is pointed at,
and answers each one with the number it actually observed. It is the same list
for a real exchange and for the conformance double, which is the point: the
checks are written once, run here against the double, and run unchanged by the
user against Coinbase.

Every check reports PASS, WARN or FAIL:

* **PASS** — observed and within bounds.
* **WARN** — observed and unusual, or not observable on this transport. A
  one-second REST poll cannot show sub-second quote updates, and calling that a
  failure would be wrong.
* **FAIL** — observed and impossible. A negative price, a crossed book, a
  timestamp from next week. Any FAIL exits non-zero.

The thresholds are deliberately loose. This is a correctness check, not a quality
metric: it is trying to catch a factor of a hundred, not a basis point.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from itertools import pairwise
from typing import Any

from forecaster.clock import iso, now_ns
from forecaster.marketdata.provider import MarketDataProvider
from forecaster.types import NS_PER_SECOND, BookSnapshot, DataSource, Quote, Side, Trade

#: A price outside this range for a major crypto pair means the units are wrong,
#: not that the market moved. BTC has never been below $50 nor above $10m, and
#: ETH sits inside the same window with room to spare.
PLAUSIBLE_PRICE = (1.0, 10_000_000.0)

#: An exchange timestamp further than this from local time means one of the two
#: clocks is wrong or the unit was misread. Ten minutes is far wider than any
#: real venue's skew and far narrower than a units error.
MAX_CLOCK_GAP_NS = 600 * NS_PER_SECOND

#: A spread wider than this on a major pair means the book is broken, halted, or
#: being read wrongly.
MAX_PLAUSIBLE_SPREAD_BPS = 500.0

#: Past this with no event at all, the feed is not usable, whatever it claims.
STALE_FEED_NS = 30 * NS_PER_SECOND


@dataclass
class Check:
    """One question, its verdict, and the number that produced it."""

    name: str
    status: str  # PASS | WARN | FAIL
    detail: str
    observed: Any = None

    @property
    def failed(self) -> bool:
        return self.status == "FAIL"


@dataclass
class SymbolObservation:
    """Everything seen for one symbol during the sampling window."""

    symbol: str
    trades: list[Trade] = field(default_factory=list)
    quotes: list[Quote] = field(default_factory=list)
    books: list[BookSnapshot] = field(default_factory=list)

    @property
    def last_trade(self) -> Trade | None:
        return self.trades[-1] if self.trades else None

    @property
    def last_quote(self) -> Quote | None:
        return self.quotes[-1] if self.quotes else None

    def to_dict(self) -> dict[str, Any]:
        trade, quote = self.last_trade, self.last_quote
        return {
            "symbol": self.symbol,
            "trades": len(self.trades),
            "quotes": len(self.quotes),
            "books": len(self.books),
            "last_trade_price": trade.price if trade else None,
            "last_trade_size": trade.size if trade else None,
            "last_trade_side": trade.side.value if trade else None,
            "last_trade_exchange_ns": trade.exchange_ns if trade else None,
            "last_trade_received_ns": trade.received_ns if trade else None,
            "last_trade_exchange_time": iso(trade.exchange_ns) if trade else None,
            "bid": quote.bid if quote else None,
            "ask": quote.ask if quote else None,
            "midpoint": quote.mid if quote else None,
            "spread": (quote.ask - quote.bid) if quote else None,
            "spread_bps": (
                (quote.ask - quote.bid) / quote.mid * 10_000.0 if quote and quote.mid > 0 else None
            ),
            "quote_exchange_ns": quote.exchange_ns if quote else None,
            "quote_received_ns": quote.received_ns if quote else None,
        }


@dataclass
class LiveCheckReport:
    venue: str
    transport: str
    data_source: str
    ws_url: str | None
    rest_url: str | None
    seconds: float
    started_ns: int
    finished_ns: int
    events: int
    symbols: dict[str, dict[str, Any]]
    checks: list[Check]
    health: dict[str, Any]
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and not any(check.failed for check in self.checks)

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.failed]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.status == "WARN"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "venue": self.venue,
            "transport": self.transport,
            "data_source": self.data_source,
            "ws_url": self.ws_url,
            "rest_url": self.rest_url,
            "seconds": self.seconds,
            "started": iso(self.started_ns),
            "finished": iso(self.finished_ns),
            "events": self.events,
            "symbols": self.symbols,
            "checks": [asdict(c) for c in self.checks],
            "health": self.health,
            "error": self.error,
        }


def _check(name: str, ok: bool, detail: str, observed: Any = None, *, warn: bool = False) -> Check:
    status = "PASS" if ok else ("WARN" if warn else "FAIL")
    return Check(name=name, status=status, detail=detail, observed=observed)


def run_checks(
    observations: dict[str, SymbolObservation],
    *,
    requested: Sequence[str],
    transport: str,
    at_ns: int | None = None,
) -> list[Check]:
    """The fixed list of questions. Pure, so it is testable without a socket."""
    moment = at_ns if at_ns is not None else now_ns()
    checks: list[Check] = []
    polled = transport == "poll"

    for symbol in requested:
        obs = observations.get(symbol)
        tag = f"[{symbol}]"

        if obs is None or (not obs.trades and not obs.quotes):
            checks.append(
                _check(f"{tag} data received", False, "no trades and no quotes arrived", 0)
            )
            continue

        # -- symbol mapping --------------------------------------------------
        # Every event carries the symbol it was filed under. A venue whose
        # product ids differ from ours (Binance's BTCUSDT, Kraken's XBT/USD) is
        # mapped in the adapter, and this is where a broken mapping surfaces.
        # Annotated, because unpacking two differently-typed lists into one
        # tuple widens the element type to `object` and loses `.symbol`.
        seen: list[Trade | Quote] = [*obs.trades, *obs.quotes]
        wrong = {e.symbol for e in seen if e.symbol != symbol}
        checks.append(
            _check(
                f"{tag} symbol mapping",
                not wrong,
                f"all events filed as {symbol}" if not wrong else f"also saw {sorted(wrong)}",
                sorted(wrong) or symbol,
            )
        )

        # -- trades ----------------------------------------------------------
        if obs.trades:
            prices = [t.price for t in obs.trades]
            low, high = min(prices), max(prices)
            plausible = PLAUSIBLE_PRICE[0] <= low and high <= PLAUSIBLE_PRICE[1]
            checks.append(
                _check(
                    f"{tag} trade price plausible",
                    plausible,
                    f"{low:,.2f} to {high:,.2f} over {len(prices)} trades",
                    {"low": low, "high": high, "n": len(prices)},
                )
            )
            checks.append(
                _check(
                    f"{tag} trade price positive",
                    low > 0.0 and all(math.isfinite(p) for p in prices),
                    "every trade price is finite and above zero",
                    low,
                )
            )
            checks.append(
                _check(
                    f"{tag} trade size positive",
                    all(t.size > 0.0 for t in obs.trades),
                    "every trade size is above zero",
                    min(t.size for t in obs.trades),
                )
            )

            # Decimal precision. A feed truncated to whole dollars, or parsed
            # through a float32, shows up as every price being an integer.
            fractional = sum(1 for p in prices if abs(p - round(p)) > 1e-9)
            checks.append(
                _check(
                    f"{tag} price has sub-unit precision",
                    fractional > 0,
                    f"{fractional} of {len(prices)} prices carry a fractional part",
                    fractional,
                    warn=True,
                )
            )

            # The aggressor side. Coinbase publishes the maker's side and the
            # adapter inverts it; a feed where every trade is one side means the
            # inversion or the field is wrong.
            sides = {t.side for t in obs.trades}
            known = sides - {Side.UNKNOWN}
            checks.append(
                _check(
                    f"{tag} aggressor side published",
                    len(known) > 0,
                    f"sides seen: {sorted(s.value for s in sides)}",
                    sorted(s.value for s in sides),
                    warn=True,
                )
            )

            # -- timestamps --------------------------------------------------
            last = obs.trades[-1]
            gap = abs(moment - last.exchange_ns)
            checks.append(
                _check(
                    f"{tag} exchange timestamp sane",
                    gap < MAX_CLOCK_GAP_NS,
                    f"last trade stamped {gap / NS_PER_SECOND:.1f}s from local now",
                    gap / NS_PER_SECOND,
                )
            )
            # Receipt must not precede the exchange stamp by more than a plausible
            # clock skew. The other direction is normal latency.
            ahead = max(t.exchange_ns - t.received_ns for t in obs.trades)
            checks.append(
                _check(
                    f"{tag} receipt after exchange stamp",
                    ahead < 5 * NS_PER_SECOND,
                    f"worst case the exchange stamp leads receipt by {ahead / NS_PER_SECOND:.2f}s",
                    ahead / NS_PER_SECOND,
                )
            )
            receipts = [t.received_ns for t in obs.trades]
            checks.append(
                _check(
                    f"{tag} receipt order monotone",
                    all(b >= a for a, b in pairwise(receipts)),
                    "events arrived in the order they were read off one connection",
                    len(receipts),
                )
            )

            # -- freshness ---------------------------------------------------
            age = moment - last.received_ns
            checks.append(
                _check(
                    f"{tag} feed fresh",
                    age < STALE_FEED_NS,
                    f"last event received {age / NS_PER_SECOND:.1f}s ago",
                    age / NS_PER_SECOND,
                )
            )
        else:
            checks.append(
                _check(f"{tag} trades received", False, "no trades arrived in the window", 0)
            )

        # -- quotes ----------------------------------------------------------
        if obs.quotes:
            crossed = [q for q in obs.quotes if q.bid >= q.ask]
            checks.append(
                _check(
                    f"{tag} book not crossed",
                    not crossed,
                    "bid is below ask on every quote"
                    if not crossed
                    else f"{len(crossed)} quotes had bid >= ask",
                    len(crossed),
                )
            )
            checks.append(
                _check(
                    f"{tag} bid and ask positive",
                    all(q.bid > 0.0 and q.ask > 0.0 for q in obs.quotes),
                    "every bid and ask is above zero",
                    min(min(q.bid, q.ask) for q in obs.quotes),
                )
            )
            usable = [q for q in obs.quotes if q.ask > q.bid > 0.0]
            if usable:
                mids = [q.mid for q in usable]
                between = all(q.bid <= q.mid <= q.ask for q in usable)
                checks.append(
                    _check(
                        f"{tag} midpoint between bid and ask",
                        between,
                        f"midpoint {mids[-1]:,.2f} sits inside the spread",
                        mids[-1],
                    )
                )
                spreads = [(q.ask - q.bid) / q.mid * 10_000.0 for q in usable]
                worst = max(spreads)
                checks.append(
                    _check(
                        f"{tag} spread plausible",
                        worst <= MAX_PLAUSIBLE_SPREAD_BPS,
                        f"widest spread seen was {worst:.2f} bps",
                        worst,
                    )
                )
                # Trade price against midpoint. A mismatch of more than a few
                # percent means the two feeds are not describing one instrument.
                if obs.trades:
                    ratio = obs.trades[-1].price / mids[-1]
                    checks.append(
                        _check(
                            f"{tag} trade price agrees with midpoint",
                            0.95 < ratio < 1.05,
                            f"last trade is {(ratio - 1.0) * 100.0:+.3f}% from the midpoint",
                            ratio,
                        )
                    )
        else:
            checks.append(
                _check(
                    f"{tag} quotes received",
                    False,
                    "no quotes arrived — bid, ask and midpoint are unavailable",
                    0,
                    warn=polled,
                )
            )

        # -- depth -----------------------------------------------------------
        checks.append(
            _check(
                f"{tag} order book received",
                bool(obs.books),
                f"{len(obs.books)} book snapshots"
                if obs.books
                else "no order book snapshots arrived",
                len(obs.books),
                warn=True,
            )
        )

    return checks


async def live_check(
    provider: MarketDataProvider,
    *,
    symbols: tuple[str, ...],
    seconds: float = 30.0,
    ws_url: str | None = None,
    rest_url: str | None = None,
    transport: str = "websocket",
) -> LiveCheckReport:
    """Sample a feed for `seconds`, then answer every question about it."""
    observations = {s: SymbolObservation(symbol=s) for s in symbols}
    started = now_ns()
    events = 0
    error: str | None = None

    async def consume() -> None:
        nonlocal events
        deadline = started + int(seconds * NS_PER_SECOND)
        async for event in provider.stream(symbols):
            events += 1
            obs = observations.get(event.symbol)
            if obs is not None:
                if isinstance(event, Trade):
                    obs.trades.append(event)
                elif isinstance(event, Quote):
                    obs.quotes.append(event)
                elif isinstance(event, BookSnapshot):
                    obs.books.append(event)
            if now_ns() >= deadline:
                return

    try:
        # A provider whose host is unreachable reconnects for ever by design, so
        # the timeout is what turns "hangs" into "reports why".
        await asyncio.wait_for(consume(), timeout=seconds + 15.0)
    except TimeoutError:
        if events == 0:
            error = (
                f"no market data in {seconds + 15.0:.0f}s. "
                f"last provider error: {provider.health.last_error or 'none recorded'}"
            )
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        await provider.close()

    finished = now_ns()
    checks = run_checks(observations, requested=symbols, transport=transport, at_ns=finished)
    health = provider.health
    return LiveCheckReport(
        venue=provider.venue,
        transport=transport,
        data_source=provider.data_source.value,
        ws_url=ws_url,
        rest_url=rest_url,
        seconds=(finished - started) / NS_PER_SECOND,
        started_ns=started,
        finished_ns=finished,
        events=events,
        symbols={s: o.to_dict() for s, o in observations.items()},
        checks=checks,
        health={
            "connected": health.connected,
            "reconnects": health.reconnects,
            "malformed_messages": health.malformed_messages,
            "sequence_gaps": health.sequence_gaps,
            "rate_limited": health.rate_limited,
            "last_error": health.last_error,
        },
        error=error,
    )


def format_report(report: LiveCheckReport) -> str:
    """The human-readable form. What a person runs this command to read."""
    lines: list[str] = []
    add = lines.append
    add("")
    add(f"  LIVE DATA CHECK — {report.venue} over {report.transport}")
    add(f"  {'─' * 68}")
    add(f"  endpoint     {report.ws_url or report.rest_url or '(default)'}")
    add(f"  recorded as  {report.data_source.upper()}")
    if report.data_source != DataSource.LIVE.value:
        add("               ^ not a recognised venue host, so these rows can")
        add("                 never enter a live metric. See venues/endpoints.py.")
    add(f"  sampled      {report.seconds:.1f}s, {report.events:,} events")
    add("")

    if report.error:
        add(f"  ERROR: {report.error}")
        add("")

    for symbol, data in report.symbols.items():
        add(f"  {symbol}")
        add(
            f"    trades {data['trades']:>6,}   quotes {data['quotes']:>6,}   "
            f"books {data['books']:>4,}"
        )
        if data["last_trade_price"] is not None:
            add(
                f"    last trade   {data['last_trade_price']:>14,.2f}  "
                f"size {data['last_trade_size']:.8f}  {data['last_trade_side']}"
            )
            add(f"    stamped      {data['last_trade_exchange_time']}")
        if data["bid"] is not None:
            add(
                f"    bid / ask    {data['bid']:>14,.2f} / {data['ask']:,.2f}   "
                f"mid {data['midpoint']:,.2f}"
            )
            add(f"    spread       {data['spread']:>14,.4f}  ({data['spread_bps']:.2f} bps)")
        add("")

    failures = report.failures
    warnings = report.warnings
    passed = [c for c in report.checks if c.status == "PASS"]
    add(f"  checks: {len(passed)} passed, {len(warnings)} warned, {len(failures)} failed")
    for check in report.checks:
        if check.status == "PASS":
            continue
        add(f"    {check.status:<5} {check.name} — {check.detail}")
    add("")
    if report.health["reconnects"]:
        add(f"  reconnects during the window: {report.health['reconnects']}")
    if report.health["malformed_messages"]:
        add(f"  malformed messages discarded: {report.health['malformed_messages']}")
    add("  RESULT: " + ("PASS" if report.ok else "FAIL"))
    add("")
    return "\n".join(lines)
