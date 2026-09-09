#!/usr/bin/env bash
# List a Rust static archive's contents summed by crate.
#   scripts/archive-crate-sizes.sh <libfoo.a> [top-N]
set -euo pipefail

archive="${1:?usage: $0 <libfoo.a> [top-N]}"
top="${2:-25}"
archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
ar -x "$archive"

# Objects are named <crate>-<16 hex>.<crate>.<hash>-cgu.N.rcgu.o.
find . -name '*.o' -exec wc -c {} + \
  | awk '
    $2 == "total" { next }
    {
      name = $2; sub(/^\.\//, "", name)
      crate = name; sub(/-[0-9a-f]{16}.*$/, "", crate)
      size[crate] += $1; total += $1
    }
    END {
      printf "%10.2f MB  total (%d crates)\n", total / 1048576, length(size)
      for (c in size) printf "%10.2f MB  %s\n", size[c] / 1048576, c
    }' \
  | sort -rn \
  | head -n "$((top + 1))"
