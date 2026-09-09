# Forecaster.
#
# `make verify` is the one command. It is what CI runs and what a change has to
# pass before it is believed.

ENGINE := engine
WEB    := web
PY     := $(ENGINE)/.venv/bin/python
BIN    := $(ENGINE)/.venv/bin

.PHONY: help setup verify test lint typecheck web-verify demo dev serve clean

help:
	@echo "setup        create the Python venv and install both projects"
	@echo "verify       everything: lint, types, tests, offline suite, web build"
	@echo "test         Python tests only"
	@echo "demo         simulate -> train -> backtest -> report, end to end"
	@echo "dev          run the engine and the web app together"
	@echo "serve        run the engine alone"

setup:
	python3 -m venv $(ENGINE)/.venv
	$(PY) -m pip install --quiet --upgrade pip
	$(PY) -m pip install --quiet -e "$(ENGINE)[dev]"
	cd $(WEB) && npm install --no-audit --no-fund

lint:
	$(BIN)/ruff check $(ENGINE)/src $(ENGINE)/tests
	$(BIN)/ruff format --check $(ENGINE)/src $(ENGINE)/tests

typecheck:
	cd $(ENGINE) && .venv/bin/mypy src/forecaster

test:
	cd $(ENGINE) && .venv/bin/python -m pytest -q

offline-suite:
	cd $(ENGINE) && .venv/bin/forecaster verify --seeds 6

web-verify:
	cd $(WEB) && npm run typecheck && npm run lint && npm run test && npm run build

verify: lint test offline-suite web-verify
	@echo ""
	@echo "verified. Note: all results are from simulated or replayed data."
	@echo "See VALIDATION.md — no real-market validation has been performed."

demo:
	cd $(ENGINE) && .venv/bin/forecaster simulate --duration 288000 --regime realistic --anchor-now --reset
	cd $(ENGINE) && .venv/bin/forecaster train --data-source simulated --venue simulator
	cd $(ENGINE) && .venv/bin/forecaster backtest --data-source simulated --venue simulator --json ../reports/backtest.json

serve:
	cd $(ENGINE) && .venv/bin/forecaster serve

dev:
	@echo "engine on :8099, web on :3220"
	cd $(ENGINE) && .venv/bin/forecaster serve & \
	cd $(WEB) && npm run dev

clean:
	rm -rf $(ENGINE)/data $(ENGINE)/artifacts $(WEB)/.next $(WEB)/out reports
