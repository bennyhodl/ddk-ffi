#!/usr/bin/env bash
# Suppress the system's crash/ANR dialogs on an emulator, and prove it took.
#
# Those dialogs belong to the emulator, not to the app under test. On a freshly
# created CI emulator the Pixel Launcher ANRs while it rebuilds its app list
# against the GMS packages that updated during boot, and the resulting "Pixel
# Launcher isn't responding" dialog is drawn on top of whatever is running.
# Maestro dumps only the foreground window, so the app vanishes from the view
# hierarchy and every assertion fails — against an app that launched cleanly and
# is still rendering behind the dialog. That is exactly how the android e2e
# failed: logcat had `Displayed ddkrn.example/.MainActivity`, the failure
# screenshot shows the app, and the captured hierarchy contains nothing but
# `android:id/aerr_close`, `aerr_wait` and the status bar.
#
# BOTH settings are needed. Measured on an API 35 emulator by forcing ANRs
# (SIGSTOP the process, then send it input):
#
#   hide_error_dialogs=1  anr_show_background=0   ANR happens, no dialog
#   hide_error_dialogs=0  anr_show_background=0   dialog
#   hide_error_dialogs=1  anr_show_background=1   dialog
#
# — anr_show_background overrides hide_error_dialogs, and it is the one that
# governs a background app, which is the case here (the launcher is in the
# background; the app under test is not). Both take effect live: no reboot, no
# configuration change, no relaunch.
#
# The values are read back afterwards because the writes cannot be trusted
# silently. These same two commands were already being issued, redirected to
# /dev/null with `|| true`, in the run that then failed to a launcher ANR
# dialog — so the one fact the log needed to carry was whether they had applied,
# and that was the one fact it had thrown away. Do not put the redirection back.
set -euo pipefail

SERIAL="${1:-}"
[ -n "$SERIAL" ] || { echo "usage: $0 <adb-serial>" >&2; exit 2; }

adb -s "$SERIAL" shell settings put global hide_error_dialogs 1 || true
adb -s "$SERIAL" shell settings put secure anr_show_background 0 || true

hide=$(adb -s "$SERIAL" shell settings get global hide_error_dialogs | tr -d '\r')
anr=$(adb -s "$SERIAL" shell settings get secure anr_show_background | tr -d '\r')
echo "system error dialogs: hide_error_dialogs=$hide anr_show_background=$anr"

# `null` is unset, which is the framework default (0) for anr_show_background.
# A warning rather than an error: nothing is broken until something ANRs, and
# the flow dismisses the dialog if one appears anyway.
if [ "$hide" != "1" ] || { [ "$anr" != "0" ] && [ "$anr" != "null" ]; }; then
  echo "::warning::error dialogs are not suppressed on $SERIAL; a background ANR can hide the app under test"
fi
