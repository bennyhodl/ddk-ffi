# DDK-RN Changelog

## [Unreleased]
- Upgraded UniFFI 0.29 -> 0.31.0 (Swift async memory-leak/crash fixes, Android 15+ 16KB page alignment, Kotlin JNA direct mapping)
- **Breaking:** converted free functions to record methods. `isDustOutput` → `TxOutput.isDust`; `getChangeOutputAndFees` → `PartyParams.changeOutputAndFees`; `verifyCetAdaptorSigFromOracleInfo` → `AdaptorSignature.verifyFromOracleInfo`; and 9 transaction functions (`addSignatureToTransaction`, `verifyFundTxSignature`, `getRawFundingTransactionInputSignature`, `signFundTransactionInput`, `signMultiSigInput`, `signCet`, `createCetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`, `getCetSighash`) → `Transaction.*` methods
- Binding generation is now library-based, enabling proc-macro record methods
- **Breaking:** `DLCError` is now a structured error — `InvalidArgument`/`Secp256k1Error` carry a typed `message`, and `KeyError` carries the nested `ExtendedKey` enum (previously every variant was a flat string)
- Silenced per-call debug logging (uniffi.toml `logLevel = "none"`)
- Migrated the entire interface from UDL to UniFFI proc-macros (`#[derive(uniffi::Record)]`/`Enum`/`Error`, `#[uniffi::export]`, `setup_scaffolding!()`); deleted `ddk_ffi.udl`. The generated API is unchanged — Rust is now the single source of truth

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