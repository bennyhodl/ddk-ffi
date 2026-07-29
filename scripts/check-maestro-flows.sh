#!/usr/bin/env bash
# Parse every Maestro flow without a device and without building the app.
#
# This exists because a flow with a schema error is indistinguishable from a
# healthy one until Maestro reads it — and in CI that only happened after a full
# macOS build had produced an app to install. A `timeout:` on `assertVisible`
# (not a selector property) cost exactly that: a green build stage followed by a
# failed e2e stage, ~25 minutes in, for a typo.
#
# Maestro has no `validate` or `--dry-run` mode, so this leans on two behaviours:
#
#   * `--include-tags` with a tag no flow carries makes Maestro parse every flow
#     and then run none of them. That is what makes this safe to run while a
#     simulator is booted — a bare `maestro test` would execute the whole suite.
#   * A schema error prints "Failed to parse file". The exit code cannot be used
#     to detect it: Maestro exits 1 both for a parse error and for "no flows
#     matched", and "no flows matched" is the expected outcome here.
#
# Matching on a string means a future Maestro release could quietly turn this
# into a no-op that passes everything. So the check first proves itself against a
# flow that is known to be invalid, and fails loudly if that stops being caught.

set -uo pipefail

FLOW_DIR="${1:-ddk-rn/example/.maestro}"
# Maestro's wording for a schema error changed between majors — 1.x prints
# "Failed to parse file: ... Unrecognized field", 2.x prints "Unknown Property"
# — so match either. CI pins MAESTRO_VERSION, but a developer's local install
# is whatever they have, and this has to give the same verdict on both.
MARKER_RE='Failed to parse file|Unknown Property'
# A tag no real flow declares, so every flow is parsed and none is run.
TAG='__parse_check_only__'

if ! command -v maestro >/dev/null; then
  echo "✗ maestro is not on PATH"
  echo "  install with: curl -Ls https://get.maestro.mobile.dev | bash"
  exit 1
fi

[ -d "$FLOW_DIR" ] || { echo "✗ no such flow directory: $FLOW_DIR"; exit 1; }

# ---- self-test: a flow that must not parse -------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/known-bad.yaml" <<'EOF'
appId: ddkrn.example
---
- launchApp
# `timeout` is not one of the element selector's properties, so Maestro must
# reject this file. If it ever stops doing so, this checker is worthless.
- assertVisible:
    text: 'canary'
    timeout: 60000
EOF

# Capture, then match. Piping straight into grep would be wrong under
# `pipefail`: Maestro exits 1 even when the marker is present, so the pipeline
# reports failure on the very case this is trying to detect.
canary=$(maestro test --include-tags="$TAG" "$tmp" 2>&1)
if ! grep -qE "$MARKER_RE" <<<"$canary"; then
  echo "✗ this check can no longer detect an invalid flow."
  echo "  Maestro ($(maestro -v 2>/dev/null || echo 'unknown version')) reported none of"
  echo "  /$MARKER_RE/ for a flow that is definitely invalid, so the check would"
  echo "  pass anything. It most likely reworded the error again — add the new"
  echo "  wording to MARKER_RE. What it actually printed:"
  echo
  sed 's/^/    /' <<<"$canary"
  exit 1
fi

# ---- the real flows ------------------------------------------------------
out=$(maestro test --include-tags="$TAG" "$FLOW_DIR" 2>&1)
if grep -qE "$MARKER_RE" <<<"$out"; then
  echo "$out"
  echo
  echo "✗ $FLOW_DIR has a flow Maestro cannot parse (see above)."
  exit 1
fi

echo "✓ every flow in $FLOW_DIR parses"
