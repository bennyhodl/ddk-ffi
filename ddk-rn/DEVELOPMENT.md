# DDK-RN Development

This document covers development practices specific to the React Native bindings (ddk-rn).

## Quick Start

```bash
# Generate all bindings and build native libraries
just uniffi

# Fix the include path (required after every uniffi generation)
sed -i '' 's|#include "/ddk_ffi.hpp"|#include "ddk_ffi.hpp"|' cpp/bennyblader-ddk-rn.cpp

# Build and test
pnpm prepare
pnpm test
pnpm typecheck
```

## Development Workflow

1. **Modify Rust code** in `../ddk-ffi/src/lib.rs` — the UniFFI proc-macros there
   are the interface; there is no `.udl`
2. **Generate bindings**: `just uniffi`
3. **Test changes**: Use example app or run tests

## Release Process

From the repo root, with a clean working tree:

```bash
just release 0.2.0
```

That bumps `ddk-ts/package.json`, `ddk-rn/package.json` and `ddk-ffi/Cargo.toml`,
commits, tags `v0.2.0` and pushes. Pushing the tag is what publishes —
`.github/workflows/publish.yml` builds the XCFramework on macOS, the JNI libraries
on Linux, verifies both are in the tarball, and runs `npm publish`.

Do not publish by hand. This package ships prebuilt binaries with no
`postinstall`, so a tarball built on one machine is missing a platform and is
broken rather than merely slow. `prepublishOnly` runs `scripts/verify-package.js`
to refuse such a publish, but only CI can produce a complete one.

## Testing

- **Unit tests**: `pnpm test`
- **Type checking**: `pnpm typecheck`
- **Example app iOS**: `cd example && npx react-native run-ios`
- **Example app Android**: `cd example && npx react-native run-android`

## Project Structure

- `src/`: Generated TypeScript bindings
- `cpp/`: Generated C++ JSI bindings
- `ios/`: iOS native module and XCFramework
- `android/`: Android native module and JNI libraries
- `example/`: React Native example app