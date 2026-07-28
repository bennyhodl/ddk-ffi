# DDK-RN Changelog

## [Unreleased]
- **Fixed: `@ubjs/core` was missing from `dependencies`.** The generated bindings import it at runtime, so consumers hit `Unable to resolve @ubjs/core` (a blank screen under Metro) on every published version that had it missing. `tsc` and jest do not catch it — the package resolves locally via tsconfig `paths`
- **`npm install` no longer compiles anything.** The package now ships the prebuilt iOS XCFramework and Android JNI libraries; the `postinstall` script that built them on the consumer's machine is gone, along with the Rust toolchain requirement and the ~15-30 minute install
- Native libraries are now built with `--release` — the XCFramework drops from 915MB to 84MB (iOS slices are additionally stripped)
- Android now links Rust as a shared library instead of a static archive, cutting the JNI payload roughly tenfold
- Android builds pass `-Wl,-z,max-page-size=16384` so the Rust `.so` meets the Android 15+ 16KB page alignment requirement
- Dropped the `x86_64-apple-ios` (Intel Mac simulator) slice
- Removed `scripts/postinstall.js`, `scripts/prepare-rust-src.js` and `scripts/create-binary-archives.js`; the Rust source is no longer shipped inside the package
- Upgraded UniFFI 0.29 -> 0.31.0 (Swift async memory-leak/crash fixes, Android 15+ 16KB page alignment, Kotlin JNA direct mapping)
- **Breaking:** converted free functions to record methods. `isDustOutput` → `TxOutput.isDust`; `getChangeOutputAndFees` → `PartyParams.changeOutputAndFees`; `verifyCetAdaptorSigFromOracleInfo` → `AdaptorSignature.verifyFromOracleInfo`; and 9 transaction functions (`addSignatureToTransaction`, `verifyFundTxSignature`, `getRawFundingTransactionInputSignature`, `signFundTransactionInput`, `signMultiSigInput`, `signCet`, `createCetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`, `getCetSighash`) → `Transaction.*` methods
- Binding generation is now library-based, enabling proc-macro record methods
- **Breaking:** `DLCError` is now a structured error — `InvalidArgument`/`Secp256k1Error` carry a typed `message`, and `KeyError` carries the nested `ExtendedKey` enum (previously every variant was a flat string)
- Silenced per-call debug logging (uniffi.toml `logLevel = "none"`)
- Migrated the entire interface from UDL to UniFFI proc-macros (`#[derive(uniffi::Record)]`/`Enum`/`Error`, `#[uniffi::export]`, `setup_scaffolding!()`); deleted `ddk_ffi.udl`. The generated API is unchanged — Rust is now the single source of truth
- Pinned the Android NDK to r27.3.13750724 in CI instead of tracking the runner image's latest, so the toolchain a release is built with cannot change without a commit
- Consolidated five release paths into one: `just release <version>` bumps, tags and pushes, and CI publishes. Removed `scripts/unified-release.js`, `ddk-rn/scripts/release.js`, `ddk-ts/scripts/release.sh`, `apply-hotfix.js` and `release-it`
- Added a `prepublishOnly` guard that refuses to publish a tarball missing its prebuilt binaries
- GitHub releases are now created automatically with AI-generated release notes

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