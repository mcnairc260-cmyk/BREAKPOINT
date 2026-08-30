#!/usr/bin/env bash
# Compile the Unity-facing assemblies against a hand-written API stub.
#
# This is NOT a Unity build and must never be reported as one. It proves the
# code parses and that every type and member it names exists with a compatible
# shape. It cannot prove the code behaves correctly, and if a stub signature is
# wrong it will happily agree with the mistake.
#
# Read the header of UnityApiStub.cs before trusting a green result here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/tools/compile-check/build"
mkdir -p "$OUT"

echo "== compiling the engine-free assemblies =="
mcs -langversion:7.2 -warnaserror+ -warn:4 -target:library \
  -out:"$OUT/Breakpoint.Core.dll" \
  "$ROOT/Assets/BREAKPOINT/Runtime/Simulation/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Geometry/"*.cs

echo "== compiling the Unity-facing assemblies against the API stub =="
mcs -langversion:7.2 -target:library \
  -r:"$OUT/Breakpoint.Core.dll" \
  -out:"$OUT/Breakpoint.Runtime.dll" \
  "$ROOT/tools/compile-check/UnityApiStub.cs" \
  "$ROOT/Assets/BREAKPOINT/Runtime/Rendering/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Presentation/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Input/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/UI/"*.cs

echo "== shape-checking the editor tooling against the API stubs =="
# The setup script only ever runs inside a real editor, so it would otherwise
# be the one file in the project no compiler had ever seen.
mcs -langversion:7.2 -target:library \
  -r:"$OUT/Breakpoint.Core.dll" \
  -out:"$OUT/Breakpoint.Editor.dll" \
  "$ROOT/tools/compile-check/UnityApiStub.cs" \
  "$ROOT/tools/compile-check/UnityEditorStub.cs" \
  "$ROOT/Assets/BREAKPOINT/Editor/"*.cs

echo "== shape-checking the play-mode tests =="
# These can never run here — they need a player loop — but compiling them stops
# a syntax error sitting undiscovered until someone opens the editor.
mcs -langversion:7.2 -target:library \
  -r:"$OUT/Breakpoint.Core.dll" \
  -out:"$OUT/Breakpoint.Tests.PlayMode.dll" \
  "$ROOT/tools/compile-check/UnityApiStub.cs" \
  "$ROOT/tools/compile-check/UnityTestToolsStub.cs" \
  "$ROOT/tools/parity/NUnitShim.cs" \
  "$ROOT/Assets/BREAKPOINT/Runtime/Rendering/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Presentation/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/Input/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Runtime/UI/"*.cs \
  "$ROOT/Assets/BREAKPOINT/Tests/PlayMode/"*.cs

echo
echo "shape check passed — this is not a Unity build"
