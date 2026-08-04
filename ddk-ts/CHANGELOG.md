# DDK-TS Changelog

## [Unreleased]

### The stateless contract API

The whole DLC lifecycle now runs in Node: build an offer, accept it, fund it, sign it, and settle it — either the CET an oracle attestation selects or the refund once its locktime passes. Contracts can also be spliced, rolling one into another that spends its funding output.

Nothing is persisted. Every transaction is rebuilt from the offer/accept/sign wire messages at the moment it is needed, so there is no contract store to keep in sync, and funding secret keys stay in Rust behind a `ContractKeyProvider` and never cross into JS. Either party can settle on its own. Built on the published `ddk` / `ddk-dlc` 2.0.0-rc.1 crates, and in parity with `@bennyblader/ddk-rn`.

### The published package actually loads

`package.json` declared `"type": "module"` while `napi build` emits CommonJS into `dist/index.js`, so `import` threw `ReferenceError: require is not defined in ES module scope` and `require` returned an empty object — the published bindings could not be loaded either way. Dropping the field restores both.

Known trade-off: the ESM browser/WASM entries (`dist/browser.js`, `dist/ddk-ts.wasi-browser.js`) are now read as CommonJS and will not resolve — the Node bindings are the supported path. Installing still compiles nothing: prebuilt platform packages come in through `optionalDependencies`, with the WASI build as the fallback.

### Verified end to end

The test suite drives the complete lifecycle offer-to-settlement, including a splice-out rollover and the failure modes that matter (a forged attestation, an outcome no CET covers, a splice key derived from the wrong party's prior contract). The Node example (`pnpm contract`) runs the same path top to bottom and prints each artifact's size.

### Breaking

- **Ten functions renamed** to match ddk-ffi's record-method names so the two bindings stay in parity: `isDustOutput`→`isDust`, `getChangeOutputAndFees`→`changeOutputAndFees`, `verifyCetAdaptorSigFromOracleInfo`→`verifyFromOracleInfo`, `addSignatureToTransaction`→`addSignature`, `verifyFundTxSignature`→`verifyFundSignature`, `getRawFundingTransactionInputSignature`→`rawFundingInputSignature`, `signFundTransactionInput`→`signFundInput`, `createCetAdaptorSignatureFromOracleInfo`→`cetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`→`cetAdaptorSignatureInputs`, `getCetSighash`→`cetSighash`.
- **Errors mirror the React Native surface.** A thrown error exposes the `DLCError` variant as `error.code` (`'InvalidPublicKey'`, `'KeyError'`, …) with the `Display` string as `error.message`, instead of a Rust `Debug` blob under a generic `GenericFailure`. Conversion errors (e.g. a negative BigInt) map to `'InvalidArgument'`.

## [0.3.43] - 2026-07-21

- Added `wasm32-wasip1-threads` build target for browser/WASM support (`pnpm build:wasm`)
- Wired the WASM target into CI and the release/publish pipeline (builds the `@bennyblader/ddk-ts-wasm32-wasi` sibling package)
- Added `browser` field so bundlers resolve the WASM binding, plus a Vite browser example (`example-browser/`)

## [0.1.11] - 2025-01-15

- Updated package configuration

## [0.1.10] - 2025-01-15

- Fixed build dependencies

## [0.1.9] - 2025-01-15

- Improved NAPI-RS bindings

## [0.1.8] - 2025-01-15

- Enhanced type definitions

## [0.1.7] - 2025-01-15

- Added platform-specific builds

## [0.1.6] - 2025-01-15

- Fixed TypeScript type exports

## [0.1.5] - 2025-01-15

- Improved build process

## [0.1.4] - 2025-01-15

- Added multi-platform support

## [0.1.3] - 2025-01-15

- Enhanced error handling

## [0.1.2] - 2025-01-15

- Added DLC transaction functions

## [0.1.1] - 2025-01-15

- Initial NAPI-RS setup

## [0.1.0] - 2025-01-15

- Initial release
