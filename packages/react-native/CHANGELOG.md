# DDK-RN Changelog

## [Unreleased]

### One `Signers` argument per party

`acceptOffer`, `signAccept` and `finalizeSign` take a `Signers` object — `new Signers(contractKeys).withWallet(wallet)` — built once per wallet. `contractKeys` is the `ContractSignerProvider` they already took; `wallet` is a `FundingWallet`, one async method, `signFundingPsbt(psbt)`, which signs the inputs it owns and leaves the rest, so the bdk-rn wallet that holds the coins signs them itself. The library builds the funding PSBT, hands it to the wallet at the step that needs it, and verifies what comes back, so the PSBT no longer travels through app code. Because the wallet is awaited, `signAccept` and `finalizeSign` now return Promises; `acceptOffer` stays synchronous. A party that contributes no funding inputs skips `withWallet`.

Implement `FundingWallet` over any wallet that signs PSBTs, or use the built-in `DescriptorWallet`, which signs from a private `wpkh()` / `sh(wpkh())` descriptor and finds its inputs by script. It replaces `signFundingPsbtWithDescriptor` and the `DescriptorInput` list of serial ids and derivation indexes, both removed. `createFundingPsbt` remains for wallets that sign outside these calls, and the prepare/complete API is unchanged.

### The stateless contract API

The whole DLC lifecycle now runs on device: build an offer, accept it, fund it, sign it, and settle it — either the CET an oracle attestation selects or the refund once its locktime passes. Contracts can also be spliced, rolling one into another that spends its funding output.

Nothing is persisted. Every transaction is rebuilt from the offer/accept/sign wire messages at the moment it is needed, so there is no contract store to keep in sync, and consumers own key lookup and signing through `ContractSignerProvider`. The built-in `ContractKeyProvider` keeps its derived secret keys in Rust. Either party can settle on its own. Built on the published `ddk` / `ddk-dlc` / `ddk-messages` 2.0.0-rc.8 crates.

### Installing no longer builds anything

`npm install` used to run a `postinstall` that compiled Rust on the consumer's machine — a Rust toolchain, an NDK, and ~15-30 minutes, and it silently produced no Android libraries at all if the NDK was missing. The package now ships prebuilt binaries and unpacks them.

They are also far smaller: the iOS XCFramework went from 915MB to 84MB (release builds, stripped slices, and the Intel simulator slice dropped), and Android links Rust as a shared library instead of a static archive, cutting the JNI payload roughly tenfold. The Rust source is no longer shipped inside the package at all.

### Each iOS slice is 7.6MB, down from 55MB

Two build changes in `ddk-ffi`, both measured against the 1.0.0-rc4 device slice (55MB, stripped). First, uniffi's `cli` feature — the code generator — was a plain dependency feature, and a static archive carries every object file of every dependency whether referenced or not, so about 14MB of each slice was a bindgen that never runs on a device; it is now an opt-in cargo feature. Second, link-time optimisation, which cargo had been silently skipping because the crate also declared an `rlib` type that nothing consumed; with `rlib` removed and `lto = true` + `codegen-units = 1`, LTO prunes the archive to what the exported symbols reach. The Android libraries come from the same profile: `arm64-v8a` is 5.1MB, from 6.7MB. Nothing in the API changed.

### Verified on real devices

CI installs the example app on an iOS simulator and an Android emulator and drives the full contract flow with Maestro. It is the only layer that exercises the real JSI bindings, and the only one that can catch an app that never finishes launching — it immediately found two bugs every earlier release shipped with: a missing `@ubjs/core` runtime dependency (a blank screen under Metro) and an Android launch crash from the pre-0.76 `SoLoader.init(this, false)`. Run it locally with `just native e2e-ios` / `just native e2e-android`.

### External signing

`prepareAcceptOffer` / `prepareSignAccept` return PSBT signing requests and serializable context. `completeAcceptOffer` / `completeSignAccept` verify signatures and assemble the messages. Generated serial IDs stay in the prepared context. Splice requests identify each input's required public key and previous contract ID from the offer. `prepareFinalizeSign` returns the accepting party's splice halves to sign once the sign message has verified, and `finalizeSignWithSignatures` combines them. Enum contracts only.

Consumers can implement `ContractSignerProvider.getSigner` and `ContractSigner.signEcdsa` / `signAdaptor`. The built-in `ContractKeyProvider` is one such provider with nothing stored: every `ContractKeyRequest` carries the funding public key, the temporary contract id and the contract id, all read from the messages (a splice input's temporary id is recovered from its contract id and funding transaction), and the provider derives the key on demand. Both parties derive from the offer's temporary id, as ddk-manager does; `offerTemporaryContractId(offer)` reads it for the accepting party. `PrivateKeySigner` supports consumer-derived local keys, including legacy BIP84 keys.

### Breaking

- **Lifecycle signing takes a consumer-implementable provider.** `acceptOffer(offer, params, signers)`, `signAccept(offer, accept, signers)`, and `finalizeSign(offer, accept, sign, signers)` automatically resolve splice keys from message metadata. Previous-contract lists and per-call temporary IDs are removed. Settlement takes no signer at all: `contractCetTransaction(offer, accept, sign, attestations)` and `contractRefundTransaction(offer, accept, sign)` replace `signContractCet` / `signContractRefund`. Both parties' signatures are already in the messages — the refund ones in the clear, the CET ones as adaptor signatures the attestation decrypts — so either party builds the same transaction from the three messages, with no key and no `Party`.
- **Provider and external signing share the enum-only preparation/completion flow.** Numeric contract preparation returns `Unsupported`.
- **External request/completion functions are renamed to prepare/complete.** Completion takes the preserved `SigningContext`. `SigningRequest.splice.dlcInputs` replaces the bare index list with input indexes and key identities.
- **`createDlcSpliceInput` no longer takes `maxWitnessLen`.** It applies the DLC input's (220) itself.
- **Fixed `Transaction.signMultiSigInput`**, which signed the input at the previous funding output's index rather than the input that spends it, ordered the two signatures wrongly when the local key sorts second, and failed when another input already had a witness.
- **Free functions are now record methods.** `isDustOutput` → `TxOutput.isDust`; `getChangeOutputAndFees` → `PartyParams.changeOutputAndFees`; `verifyCetAdaptorSigFromOracleInfo` → `AdaptorSignature.verifyFromOracleInfo`; and nine transaction functions (`addSignatureToTransaction`, `verifyFundTxSignature`, `getRawFundingTransactionInputSignature`, `signFundTransactionInput`, `signMultiSigInput`, `signCet`, `createCetAdaptorSignatureFromOracleInfo`, `getCetAdaptorSignatureInputs`, `getCetSighash`) → `Transaction.*`. This comes with UniFFI 0.29 → 0.31, a migration from UDL to proc-macros, and library-based binding generation — the Rust source is now the single source of truth for the interface.
- **`DLCError` is structured.** `InvalidArgument`/`Secp256k1Error` carry a typed `message` and `KeyError` carries a nested `ExtendedKey` enum, where every variant used to be a flat string.
- **`DlcTransactions.fundingScriptPubkey` is now `fundingWitnessScript`.** The field holds the funding witness script, not a script pubkey; the name follows the same rename in `ddk-dlc` 2.0.0-rc.2. The bytes are unchanged.
- **Funding keys derive under a new scheme.** `ddk` 2.0.0-rc.3 hardens every level of the contract derivation path, so `ContractKeyProvider.fundingPubkey` returns a different key than before for the same `temporaryContractId`. Contracts created before the upgrade are unaffected: the provider selects the scheme from the funding public key the request names. The one thing not to do is treat `fundingPubkey(tempId)` as a way to recover an existing contract's key — for a contract that already exists, that key is in its offer or accept message.
- **An offer's `cetLocktime` must not be after the closest oracle maturity date**, and its `refundLocktime` must fall between `maturity + minTimeoutInterval` and `maturity + maxTimeoutInterval`. `validateOffer` and `acceptOffer` reject anything else. A later CET locktime would delay execution past maturity. An earlier one, such as the offer's creation time, lets a CET confirm as soon as the oracle attests, which is how a contract closes before maturity. From `ddk` 2.0.0-rc.8; rc.3 to rc.7 required the two to be equal.
- **`validateOffer` and `acceptOffer` take the caller's clock.** `validateOffer` gains a fourth argument and `AcceptOfferParams` gains `nowUnix`, both a unix timestamp in seconds as a `bigint`. An offer whose closest oracle event matured at or before that time is rejected, because the offering party may already know the outcome. Pass the current time, for example `BigInt(Math.floor(Date.now() / 1000))`. This comes from `ddk` 2.0.0-rc.4.
- **A new single-funded contract has a different funding transaction.** From `ddk-dlc` 2.0.0-rc.4, the party that funds the whole contract also pays the CET fee for the other party's payout output, so the fund output is larger and the change is smaller. To create a contract, both parties must be on the new rule: a counterparty on the old rule builds a different funding and refund transaction, and the signatures do not verify. Dual-funded contracts do not change.
- **Contracts created under the old rule still settle and splice.** `contractCetTransaction`, `contractRefundTransaction` and `createDlcSpliceInput` rebuild a contract under the current rule first, and under the old rule when that does not reproduce the sign message's contract id. The new `dlcTransactionsFromSignedMessages` rebuilds the same way. `dlcTransactionsFromMessages`, and every step that creates a contract, use the current rule only.
- **`createDlcSpliceInput` takes the previous contract's sign message**, after its accept message. Its contract id is what selects the fee rule.
- **`FeeRule` and `createDlcTransactionsWithFeeRule` / `createSplicedDlcTransactionsWithFeeRule`** let a caller that builds transactions itself, such as BAL, rebuild a contract created under the old rule. Check the result against the contract's known id.
- **Bytes are `Uint8Array`, not `ArrayBuffer`.** Every `Vec<u8>` argument and return type moves. This comes from `strictByteArrays` in `ffi/uniffi.toml`, which was turned on for `@bennyblader/ddk-ts` — a Node `Buffer` is a `Uint8Array`, so its consumers pass byte arguments unchanged — and ubrn reads that one file for every binding it generates. The two packages now agree on the byte type, which they never did before.

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