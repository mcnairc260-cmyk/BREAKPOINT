#!/usr/bin/env python3
"""One command. Sets itself up, finds a reachable exchange, proves the system on it.

    python scripts/live_proof.py

That is the whole thing. It needs Python 3.11 or newer and an internet connection
that is not behind a corporate egress policy. It needs no virtual environment, no
`make`, no `pip install` beforehand, and no API key — every endpoint it touches is
public and unauthenticated.

Written as a single file with no imports outside the standard library, and to run
on Windows as readily as on Linux, because the machine that can reach an exchange
is usually not the machine the code was written on. `make` in particular is not
present on a stock Windows install, which is why this exists rather than a make
target.

What it does, in order:

1. Creates a virtual environment beside the repository and installs the engine
   into it. Skipped on later runs.
2. Probes every exchange it knows, at five layers, and picks the first that
   returns real public market data AND has an adapter.
3. Runs the full live proof against that venue: verify prices, collect until the
   volatility model has enough history, forecast BTC and ETH at 5 and 20 minutes
   across six target distances, wait for those forecasts to expire, resolve them
   from the venue's own prints, restart against the same database, and report.
4. Writes `reports/live-proof.json` and prints a block to copy and paste.

It takes about an hour, nearly all of it waiting: thirty minutes before the
volatility model will speak at all, then twenty for the 20-minute horizon to
expire. Neither can be shortened without weakening a safeguard.

Exit code 0 means PROVEN and nothing else does.
"""

from __future__ import annotations

import platform
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"
VENV = ENGINE / ".venv"
MINIMUM_PYTHON = (3, 11)


def venv_bin(name: str) -> Path:
    """Windows puts executables in Scripts\\ and appends .exe; POSIX uses bin/."""
    if platform.system() == "Windows":
        return VENV / "Scripts" / f"{name}.exe"
    return VENV / "bin" / name


def run(command: list[str], **kwargs: object) -> int:
    printable = " ".join(str(part) for part in command)
    print(f"    $ {printable}", flush=True)
    return subprocess.call(command, **kwargs)  # type: ignore[arg-type]


def ensure_environment() -> Path:
    """Create the virtual environment and install the engine, once."""
    forecaster = venv_bin("forecaster")
    python = venv_bin("python")
    if forecaster.exists():
        print(f"  using the existing environment at {VENV}")
        return forecaster

    print(f"  creating a virtual environment at {VENV}")
    venv.EnvBuilder(with_pip=True, clear=False).create(VENV)

    print("  installing the forecaster engine (this takes a minute or two)")
    if run([str(python), "-m", "pip", "install", "--quiet", "--upgrade", "pip"]) != 0:
        print("  WARNING: could not upgrade pip; continuing anyway")
    if run([str(python), "-m", "pip", "install", "--quiet", "-e", str(ENGINE)]) != 0:
        print("")
        print("  Installing the engine failed. The usual cause is a Python without")
        print("  build tools, or no internet access to PyPI. The error is above.")
        raise SystemExit(2)
    if not forecaster.exists():
        print(f"  Installed, but {forecaster} is missing. Something is wrong with the venv.")
        raise SystemExit(2)
    return forecaster


def main() -> int:
    if sys.version_info < MINIMUM_PYTHON:
        print(
            f"  Python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer is required; "
            f"this is {sys.version.split()[0]}."
        )
        return 2

    print("")
    print("  FORECASTER — LIVE MARKET PROOF")
    print(f"  {'=' * 68}")
    print(f"  repository  {ROOT}")
    print(f"  python      {sys.version.split()[0]} on {platform.system()}")
    print("")

    forecaster = ensure_environment()
    reports = ROOT / "reports"
    reports.mkdir(parents=True, exist_ok=True)

    print("")
    print("  STEP 1 of 2 — which exchanges can this machine reach?")
    reachability = reports / "venue-reachability.json"
    probe_status = run(
        [str(forecaster), "probe-venues", "--json", str(reachability)],
        cwd=str(ENGINE),
    )
    if probe_status != 0:
        print("")
        print("  No exchange is reachable from this machine, so there is nothing to")
        print("  prove against. The table above shows which layer fails for each venue:")
        print("")
        print("    dns FAIL   — name resolution is blocked or the host is wrong")
        print("    tcp FAIL   — outbound 443 is blocked")
        print("    tls FAIL   — something is terminating TLS before the venue")
        print("                 (a corporate proxy; the issuer name says which)")
        print("    rest FAIL  — the connection is allowed but the request is refused")
        print("")
        print(f"  The full detail is in {reachability}")
        print("  Try again from a home or mobile connection.")
        return 1

    print("")
    print("  STEP 2 of 2 — the proof. About an hour. Leave it running.")
    print("")
    proof = reports / "live-proof.json"
    status = run(
        [str(forecaster), "live-proof", "--auto", "--json", str(proof)],
        cwd=str(ENGINE),
    )

    print("")
    print(f"  {'=' * 68}")
    if status == 0:
        print("  PROVEN. Copy the block above and keep reports/live-proof.json.")
    else:
        print("  Not proven. The verdict and the failing stage are in the block above.")
    print(f"  machine-readable: {proof}")
    print("")
    return status


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n  stopped.")
        raise SystemExit(130) from None
