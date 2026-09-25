# Repository commands delegate to the package that owns each toolchain.
set positional-arguments

_default:
    @just --list

# Install the two package workspaces and the independent BAL compatibility suite.
install:
    pnpm --dir packages/node-browser install --frozen-lockfile
    pnpm --dir packages/react-native install --frozen-lockfile
    pnpm --dir tests/compatibility install --frozen-lockfile

# Build a runtime; React Native requires ios or android.
build runtime platform="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1/$2" in
      node/) pnpm --dir packages/node-browser build:node ;;
      browser/) pnpm --dir packages/node-browser build:browser ;;
      react-native/ios|react-native/android) pnpm --dir packages/react-native "build:$2" ;;
      *) echo 'usage: just build node|browser|react-native [ios|android]' >&2; exit 1 ;;
    esac

# Check Rust and both packages. Build Node and browser bindings first.
check:
    cargo check --manifest-path ffi/Cargo.toml --all-features
    cargo fmt --manifest-path ffi/Cargo.toml -- --check
    cargo clippy --manifest-path ffi/Cargo.toml --all-features -- -D warnings
    pnpm --dir packages/node-browser check
    pnpm --dir packages/react-native build
    pnpm --dir packages/react-native check
    pnpm --dir packages/react-native --filter ddk-rn-example typecheck

# Format handwritten Rust and package source.
format:
    cargo fmt --manifest-path ffi/Cargo.toml
    pnpm --dir packages/node-browser format
    pnpm --dir packages/react-native format

# Run a runtime suite. A mobile platform selects the device end-to-end flow.
test runtime platform="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1/$2" in
      rust/) cargo test --manifest-path ffi/Cargo.toml --all-features ;;
      node/) pnpm --dir packages/node-browser test ;;
      browser/) pnpm --dir packages/node-browser test:browser; pnpm --dir packages/node-browser test:browser:smoke ;;
      react-native/) pnpm --dir packages/react-native test ;;
      react-native/ios|react-native/android) pnpm --dir packages/react-native "test:$2" ;;
      compatibility/) pnpm --dir tests/compatibility test ;;
      *) echo 'usage: just test rust|node|browser|react-native|compatibility [ios|android]' >&2; exit 1 ;;
    esac

# Run an example against built bindings. Browser starts the Vite dev server.
example runtime platform="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1/$2" in
      node/) pnpm --dir packages/node-browser example:node ;;
      node/contract) pnpm --dir packages/node-browser example:contract ;;
      browser/) pnpm --dir packages/node-browser example:browser ;;
      react-native/ios|react-native/android) pnpm --dir packages/react-native "example:$2" ;;
      *) echo 'usage: just example node|browser|react-native [contract|ios|android]' >&2; exit 1 ;;
    esac

# Regenerate the React Native JSI and TurboModule bindings.
generate-react-native:
    pnpm --dir packages/react-native generate

# Package-owned native diagnostics and individual build/install/test steps.
native +args:
    just --justfile packages/react-native/justfile "$@"

# Offline BAL message and vector compatibility, without a regtest node.
compat-messages:
    pnpm --dir tests/compatibility test:messages

# Regenerate the shared vectors and their mobile replay copies.
compat-vectors:
    pnpm --dir tests/compatibility vectors

# Bump versions and push a release tag; CI builds and publishes the packages.
release version:
    node scripts/prep-release.js "$1"
