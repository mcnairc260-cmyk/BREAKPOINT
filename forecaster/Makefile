# Forecaster.
#
# `make verify` is the one command. It is what CI runs and what a change has to
# pass before it is believed.

# bash, not the default /bin/sh. The `dev` target uses `set -m` and a trap, and
# dash prints "can't access tty; job control turned off" and does not clean up
# the way the trap intends.
SHELL := /bin/bash

ENGINE := engine
WEB    := web
PY     := $(ENGINE)/.venv/bin/python
BIN    := $(ENGINE)/.venv/bin

.PHONY: help setup verify test lint format typecheck offline-suite web-verify \
        conformance live-proof probe-venues live-check collect-live live-report live-status \
        demo dev serve smoke stop clean

help:
	@echo "setup         create the Python venv and install both projects"
	@echo "verify        everything: lint, types, tests, offline suite, web build"
	@echo "dev           run the engine and the web app together (ctrl-c stops both)"
	@echo "serve         run the engine alone"
	@echo ""
	@echo "  the live path"
	@echo "live-proof    THE ONE COMMAND: prove the system on a real market (~1h)"
	@echo "              make live-proof PROVIDER=kraken   picks a specific venue"
	@echo "probe-venues  which exchanges can this machine reach (~15s)"
	@echo "live-check    connect to a real exchange and verify its prices (~30s)"
	@echo "collect-live  collect real market data and forecast against it, for days"
	@echo "live-status   collection progress and feed health"
	@echo "live-report   the real-market validation report"
	@echo "conformance   the same path against a local server, no exchange needed"
	@echo "smoke         prove a venue adapter against the real exchange (~30s)"
	@echo "demo          simulate -> train -> backtest, end to end"
	@echo "test          Python tests only"
	@echo "stop          stop anything left running"
	@echo "clean         remove generated data, artifacts and build output"

setup:
	python3 -m venv $(ENGINE)/.venv
	$(PY) -m pip install --quiet --upgrade pip
	$(PY) -m pip install --quiet -e "$(ENGINE)[dev]"
	mkdir -p $(ENGINE)/data $(ENGINE)/artifacts reports
	cd $(WEB) && npm install --no-audit --no-fund
	@echo ""
	@echo "ready. 'make dev' starts both, or 'make demo' runs the pipeline end to end."

lint:
	$(BIN)/ruff check $(ENGINE)/src $(ENGINE)/tests
	$(BIN)/ruff format --check $(ENGINE)/src $(ENGINE)/tests

format:
	$(BIN)/ruff check --fix $(ENGINE)/src $(ENGINE)/tests
	$(BIN)/ruff format $(ENGINE)/src $(ENGINE)/tests

typecheck:
	cd $(ENGINE) && .venv/bin/mypy src/forecaster

test:
	cd $(ENGINE) && .venv/bin/python -m pytest -q

offline-suite:
	cd $(ENGINE) && .venv/bin/forecaster verify --seeds 6 --output ../reports/verify.json

# The live path, proved without an exchange: a server speaking the venue's wire
# protocol on localhost, and the real adapter connecting to it over a real
# socket. This is what stops a change to the live path from failing silently in
# an environment that cannot reach a venue — which is every CI runner here.
conformance:
	cd $(ENGINE) && .venv/bin/forecaster conformance --seconds 60 \
		--output ../reports/conformance.json

web-verify:
	cd $(WEB) && npm run typecheck && npm run lint && npm run test && npm run build

# `typecheck` belongs here. The help text promised types were checked and this
# target did not run mypy, which is the kind of gap that makes a green build
# mean less than it says.
verify: lint typecheck test offline-suite conformance web-verify
	@echo ""
	@echo "verified. Everything this target runs is simulated, replayed or conformance"
	@echo "data — it proves the code, not the market."
	@echo ""
	@echo "Live-market operational correctness IS proven separately: Coinbase,"
	@echo "15 Sep 2026, 132 forecasts, 108 resolved. See reports/live-proof.json."
	@echo "Forecast skill is NOT proven and needs days of collection. Two different"
	@echo "claims — VALIDATION.md keeps them apart."

demo:
	cd $(ENGINE) && .venv/bin/forecaster simulate --duration 288000 --regime realistic --anchor-now --reset
	cd $(ENGINE) && .venv/bin/forecaster train --data-source simulated --venue simulator
	cd $(ENGINE) && .venv/bin/forecaster backtest --data-source simulated --venue simulator \
		--json ../reports/backtest.json

serve:
	cd $(ENGINE) && .venv/bin/forecaster serve

# The venue adapter against a real exchange. Uses the venv interpreter, because
# the script needs httpx and websockets and a bare `python` almost certainly has
# neither — an earlier version of this instruction told people to run it with
# the system Python and it failed on import.
smoke:
	$(PY) scripts/smoke_live.py $(ARGS)

# ---------------------------------------------------------------------------
# The live path. These need a network that can reach an exchange.
# ---------------------------------------------------------------------------

# The whole proof, unattended, in one command. Start it and walk away.
#
# It takes about an hour and nearly all of that is waiting: thirty minutes before
# the volatility model will speak at all, then twenty for the longer horizon to
# expire. Neither can be shortened without weakening something — there is a
# faster path through 60-second candles and it is deliberately not taken, because
# those candles cannot feed the one-second bars the estimator reads.
#
# Exits 0 only on PROVEN: live venue data in, forecasts out, horizons expired,
# outcomes recorded, survived a restart. Anything else exits non-zero, including
# a run that completed perfectly against something that is not a venue.
# PROVIDER=kraken picks a venue; with neither PROVIDER nor --venue it probes and
# uses the first exchange that answers with an adapter, which is what you want on
# a network you do not control.
PROVIDER ?=
LIVE_PROOF_VENUE := $(if $(PROVIDER),--venue $(PROVIDER),--auto)

live-proof:
	cd $(ENGINE) && .venv/bin/forecaster live-proof $(LIVE_PROOF_VENUE) \
		--json ../reports/live-proof.json $(ARGS)

# Fifteen seconds, and it answers "is it me, the network, or the venue?" for
# every exchange at once — DNS, TCP, TLS, REST and the WebSocket upgrade. Run it
# before anything else when market data will not arrive.
probe-venues:
	cd $(ENGINE) && .venv/bin/forecaster probe-venues \
		--json ../reports/venue-reachability.json $(ARGS)

# Step one, always. Connects to the venue and verifies that every price it
# reports means what the code thinks it means: symbol mapping, precision, both
# timestamps, bid, ask, midpoint, spread, freshness. Exits non-zero on any
# impossible value, so it is safe to put in front of a long collection run.
live-check:
	cd $(ENGINE) && .venv/bin/forecaster live-check --seconds 30 \
		--json ../reports/live-check.json $(ARGS)

# Step two. Runs until stopped. Each horizon is sampled once per horizon, so no
# two forecasts from one symbol overlap and the row count is the evidence count.
# Safe to restart: forecasts already written are resolved on the next start.
collect-live:
	cd $(ENGINE) && .venv/bin/forecaster collect-live $(ARGS)

live-status:
	cd $(ENGINE) && .venv/bin/forecaster live-status $(ARGS)

live-report:
	cd $(ENGINE) && .venv/bin/forecaster live-report \
		--json ../reports/live-validation.json $(ARGS)

# Both processes, with cleanup that actually happens.
#
# Two earlier attempts did not work, and both are worth recording because they
# look correct:
#
#   1. `forecaster serve & npm run dev` — ctrl-c killed the web server and left
#      the engine running on 8099, so the next `make dev` failed with "address
#      already in use".
#   2. `trap 'kill 0' INT TERM EXIT` — reads well, and did not stop either
#      child. `kill 0` signals the caller's process group, and the children are
#      not reliably in it once make, a shell and npm have each forked.
#
# What works is remembering the two pids and killing them by name, then falling
# back to the ports for anything they spawned that outlived them (npm forks
# `next-server` as a grandchild, which is exactly the case that leaks).
dev:
	@echo "engine on http://127.0.0.1:8099   ui on http://127.0.0.1:3220"
	@echo "ctrl-c stops both"
	@engine_pid=""; web_pid=""; \
	cleanup() { \
		echo; echo "stopping..."; \
		[ -n "$$engine_pid" ] && kill $$engine_pid 2>/dev/null; \
		[ -n "$$web_pid" ] && kill $$web_pid 2>/dev/null; \
		sleep 1; \
		$(MAKE) -s stop >/dev/null 2>&1; \
		exit 0; \
	}; \
	trap cleanup INT TERM EXIT; \
	( cd $(ENGINE) && exec .venv/bin/forecaster serve ) & engine_pid=$$!; \
	( cd $(WEB) && exec npm run dev ) & web_pid=$$!; \
	wait

# Stops whatever is holding the two development ports.
#
# By port, not by process name. `pkill -f "next-server"` tests its pattern
# against every process's whole command line — including the shell that ran
# make, and any editor or terminal that merely mentions the name. It killed the
# caller repeatedly while this was being written.
#
# `fuser` first, `lsof` second: Next's server binds in a way `lsof -ti` does not
# report on every system (it found nothing here while `fuser` found the pid),
# and the engine is the other way round on some. Trying both covers it.
ENGINE_PORT := 8099
WEB_PORT    := 3220

stop:
	-@for port in $(ENGINE_PORT) $(WEB_PORT); do \
		fuser -k -TERM $$port/tcp >/dev/null 2>&1 || true; \
		lsof -ti tcp:$$port 2>/dev/null | xargs -r kill 2>/dev/null || true; \
	done
	@echo "stopped (ports $(ENGINE_PORT) and $(WEB_PORT) released)"

clean:
	rm -rf $(ENGINE)/data $(ENGINE)/artifacts $(WEB)/.next $(WEB)/out reports
