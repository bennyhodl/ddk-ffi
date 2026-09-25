# Development

The repository has one Rust FFI interface and three runtime adapters. Keep DLC
logic in the upstream Rust crates; `ffi/` owns conversions and UniFFI exports.

| Directory | Owns |
| --- | --- |
| `ffi/` | Rust interface, shared UniFFI configuration, Cargo tests |
| `packages/node-browser/node/` | Node entrypoint and generated N-API bindings |
| `packages/node-browser/browser/` | Browser entrypoint and generated WASM bindings |
| `packages/react-native/` | JSI, TurboModule, iOS and Android packaging |
| `examples/` | Runnable Node, browser and React Native consumers |
| `tests/conformance/` | The same contract suite run against Node and WASM |
| `tests/compatibility/` | BAL interoperability and the mobile replay corpus |

Node and browser remain one npm package, `@bennyblader/ddk`. Export conditions
select native bindings in Node and WASM in browser bundlers. React Native ships
as `@bennyblader/ddk-rn`. Neither package compiles Rust during consumer installation.

## Install

Use Rust, pnpm 10.14.0, `just`, and `uniffi-bindgen-react-native` 0.31.0-5.
For WASM, install the `wasm32-unknown-unknown` Rust target and LLVM with a WASM
backend. Mobile builds also require Xcode or the Android SDK/NDK.

From the repository root:

```sh
just install
```

Each package retains its own pnpm workspace and lockfile. Its workspace includes
its examples under `examples/`; the Node/browser workspace also includes the
shared conformance suite. Install from the package workspace, not an example.
The compatibility suite has its own dependencies because it compares against a
published legacy engine.

## Build, check and run

```sh
just build node
just build browser
just generate-react-native
just check
just format

just test rust
just test node
just test browser
just test react-native
just compat-messages

just example node
just example node contract
just example browser
```

`check` runs Rust checks, formatting checks, lint and TypeScript checks, including
the mobile example. It requires the Node/browser builds first. `format` formats
handwritten source; generators own the formatting of generated bindings.
`test browser` runs the shared suite through WASM and loads a production Vite
build in Chrome. `example browser` starts Vite for interactive use.

Mobile commands:

```sh
just build react-native ios
just build react-native android
just native example-ios             # Install the example's CocoaPods
just example react-native ios
just example react-native android
just test react-native ios
just test react-native android
```

The native build and device recipes live in `packages/react-native/justfile`.
`just native --list` lists the individual build/install/test steps. Device tests
need the native library and example dependencies installed. Android emulator
setup is `just native e2e-android-setup`.

Package scripts own Node/browser generation, compilation and packaging. The root
`justfile` delegates to those scripts and to the native package recipes. CI uses
the same package commands, with debug builds for its initial gate and release
builds for artifacts and device tests.

## Changing the interface

Edit the UniFFI-annotated Rust in `ffi/src/`, then build Node and browser and run
`just generate-react-native`. Commit the generated bindings with the interface
change. Never hand-edit `generated/` or generated native adapter files.
Run the shared suites and mobile CI after an interface change.

For BAL compatibility, `just test compatibility` runs the full regtest suite;
`just compat-messages` runs the offline subset used by CI. See
[the compatibility README](tests/compatibility/README.md) for its existing
upstream fee-rule limitation. `just compat-vectors` regenerates the committed
corpus and the matching mobile example replay files.

## Release

```sh
just release <version>
```

This updates both npm manifests and the Rust manifest/lockfile, commits, tags,
and pushes. Only release CI publishes: it builds the native binaries on the
appropriate hosts, assembles the npm packages, and verifies their contents.
