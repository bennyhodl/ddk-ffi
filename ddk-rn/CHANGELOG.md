# DDK-RN Changelog

## [Unreleased]

### The stateless contract API

The whole DLC lifecycle now runs on device: build an offer, accept it, fund it, sign it, and settle it — either the CET an oracle attestation selects or the refund once its locktime passes. Contracts can also be spliced, rolling one into another that spends its funding output.

Nothing is persisted. Every transaction is rebuilt from the offer/accept/sign wire messages at the moment it is needed, so there is no contract store to keep in sync, and funding secret keys stay in Rust behind a `ContractKeyProvider` and never cross the FFI boundary. Either party can settle on its own. Built on the published `ddk` / `ddk-dlc` / `ddk-messages` 2.0.0-rc.1 crates.

### Installing no longer builds anything

`npm install` used to run a `postinstall` that compiled Rust on the consumer's machine — a Rust toolchain, an NDK, and ~15-30 minutes, and it silently produced no Android libraries at all if the NDK was missing. The package now ships prebuilt binaries and unpacks them.

They are also far smaller: the iOS XCFramework went from 915MB to 84MB (release builds, stripped slices, and the Intel simulator slice dropped), and Android links Rust as a shared library instead of a static archive, cutting the JNI payload roughly tenfold. The Rust source is no longer shipped inside the package at all.

### Verified on real devices

CI installs the example app on an iOS simulator and an Android emulator and drives the full contract flow with Maestro. It is the only layer that exercises the real JSI bindings, and the only one that can catch an app that never finishes launching — it immediately found two bugs every earlier release shipped with: a missing `@ubjs/core` runtime dependency (a blank screen under Metro) and an Android launch crash from the pre-0.76 `SoLoader.init(this, false)`. Run it locally with `just e2e-ios` / `just e2e-android`.

### Breaking

- **Free functions are now record methods.** `isDustOutput` → `TxOutput.isDust`; `getChangeOutputAndFees` → `PartyParams.changeOutputAndFees`; `verifyCetAdaptorSigFromOracleInfo` → `AdaptorSignature.verifyFromOracleInfo`; and nine transaction functions (`addSignatureToTransaction`, `verifyFundTxSignature`, `getRawFundingTransactionInputSignature`, `signFundTransactionInput`, `signMultiSigInput`, `signCet`, `createCetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`, `getCetSighash`) → `Transaction.*`. This comes with UniFFI 0.29 → 0.31, a migration from UDL to proc-macros, and library-based binding generation — the Rust source is now the single source of truth for the interface.
- **`DLCError` is structured.** `InvalidArgument`/`Secp256k1Error` carry a typed `message` and `KeyError` carries a nested `ExtendedKey` enum, where every variant used to be a flat string.

## [0.1.4] - 2025-01-15
- Updated build configuration
- Fixed native library dependencies

## [0.1.3] - 2025-01-15
- Improved TypeScript bindings generation
- Fixed iOS framework inclusion

## [0.1.2] - 2025-01-15
- Added complete DLC transaction functions
- Generated UniFFI bindings for React Native

## [0.1.1] - 2025-01-15
- Initial React Native library setup
- Basic UniFFI integration

## [0.1.0] - 2025-01-15
- Initial release