#!/usr/bin/env bash
# Compile and run the BREAKPOINT edit-mode tests without Unity.
#
# The simulation is pure C# by design, so its tests should not need a game
# engine — or a Unity licence — to run. This compiles the simulation, the mesh
# geometry, the test files, and the small NUnit shim into one executable and
# runs it.
#
# Both compiled assemblies declare "noEngineReferences": true, which is what
# makes this possible and is also the structural guarantee that Unity's PhysX
# can never become the authority: the code that decides where a ball goes
# cannot even name a Unity type.
#
# Unity runs the *same* test files through the Unity Test Framework against real
# NUnit; this path exists so the physics is verifiable in CI and on any machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT/tools/parity/build"
mkdir -p "$BUILD"

echo "== compiling simulation + tests =="
mcs -langversion:7.2 -warnaserror+ -warn:4 -debug \
  -out:"$BUILD/Breakpoint.Tests.exe" \
  "$ROOT/Assets/BREAKPOINT/Runtime/Simulation/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Geometry/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Tests/EditMode/"*.cs \
  "$ROOT/tools/parity/NUnitShim.cs" \
  "$ROOT/tools/parity/Runner.cs"

echo "== running =="
cd "$ROOT"
exec mono "$BUILD/Breakpoint.Tests.exe" "$@"
