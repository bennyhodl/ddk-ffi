# @bennyblader/ddk-rn

React Native bindings for the DLC Dev Kit (DDK) - UniFFI-based native bindings for React Native applications.

## Installation

```bash
npm install @bennyblader/ddk-rn
# or
pnpm add @bennyblader/ddk-rn
```

That's the whole install. The package ships prebuilt native binaries — the iOS
XCFramework and the Android JNI libraries — so nothing is compiled on your
machine and no Rust toolchain, Android NDK, or extra download is required.
`pod install` and Gradle pick the binaries up from `node_modules` directly.

Prebuilt platform coverage:

| Platform | Architectures |
|----------|---------------|
| iOS      | `arm64` device, `arm64` simulator |
| Android  | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` |

The Intel Mac simulator (`x86_64`) is not included.

Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk-rn@next`.

## Quick Start

```typescript
import { version, createFundTxLockingScript } from '@bennyblader/ddk-rn';

console.log(`DDK Version: ${version()}`);
```

### The contract API

The whole DLC lifecycle runs on device, with no contract store — every
transaction is rebuilt from the offer/accept/sign wire messages when it is
needed, and funding secret keys stay inside Rust behind a `ContractKeyProvider`.

```typescript
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  createOffer,
  acceptOffer,
  signAccept,
  finalizeSign,
  signContractCet,
} from '@bennyblader/ddk-rn';

const keys = ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest');
const temporaryContractId = new Uint8Array(32).fill(1).buffer;

const offer = createOffer({
  chainHash: chainHashFromNetwork('regtest'),
  temporaryContractId,
  contractInfo: CONTRACT_INFO,
  offerCollateralSats: 50_000n,
  party: {
    fundingPubkey: keys.fundingPubkey(temporaryContractId),
    fundingInputs: [FUNDING_INPUT],
    payoutSpk: SPK,
    changeSpk: SPK,
  },
  feeRatePerVb: 2n,
  cetLocktime: 0,
  refundLocktime: 1_700_000_000,
  contractFlags: 0,
});
// …acceptOffer → sign the funding PSBT → signAccept → finalizeSign →
//   signContractCet / signContractRefund
```

Bytes cross the JSI boundary as `ArrayBuffer` (`ddk-ts` uses `Buffer`).

`example/src/App.tsx` runs the complete flow on device — offline, deterministic,
and asserted by the Maestro E2E.

For complete API documentation, see the [main README](../README.md#-the-contract-api).

## Development

### Prerequisites

- Node.js >= 20
- Rust >= 1.70
- pnpm
- UniFFI React Native, installed globally at the version pinned in
  `package.json`: `pnpm add -g uniffi-bindgen-react-native@<version>`
- iOS: Xcode 14+, CocoaPods
- Android: Android Studio, NDK 27.1.12297006

> The `uniffi` crate, this package's `uniffi-bindgen-react-native` dependency,
> and the globally installed binary must all be the same release — the `just`
> recipes call the binary on `$PATH`, not the one in `node_modules`. A skew shows
> up as TypeScript errors like "Expected 2 arguments, but got 1" on every
> generated `.lower()` call.

### Building from Source

```bash
# Install dependencies
pnpm install

# Generate all bindings and build the native libraries
just build
```

### Just Commands

```bash
# JSI + TurboModule bindings, the iOS XCFramework, and ddk-ts
just build

# Generate JSI bindings only (TypeScript + C++)
just uniffi-jsi

# Generate TurboModule specifications
just uniffi-turbo

# Build the iOS XCFramework (release, stripped)
just build-ios

# Build the Android JNI libraries (needs the NDK)
just build-android

# Setup example app
just example

# iOS example setup
just example-ios

# Android example build
just example-android

# Report the size of every binary destined for the npm package
just binary-sizes

# Clean all generated files
just clean
```

> Adding a new `#[uniffi::export]` needs `just build-ios`, not just
> `just uniffi-jsi`. `uniffi-jsi` regenerates the TypeScript and C++, but the C++
> calls into the XCFramework, which only `build-ios` rebuilds — skip it and the
> app fails at link with `Undefined symbols … _uniffi_ddk_ffi_fn_func_<name>`.
> Nothing earlier in the chain catches this.

### Project Structure

```
ddk-rn/
├── src/                # Generated TypeScript bindings
│   ├── index.tsx       # Main entry point (generated)
│   ├── ddk_ffi.ts      # The API consumers import (generated)
│   ├── ddk_ffi-ffi.ts  # Native JSI symbol declarations (generated)
│   └── __tests__/      # Hand-written — the only non-generated code in src/
├── cpp/                # Generated C++ JSI bindings
│   ├── ddk_ffi.hpp     # C++ header (generated)
│   ├── ddk_ffi.cpp     # C++ implementation (generated)
│   └── *.cpp/.h        # TurboModule files (generated)
├── ios/                # iOS native module
│   ├── DdkRn.xcframework/ # Prebuilt iOS framework (generated, shipped)
│   └── *.h/.mm         # iOS bridge code
├── android/            # Android native module
│   └── src/main/
│       ├── java/       # Kotlin/Java bridge code
│       └── jniLibs/    # Prebuilt native libraries (generated, shipped)
├── example/            # Example React Native app + Maestro flows
├── patches/            # pnpm patch for an unreleased ubrn fix
├── scripts/            # Package verification
└── ubrn.config.yaml    # UniFFI React Native configuration
```

Everything in `src/` except `src/__tests__/` is generated — don't hand-edit it,
and don't "fix" lint errors inside it (those files are in `eslintIgnore` for
exactly that reason).

### Testing

```bash
pnpm test       # jest
pnpm typecheck  # tsc
pnpm lint       # eslint
```

`src/__tests__/contractBindings.test.js` is a binding-surface test: the JSI
bindings can't execute under Node, so it asserts instead that generation was
complete — every function, record, and constructor present in both the
TypeScript surface and the native symbol layer. It catches the classic
regression where `ddk-ffi` changed but `ddk-rn` wasn't regenerated. Runtime
behavior is covered by the shared Rust (`ddk-ffi` unit tests and the `ddk-ts`
suite exercise the same functions).

### End-to-end, on a device

CI installs the example app on an iOS simulator and an Android emulator and
drives the full contract flow with Maestro. It is the only layer that exercises
the real JSI bindings, and the only one that catches an app that never finishes
launching.

| command | needs | time |
|---|---|---|
| `just e2e-flows` | nothing — no device, no app | ~15s |
| `just e2e-ios-test` | the app already installed | ~10s |
| `just e2e-ios` | full: build + install + run | ~5-10m |

Android needs a one-time `just e2e-android-setup` (~1.5GB) to create the
emulator and AVD, then `just e2e-android`.

While editing a flow, stay in `e2e-ios-test`; only rebuild when the app itself
changes (JS, Rust, or the generated bindings).

### Platform Support

| Platform      | Architecture     | Status          |
| ------------- | ---------------- | --------------- |
| iOS           | ARM64            | ✅ Supported    |
| iOS Simulator | ARM64            | ✅ Supported    |
| iOS Simulator | x64 (Intel Mac)  | ❌ Not included |
| Android       | ARM64-v8a        | ✅ Supported    |
| Android       | ARMv7            | ✅ Supported    |
| Android       | x86 / x86_64     | ✅ Supported    |

### Building the Example App

The example is pinned to React Native 0.80 / React 19.1 — the release these
bindings are supported against, so the E2E exercises the toolchain consuming
apps actually build with.

#### iOS

```bash
# Install iOS dependencies with new architecture
just example-ios

# Run the app
cd example
npx react-native run-ios
```

#### Android

```bash
# Build Android app
just example-android

# Run the app
cd example
npx react-native run-android
```

### Release Process

`ddk-ts` and `ddk-rn` are versioned and released together, from the repo root:

```bash
just release 0.5.0
```

This will:

1. Check the working directory is clean
2. Set the version in `ddk-ts/package.json`, `ddk-rn/package.json` and `ddk-ffi/Cargo.toml`
3. Commit, tag as `v0.5.0` and push

Publishing happens in CI — pushing the tag is what publishes. The iOS
XCFramework is built on `macos-latest`, the Android JNI libraries on
`ubuntu-latest` with the NDK, and a final job assembles both and verifies the
binaries are in the tarball before publishing. Nothing is published from a
developer machine; `prepublishOnly` refuses a hand-run `npm publish` that would
ship without binaries.

Update the `[Unreleased]` section of [CHANGELOG.md](./CHANGELOG.md) **before**
releasing — the release script refuses a dirty tree, so it can't be part of the
release commit.

### API Compatibility

All bindings are generated from the compiled `ddk-ffi` library, whose Rust
source — annotated with UniFFI proc-macros, with no `.udl` file — is the single
source of truth for the interface.

`@bennyblader/ddk-ts` is hand-written NAPI over the same crates and is kept in
parity by CI. Two differences to know: bytes are `ArrayBuffer` here and `Buffer`
there, and a dozen transaction operations are methods on a record here
(`TxOutput.isDust`, `Transaction.signCet`, …) but free functions there. See the
[comparison table](../README.md#where-the-two-packages-differ).

### Known Issues

1. **New Architecture**: The library requires React Native's new architecture to be enabled:
   - iOS: Set `RCT_NEW_ARCH_ENABLED=1`
   - Android: Set `newArchEnabled=true` in `gradle.properties`

2. **Android C++ builds need an unreleased ubrn fix.** The generated
   `android/CMakeLists.txt` resolves the ubrn package with
   `require.resolve('uniffi-bindgen-react-native/package.json')`, which throws
   `ERR_PACKAGE_PATH_NOT_EXPORTED` because ubrn's `exports` map doesn't expose
   that subpath. The include dir silently becomes `/cpp/includes` and the build
   dies with `'UniffiCallInvoker.h' file not found`. This repo patches it
   (`patches/uniffi-bindgen-react-native@0.31.0-3.patch`, applied by
   `pnpm install`), but a pnpm patch only applies to this repo — building an
   Android app against the published package hits the original error until ubrn
   ships the fix ([#404](https://github.com/jhugman/uniffi-bindgen-react-native/issues/404),
   fixed on `main`, release tracked in
   [#421](https://github.com/jhugman/uniffi-bindgen-react-native/issues/421)).

## Troubleshooting

### iOS Build Issues

If you encounter build issues on iOS:

```bash
cd example/ios
pod deintegrate
pod install
```

### Android Build Issues

Clean and rebuild Android:

```bash
cd example/android
./gradlew clean
./gradlew build
```

### Missing Bindings

If bindings are missing, regenerate them:

```bash
just clean
just build
```

### A modified `android/build.gradle` after building

`just build-android <abi>` narrows `abiFilters` to the ABIs you passed and wipes
`jniLibs/` for the rest. Never commit that — a single-ABI `build.gradle` ships an
app that only runs on one architecture:

```bash
git checkout android/build.gradle
```

## License

MIT
