# DDK-TS Changelog

## [Unreleased]
- Errors now mirror the UniFFI/React Native surface: thrown errors expose the `DLCError` variant as `error.code` (e.g. `'InvalidPublicKey'`, `'KeyError'`, matching uniffi's `DlcError_Tags`) with the human-readable `Display` string as `error.message`, instead of a Rust `Debug`-formatted blob under a generic `GenericFailure` code. Conversion errors (e.g. negative BigInt) map to `'InvalidArgument'`.
- Upgraded napi-rs: `@napi-rs/cli` `^3.7.0`, `napi` `3.9` with the `napi9` feature, `napi-derive` `3.5`, `napi-build` `2.3`; `engines.node` set to `>= 18`
- **Breaking:** renamed 10 NAPI functions to match ddk-ffi's record-method names so the two bindings stay in parity: `isDustOutput`→`isDust`, `getChangeOutputAndFees`→`changeOutputAndFees`, `verifyCetAdaptorSigFromOracleInfo`→`verifyFromOracleInfo`, `addSignatureToTransaction`→`addSignature`, `verifyFundTxSignature`→`verifyFundSignature`, `getRawFundingTransactionInputSignature`→`rawFundingInputSignature`, `signFundTransactionInput`→`signFundInput`, `createCetAdaptorSignatureFromOracleInfo`→`cetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`→`cetAdaptorSignatureInputs`, `getCetSighash`→`cetSighash`
- Parity scripts now read ddk-ffi's proc-macro exports from `lib.rs` (the `.udl` was removed)

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