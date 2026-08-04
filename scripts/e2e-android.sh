#!/usr/bin/env bash
# Install the example APK on a running emulator and drive it with Maestro.
#
# This is a FILE, and .github/workflows/ci.yml invokes it as a single line, for a
# specific reason: reactivecircus/android-emulator-runner does not run its
# `script:` input as a script. It splits the input on newlines and runs each line
# as its own `sh -c` — visible in the job log as one `[command]/usr/bin/sh -c …`
# per line. Nothing carries across those lines:
#
#   set -eu                     applies only to the shell that immediately exits
#   cd ddk-rn/example           working directory discarded
#   SERIAL=$(adb devices | …)   variable gone by the next line
#   maestro --udid "$SERIAL"    $SERIAL unset
#
# That is not a hypothetical either: it produced "no emulator in adb devices"
# immediately after a successful `adb install`, and before that it was why a
# leading `set -euo pipefail` aborted the whole step on line 1 (the action's sh
# is dash, which has no pipefail). Keeping the logic in a file also means it can
# be run locally, which the inline version never could.
#
# So: do not inline this back into the workflow.
#
# APK path is overridable so the same script can be run against a local build:
#   APK=ddk-rn/example/android/app/build/outputs/apk/release/app-release.apk \
#     ./scripts/e2e-android.sh

set -euo pipefail

APK="${APK:-artifact/app-release.apk}"
FLOW_DIR="${FLOW_DIR:-.maestro/}"

[ -f "$APK" ] || { echo "::error::APK not found: $APK"; exit 1; }

adb install -r "$APK"

# Address the emulator explicitly rather than letting Maestro choose. Derived
# from adb rather than hardcoding emulator-5554 so a non-default port still works.
SERIAL=$(adb devices | awk '/emulator.*device$/ {print $1; exit}')
[ -n "$SERIAL" ] || {
  echo "::error::no emulator in adb devices"
  adb devices
  exit 1
}
echo "Using emulator $SERIAL"

# Keep the emulator's own crash/ANR dialogs off the screen — one of them covering
# the app is a real, observed failure mode, not a precaution. See the script for
# what each setting does and why both are needed.
"$(dirname "$0")/android-suppress-dialogs.sh" "$SERIAL"

cd "$(dirname "$0")/../ddk-rn/example"

# logcat is captured here, while the emulator is still alive. A separate
# `if: failure()` workflow step cannot: the action tears the device down when
# this script returns, and `adb logcat -d` then blocks on a device that never
# appears, hanging the job until its timeout.
if ! maestro --udid "$SERIAL" test "$FLOW_DIR"; then
  adb logcat -d > "${RUNNER_TEMP:-/tmp}/logcat.txt" 2>/dev/null || true
  echo "::error::Maestro flow failed on $SERIAL"
  exit 1
fi
