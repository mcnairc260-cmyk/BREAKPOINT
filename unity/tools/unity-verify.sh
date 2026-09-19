#!/usr/bin/env bash
# Configure, compile and test the BREAKPOINT Unity project headlessly.
#
# This is the script that turns "open it in Unity and see what breaks" into one
# command. It needs a real, licensed Unity install — batch mode still requires
# an activated licence — but no editor window and no human.
#
# Usage, from the repository root:
#
#   unity/tools/unity-verify.sh                 # auto-detect Unity 6000.0.23f1
#   UNITY=/path/to/Unity unity/tools/unity-verify.sh
#
# Exit code is non-zero if setup, compilation or any test fails. Logs land in
# unity/tools/unity-logs/ and are printed on failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$ROOT/unity"
LOGS="$PROJECT/tools/unity-logs"
VERSION="6000.0.23f1"
mkdir -p "$LOGS"

# ---------------------------------------------------------------- find Unity
if [ -z "${UNITY:-}" ]; then
  for candidate in \
    "/Applications/Unity/Hub/Editor/$VERSION/Unity.app/Contents/MacOS/Unity" \
    "$HOME/Unity/Hub/Editor/$VERSION/Editor/Unity" \
    "/opt/unity/editors/$VERSION/Editor/Unity" \
    "/c/Program Files/Unity/Hub/Editor/$VERSION/Editor/Unity.exe"
  do
    [ -x "$candidate" ] && UNITY="$candidate" && break
  done
fi

if [ -z "${UNITY:-}" ] || [ ! -x "$UNITY" ]; then
  echo "FAIL: Unity $VERSION not found."
  echo "Install it via Unity Hub, or set UNITY=/path/to/Unity and re-run."
  echo "Looked in the standard Hub locations for macOS, Linux and Windows."
  exit 1
fi

echo "Unity:   $UNITY"
echo "Project: $PROJECT"
echo

# A batch-mode Unity run needs an activated licence. Without one it exits
# quickly with a licensing error, which is far more legible than the
# compile errors it would otherwise appear to produce.
run_unity() {
  local name="$1"; shift
  local log="$LOGS/$name.log"
  echo "== $name =="
  "$UNITY" -batchmode -nographics -projectPath "$PROJECT" -logFile "$log" "$@"
  local code=$?
  if [ $code -ne 0 ]; then
    echo "-- $name FAILED (exit $code); last 80 lines of $log --"
    tail -80 "$log"
    if grep -qiE "license|activation" "$log"; then
      echo
      echo "This looks like a licensing failure, not a code failure."
      echo "Open Unity Hub once, sign in and activate a licence, then re-run."
    fi
  fi
  return $code
}

# 1. Project settings. Runs first and on its own because the input-handler
#    change only takes effect on the next editor launch.
run_unity setup -quit -executeMethod Breakpoint.EditorTools.BreakpointProjectSetup.Run || exit 1

# 2. Compile. Importing the project with no other work is the cheapest way to
#    surface every compile error at once.
run_unity compile -quit || exit 1

if grep -qE "error CS[0-9]+" "$LOGS/compile.log"; then
  echo "FAIL: compile errors"
  grep -E "error CS[0-9]+" "$LOGS/compile.log" | sort -u
  exit 1
fi
echo "compile: clean"
echo

# 3. Tests. -runTests implies its own quit; asking for -quit as well makes
#    Unity exit before the results are written.
tests_failed=0
for platform in EditMode PlayMode; do
  results="$LOGS/$platform-results.xml"
  run_unity "tests-$platform" -runTests -testPlatform "$platform" -testResults "$results"
  code=$?

  if [ -f "$results" ]; then
    python3 - "$results" "$platform" <<'PY'
import sys, xml.etree.ElementTree as ET
path, platform = sys.argv[1], sys.argv[2]
try:
    root = ET.parse(path).getroot()
except Exception as exc:
    print("%s: could not parse results (%s)" % (platform, exc)); sys.exit(0)
a = root.attrib
print("%s: %s total, %s passed, %s failed, %s skipped"
      % (platform, a.get('total','?'), a.get('passed','?'),
         a.get('failed','?'), a.get('skipped','?')))
for case in root.iter('test-case'):
    if case.get('result') in ('Failed', 'Error'):
        print("  FAIL %s" % case.get('fullname'))
        msg = case.find('.//message')
        if msg is not None and msg.text:
            for line in msg.text.strip().splitlines()[:6]:
                print("       %s" % line)
PY
  else
    echo "$platform: no results file written"
  fi

  [ $code -ne 0 ] && tests_failed=1
  echo
done

[ $tests_failed -ne 0 ] && echo "FAIL: one or more tests failed" && exit 1

echo "================================================"
echo "  setup + compile + EditMode + PlayMode: all green"
echo "================================================"
