# DLC Dev Kit FFI Bindings

**Rust-powered DLC (Discreet Log Contracts) bindings for JavaScript environments**

This repository provides high-performance Rust bindings for [dlcdevkit](https://github.com/bennyhodl/dlcdevkit) and [rust-dlc](https://github.com/p2pderivatives/rust-dlc), making DLC functionality available in:

- **Node.js/TypeScript**: [@bennyblader/ddk-ts](./ddk-ts) - generated N-API native bindings
- **React Native**: [@bennyblader/ddk-rn](./ddk-rn) - UniFFI-based native bindings with JSI

[![GitHub](https://img.shields.io/github/license/bennyhodl/ddk-ffi)](https://github.com/bennyhodl/ddk-ffi/blob/master/LICENSE)

## 📦 Packages

Neither package compiles anything on install — both ship prebuilt binaries.

### [@bennyblader/ddk-ts](./ddk-ts) - Node.js/TypeScript

Native Node.js bindings for server-side applications, CLI tools, and desktop
apps, generated from the same `ddk-ffi` crate as the React Native package.

```bash
npm install @bennyblader/ddk-ts
```

**Features:**

- Generated from `ddk-ffi`, so the API matches `ddk-rn` by construction
- Prebuilt binaries for macOS ARM64 and Linux x64 — nothing compiles on install
- Full TypeScript support
- Synchronous API for performance
- ESM-only

[View package documentation →](./ddk-ts/README.md)

### [@bennyblader/ddk-rn](./ddk-rn) - React Native

React Native bindings using UniFFI for mobile DLC applications.

```bash
npm install @bennyblader/ddk-rn
```

**Features:**

- JSI-based high-performance bridge
- iOS and Android support, shipped as a prebuilt XCFramework + JNI libraries
- Requires the React Native new architecture; built and E2E-tested against RN 0.80
- TurboModule optimizations

[View package documentation →](./ddk-rn/README.md)

> Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk-rn@next`.

## 🎯 The contract API

The contract API runs the whole DLC lifecycle — offer, accept, fund, sign, settle,
and splice — without a contract store.

**Nothing is persisted.** Every transaction is rebuilt from the `OfferDlc` /
`AcceptDlc` / `SignDlc` wire messages at the moment it is needed, so there is no
state to keep in sync: hold the three messages (and one 32-byte
`temporaryContractId`) and you can reconstruct and sign anything the contract can
produce.

**Secret keys never cross the boundary.** `ContractKeyProvider` derives funding
keys deterministically inside Rust from a mnemonic, seed, xprv, or private
descriptor. Callers only ever see public keys; the provider re-derives whatever
secret key an operation needs from the temporary contract id.

Messages cross as their lightning TLV encoding — the same bytes node-dlc and
bitcoin-abstraction-layer produce. PSBTs are BIP-174; final transactions are
Bitcoin consensus serialization.

### Lifecycle

```
      offerer                                             acceptor
         │                                                   │
  createOffer ─────────────── OfferDlc ──────────────▶  validateOffer
         │                                                   │
         │                                              acceptOffer
         │                                                   │
  validateAccept ◀─────────── AcceptDlc ───────────────── (+ funding PSBT)
         │                                                   │
  sign own funding inputs                                    │
  signAccept  ─────────────── SignDlc ──────────────────▶ validateSign
         │                                                   │
         │                                              finalizeSign
         │                                                   │
         └──────────── signed funding transaction ───────────┘
                                  │
              ┌───────────────────┴───────────────────┐
        signContractCet                        signContractRefund
   (oracles attested → pays                (locktime passed → returns
    the attested outcome)                    each party its collateral)
```

Each party signs its own funding inputs on the shared PSBT before passing it
along — `signFundingPsbtWithDescriptor` does that from a private output
descriptor, or sign it with any wallet that speaks BIP-174.

Either party can settle on its own: the counterparty's half of the 2-of-2 comes
from decrypting its CET adaptor signature with the oracle signatures.

### Walkthrough

Both packages expose these as free functions with identical names and argument
order, and both represent bytes as `Uint8Array`. In Node a `Buffer` is a
`Uint8Array`, so it can be passed anywhere bytes are taken.

```typescript
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  fundingInput,
  createOffer,
  validateOffer,
  acceptOffer,
  validateAccept,
  signFundingPsbtWithDescriptor,
  signAccept,
  validateSign,
  finalizeSign,
  computeContractId,
  signContractCet,
  signContractRefund,
} from '@bennyblader/ddk-ts'; // or '@bennyblader/ddk-rn'

// Keys stay in Rust. Only the funding pubkey comes out.
const offererKeys = ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR);
const acceptorKeys = ContractKeyProvider.fromMnemonic(
  ACCEPTOR_MNEMONIC,
  undefined,
  'regtest'
);

const offerTempId = Buffer.alloc(32, 1); // 32 bytes, yours to choose and keep
const acceptTempId = Buffer.alloc(32, 2);

// 1. Offer
const offer = createOffer({
  chainHash: chainHashFromNetwork('regtest'),
  temporaryContractId: offerTempId,
  contractInfo: CONTRACT_INFO, // wire-encoded ContractInfo
  offerCollateralSats: 50_000n,
  party: {
    fundingPubkey: offererKeys.fundingPubkey(offerTempId),
    fundingInputs: [
      fundingInput(PREV_TX, 0, 100n, 0xffffffff, 108, Buffer.alloc(0)),
    ],
    payoutSpk: OFFERER_SPK,
    changeSpk: OFFERER_SPK,
  },
  feeRatePerVb: 2n,
  cetLocktime: 0,
  refundLocktime: 1_700_000_000,
  contractFlags: 0,
});

// 2. Accept — returns the AcceptDlc, the unsigned transactions, and the funding PSBT
validateOffer(offer, 0, 4_294_967_295);
const accepted = acceptOffer(
  offer,
  {
    party: {
      fundingPubkey: acceptorKeys.fundingPubkey(acceptTempId),
      fundingInputs: [/* the acceptor's UTXOs */],
      payoutSpk: ACCEPTOR_SPK,
      changeSpk: ACCEPTOR_SPK,
    },
    minTimeoutInterval: 0,
    maxTimeoutInterval: 4_294_967_295,
  },
  acceptorKeys,
  acceptTempId
);

// 3. Fund — each party signs its own funding inputs on the shared PSBT
validateAccept(offer, accepted.accept);
const psbt = signFundingPsbtWithDescriptor(
  offer,
  accepted.accept,
  accepted.fundingPsbt,
  OFFERER_DESCRIPTOR,
  [{ inputSerialId: 100n, derivationIndex: 0 }]
);

// 4. Sign
const signed = signAccept(offer, accepted.accept, offererKeys, offerTempId, psbt);
validateSign(offer, accepted.accept, signed.sign);
const fundingTx = finalizeSign(offer, accepted.accept, signed.sign, psbt);

const contractId = computeContractId(offer, accepted.accept); // the funded contract's id

// 5. Settle — a CET once the oracles attest…
const cet = signContractCet(
  offer,
  accepted.accept,
  signed.sign,
  offererKeys,
  offerTempId, // the settling party's OWN temporary id — it also says which side is settling
  [{ oracleIndex: 0, attestation: ATTESTATION }]
);

// …or the refund once refundLocktime passes
const refund = signContractRefund(
  offer,
  accepted.accept,
  signed.sign,
  offererKeys,
  offerTempId
);
```

Runnable versions of exactly this flow:

- `ddk-ts/example/src/contract.ts` — `pnpm contract`
- `ddk-rn/example/src/App.tsx` — the on-device demo the Maestro E2E drives

### Key derivation

```typescript
ContractKeyProvider.fromMnemonic(mnemonic, passphrase, network);
ContractKeyProvider.fromSeed(seed, network);
ContractKeyProvider.fromXprv(xprv); // 78-byte encoded master xprv
ContractKeyProvider.fromDescriptor(descriptor); // must carry an xprv; watch-only is rejected

provider.fundingPubkey(temporaryContractId); // 33-byte compressed pubkey
```

The only thing to persist per contract is its 32-byte `temporaryContractId`. The
provider re-derives the funding secret key from it whenever one is needed, so the
same provider serves every contract.

### Splicing

A contract can be rolled into a new one that spends its funding output directly,
with no on-chain settlement in between. Only the offering party contributes the
splice input.

```typescript
const spliceInput = createDlcSpliceInput(
  prevOffer,
  prevAccept,
  Party.Offer,
  200n,
  dlcInputMaxWitnessLen() // 220 — the required max witness length for a DLC input
);
// …place it in the offering party's `fundingInputs`, then use the spliced variants:
signAcceptSpliced(offer, accept, keys, tempId, psbt, [
  { inputSerialId: 200n, priorTemporaryContractId: prevTempId },
]);
finalizeSignSpliced(offer, accept, sign, psbt, keys, [
  { inputSerialId: 200n, priorTemporaryContractId: prevTempId },
]);
```

The prior contract's funding key is re-derived inside Rust from the provider and
the prior temporary id — like everything else, it never leaves.

### Validation and inspection

The lifecycle functions validate internally, but each check is also exposed
standalone so a stored or received message can be verified on its own:

| Function | Checks |
|---|---|
| `validateOffer(offer, minTimeout, maxTimeout)` | protocol version, funding inputs, fee rate, collateral, oracle timeouts |
| `validateAccept(offer, accept)` | the acceptor's CET adaptor signatures and refund signature |
| `validateSign(offer, accept, sign)` | the offerer's CET adaptor signatures and refund signature |
| `computeContractId(offer, accept)` | — returns the funded contract's 32-byte id |
| `contractInfoPayouts(contractInfo)` | — returns the payout table for display |
| `dlcTransactionsFromMessages(offer, accept)` | — rebuilds the unsigned fund/CET/refund transactions |

`contractInfoPayouts` handles both contract shapes: enum contracts yield one row
per labeled `outcome`, numeric contracts yield one row per inclusive
`[rangeStart, rangeEnd]` that shares a payout (`isEnum` says which).

### Errors

Contract functions throw `ContractError`, whose variants are typed rather than
stringly: `InvalidOffer`, `InvalidAccept`, `InvalidSign`, `InvalidFundingInput`,
`PsbtMismatch`, `MissingFinalizedInput`, `UnsupportedScriptType`,
`InvalidAttestation`, `NoMatchingOutcome`, `Descriptor`, `Wallet`, `Bip32`,
`Dlc`, `Key`, `Serialization`, `InvalidNetwork`, `InvalidLength`.

Two worth calling out: a forged or misindexed attestation fails with
`InvalidAttestation` (attestations are verified against the announcements they
claim to come from), and an attested outcome no CET covers fails with
`NoMatchingOutcome`.

Both packages throw UniFFI's tagged union: switch on `error.tag`, with any
payload (e.g. `{ message }`, `{ inputIndex }`) under `error.inner`. The same
holds for the transaction API's `DLCError`.

## 🔧 Transaction API

The lower-level primitives remain available for building DLC transactions
directly, without the message-driven flow.

### `version(): string`

Returns the version of the DDK library.

### Transaction construction

| Function | Purpose |
|---|---|
| `createDlcTransactions(outcomes, localParams, remoteParams, refundLocktime, feeRate, fundLockTime, cetLockTime, fundOutputSerialId, contractFlags)` | the complete set: funding, CETs, refund |
| `createSplicedDlcTransactions(…)` | the same, for a contract spending a prior DLC output |
| `createFundTxLockingScript(localFundPubkey, remoteFundPubkey)` | the 2-of-2 multisig locking script |
| `createCet(localOutput, localPayoutSerialId, remoteOutput, remotePayoutSerialId, fundTxId, fundVout, lockTime)` | one CET |
| `createCets(fundTxId, fundVout, localFinalScriptPubkey, remoteFinalScriptPubkey, outcomes, lockTime, localSerialId, remoteSerialId)` | a CET per outcome |
| `createRefundTransaction(localFinalScriptPubkey, remoteFinalScriptPubkey, localAmount, remoteAmount, lockTime, fundTxId, fundVout)` | the refund transaction |

### Signing & verification

`createCetAdaptorSigsFromOracleInfo`, `createCetAdaptorSigsFromPoints`,
`createCetAdaptorPointsFromOracleInfo`, `verifyCetAdaptorSigsFromOracleInfo`,
`extractEcdsaSignatureFromOracleSignatures`, plus the per-transaction operations
listed below.

### Keys

`convertMnemonicToSeed`, `createExtkeyFromSeed`, `createExtkeyFromParentPath`,
`createXprivFromParentPath`, `getPubkeyFromExtkey`, `getXpubFromXpriv`.

### Record methods

A dozen operations are **methods on a record** rather than free functions,
because that is how `ddk-ffi` declares them. They are identical in both packages,
and the receiver is the first argument:

| | |
|---|---|
| `TxOutput.isDust(output)` | `Transaction.signFundInput(tx, …)` |
| `PartyParams.changeOutputAndFees(params, feeRate)` | `Transaction.signMultiSigInput(tx, …)` |
| `AdaptorSignature.verifyFromOracleInfo(sig, …)` | `Transaction.signCet(cet, …)` |
| `Transaction.addSignature(tx, …)` | `Transaction.cetAdaptorSignatureFromOracleInfo(cet, …)` |
| `Transaction.verifyFundSignature(tx, …)` | `Transaction.cetAdaptorSignatureInputs(cet, …)` |
| `Transaction.rawFundingInputSignature(tx, …)` | `Transaction.cetSighash(cet, …)` |

Everything under the contract API, and every function listed above it, is a free
function in both.

### Type definitions

```typescript
// Contract API
interface CreateOfferParams {
  chainHash: Bytes;
  temporaryContractId?: Bytes; // random when omitted
  contractInfo: Bytes; // wire-encoded ContractInfo
  offerCollateralSats: bigint;
  party: ContractPartyParams;
  fundOutputSerialId?: bigint;
  feeRatePerVb: bigint;
  cetLocktime: number;
  refundLocktime: number;
  contractFlags: number; // 0 unless a protocol extension requires otherwise
}

interface ContractPartyParams {
  fundingPubkey: Bytes; // 33-byte compressed
  fundingInputs: Bytes[]; // each a wire-encoded FundingInput
  payoutSpk: Bytes;
  payoutSerialId?: bigint;
  changeSpk: Bytes;
  changeSerialId?: bigint;
}

interface AcceptOfferParams {
  party: ContractPartyParams;
  minTimeoutInterval: number;
  maxTimeoutInterval: number;
}

interface AcceptResult {
  accept: Bytes; // wire-encoded AcceptDlc
  transactions: DlcTransactions;
  fundingPsbt: Bytes; // BIP-174
}

interface SignResult {
  sign: Bytes; // wire-encoded SignDlc
  transactions: DlcTransactions;
}

interface SpliceKeyRef {
  inputSerialId: bigint;
  priorTemporaryContractId: Bytes;
}

interface OracleAttestationRef {
  oracleIndex: number; // position in the contract info's announcements
  attestation: Bytes; // wire-encoded OracleAttestation
}

interface DescriptorInput {
  inputSerialId: bigint;
  derivationIndex: number; // descriptor wildcard index
}

interface ContractPayouts {
  totalCollateralSats: bigint;
  isEnum: boolean;
  rows: PayoutRow[];
}

interface PayoutRow {
  outcome?: string; // enum contracts
  rangeStart?: bigint; // numeric contracts
  rangeEnd?: bigint;
  offerPayoutSats: bigint;
  acceptPayoutSats: bigint;
}

enum Party {
  Offer,
  Accept,
}

// Transaction API
interface Transaction {
  version: number;
  lockTime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  rawBytes: Bytes;
}

interface TxOutput {
  value: bigint;
  scriptPubkey: Bytes;
}

interface TxInput {
  txid: string;
  vout: number;
  scriptSig: Bytes;
  sequence: number;
  witness: Bytes[];
}

interface TxInputInfo {
  txid: string;
  vout: number;
  scriptSig: Bytes;
  maxWitnessLength: number;
  serialId: bigint;
}

interface Payout {
  offer: bigint;
  accept: bigint;
}

interface PartyParams {
  fundPubkey: Bytes;
  changeScriptPubkey: Bytes;
  changeSerialId: bigint;
  payoutScriptPubkey: Bytes;
  payoutSerialId: bigint;
  inputs: TxInputInfo[];
  inputAmount: bigint;
  collateral: bigint;
  dlcInputs: DlcInputInfo[];
}

interface DlcInputInfo {
  fundTx: Transaction;
  fundVout: number;
  localFundPubkey: Bytes;
  remoteFundPubkey: Bytes;
  fundAmount: bigint;
  maxWitnessLen: number;
  inputSerialId: bigint;
  contractId: Bytes;
}

interface DlcTransactions {
  fund: Transaction;
  cets: Transaction[];
  refund: Transaction;
  fundingWitnessScript: Bytes;
}

interface OracleInfo {
  publicKey: Bytes;
  nonces: Bytes[];
}

interface AdaptorSignature {
  signature: Bytes;
  proof: Bytes;
}

interface ChangeOutputAndFees {
  changeOutput: TxOutput;
  fundFee: bigint;
  cetFee: bigint;
}
```

`Bytes` is `Uint8Array` in both packages. A Node `Buffer` is a `Uint8Array`, so
`ddk-ts` takes one anywhere bytes are expected; returns are plain `Uint8Array`,
and `Buffer.from(b.buffer, b.byteOffset, b.byteLength)` re-wraps one zero-copy.

## 🏗️ Architecture

Both packages follow a **pure wrapper approach** around dlcdevkit and rust-dlc:

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────┐
│   JavaScript    │    │   Generated  │    │    Rust     │
│   Application   │───▶│   Bindings   │───▶│  ddk / dlc  │
│                 │    │  (TS + FFI)  │    │   (Core)    │
└─────────────────┘    └──────────────┘    └─────────────┘
```

`ddk-ffi/src/` is the single source of truth for the interface. It is annotated
with UniFFI **proc-macros** (`#[derive(uniffi::Record)]`, `#[uniffi::export]`,
…) — there is no `.udl` file — and **both** packages are generated from the
compiled library by `uniffi-bindgen-react-native`: the JSI/C++ bindings for React
Native, and the N-API bindings for Node. Neither contains hand-written binding
code, so the Rust source and the generated TypeScript, C++, Swift, and Kotlin
cannot drift — from the crate or from each other.

That leaves one thing worth checking rather than three:

1. CI regenerates `ddk-ts/src` and fails if it differs from what is committed
2. `ddk-rn/src/__tests__/contractBindings.test.js` checks that the generated JSI
   surface is complete — every function, record, and constructor present in both
   the TypeScript and the native symbol layer
4. `ddk-ts/__test__/contract.spec.ts` drives the full lifecycle end to end,
   including a splice rollover and the failure modes

## 🛠️ Development

### Prerequisites

- Rust (latest stable)
- Node.js 20+
- pnpm
- Just (`cargo install just`)
- `uniffi-bindgen-react-native` installed globally, at the version pinned in
  `ddk-rn/package.json` (see [CLAUDE.md](./CLAUDE.md) on version lockstep)

### Project Structure

```
.
├── ddk-ffi/            # Rust crate — the UniFFI interface (proc-macros, no UDL)
│   ├── src/
│   │   ├── lib.rs      # transaction API
│   │   └── contract.rs # stateless contract API
│   └── Cargo.toml
│
├── ddk-ts/             # Node.js/TypeScript package (UniFFI + N-API)
│   ├── src/            # generated TypeScript (committed, never hand-edited)
│   ├── dist/           # tsc output — what the package ships
│   ├── platform/       # one npm package per target, each with its cdylib
│   ├── __test__/       # vitest suites
│   ├── example/        # runnable examples
│   └── scripts/        # build + publish the generated package
│
├── ddk-rn/             # React Native package (UniFFI + JSI)
│   ├── src/            # generated TypeScript
│   ├── cpp/            # generated C++ JSI bindings
│   ├── ios/            # iOS native module + prebuilt XCFramework
│   ├── android/        # Android native module + prebuilt JNI libraries
│   └── example/        # example app, driven by the Maestro E2E
│
└── justfile            # build automation
```

### Quick Commands

```bash
just check             # cargo test (both crates) + ddk-rn typecheck
just lint              # rustfmt + clippy + eslint

# TypeScript/Node.js
just ts-build          # build for the current platform
just ts-build-all      # build for all supported platforms
just ts-test           # run tests

# React Native
just build             # JSI + TurboModule bindings, iOS framework, and ddk-ts
just uniffi-jsi        # regenerate TypeScript + C++ only
just build-ios         # build the iOS XCFramework (release, stripped)
just build-android     # build the Android JNI libraries (needs the NDK)

# End-to-end, on a real simulator/emulator
just e2e-flows         # parse every Maestro flow — no device, no build (~15s)
just e2e-ios           # build, install, and run the flows on iOS
just e2e-android       # the same on Android (one-time: just e2e-android-setup)

# Release both packages (bumps versions, tags, pushes; CI publishes)
just release 0.5.0

just clean
```

> Adding a new `#[uniffi::export]` needs `just build-ios`, not just
> `just uniffi-jsi` — the generated C++ calls into the XCFramework, and only
> `build-ios` rebuilds it.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full workflow and release process.

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! Please ensure:

1. All tests pass (`just check`, `just lint`)
2. Bindings are regenerated when changing Rust code, and committed alongside it
3. API parity between the two packages is maintained
4. Documentation and the relevant `CHANGELOG.md` are updated

## 🔗 Links

- **GitHub**: https://github.com/bennyhodl/ddk-ffi
- **dlcdevkit**: https://github.com/bennyhodl/dlcdevkit
- **rust-dlc**: https://github.com/p2pderivatives/rust-dlc
- **UniFFI**: https://mozilla.github.io/uniffi-rs/
- **uniffi-bindgen-react-native**: https://jhugman.github.io/uniffi-bindgen-react-native/

---

Built with ❤️ using [dlcdevkit](https://github.com/bennyhodl/dlcdevkit)
