# Venue fixtures

**These are schema fixtures written from each exchange's public API
documentation. They are not captures of real traffic.**

That distinction matters and is stated here rather than assumed. A fixture
proves that the adapter parses the documented shape — field names, types, the
direction of the maker/aggressor flag, how a missing field is handled. It proves
nothing about whether the endpoint still behaves this way today, or whether the
connection can even be made.

The build environment for this project cannot reach any exchange: every venue
host is blocked by network policy, and WebSocket upgrades are unsupported
through its proxy. So no real capture could be taken here, and inventing one and
calling it real would be worse than having none.

`scripts/smoke_live.py` is the check that closes the gap. Run it from a machine
with ordinary network access; it takes about thirty seconds and reports what it
actually saw.

Sources:

- Coinbase Exchange WebSocket and REST — `matches`, `ticker`, `level2` channels,
  `/products/{id}/ticker`, `/products/{id}/trades`, `/products/{id}/book`.
- Binance spot WebSocket — `<symbol>@trade`, `<symbol>@bookTicker`.
- Kraken WebSocket v2 — `trade` and `ticker` channels.
