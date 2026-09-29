# DLC Dev Kit FFI Bindings

**Rust-powered DLC (Discreet Log Contracts) bindings for JavaScript environments**

This repository provides high-performance Rust bindings for [dlcdevkit](https://github.com/bennyhodl/dlcdevkit) and [rust-dlc](https://github.com/p2pderivatives/rust-dlc), making DLC functionality available in:

- **Node.js and browsers**: [@bennyblader/ddk](./packages/node-browser) - generated N-API native bindings for Node, WebAssembly for browsers
- **React Native**: [@bennyblader/ddk-rn](./packages/react-native) - UniFFI-based native bindings with JSI

[![GitHub](https://img.shields.io/github/license/bennyhodl/ddk-ffi)](https://github.com/bennyhodl/ddk-ffi/blob/master/LICENSE)

## 📦 Packages

Neither package compiles anything on install — both ship prebuilt binaries.

### [@bennyblader/ddk](./packages/node-browser) - Node.js and browsers

One package, two bindings generated from the same `ddk-ffi` crate as the React
Native package. `exports` conditions pick one at resolve time: Node gets native
N-API bindings, browsers get WebAssembly.

```bash
npm install @bennyblader/ddk
```

```typescript
import { init, version } from '@bennyblader/ddk'

await init() // loads the wasm in a browser; a no-op on Node
version()
```

**Features:**

- Generated from `ddk-ffi`, so the API matches `ddk-rn` by construction
- Node: prebuilt binaries for macOS ARM64 and Linux x64 through
  `@bennyblader/ddk-<platform>` optional dependencies — nothing compiles on install,
  and it throws on a platform without one rather than silently using wasm
- Browsers: `ddk_ffi.wasm` (4.8MB, 2.9MB gzipped), no COOP/COEP headers needed;
  also available anywhere as `@bennyblader/ddk/wasm`
- Full TypeScript support, the same API as Node after `await init()`
- ESM-only

It replaces `@bennyblader/ddk-ts`.

[View package documentation →](./packages/node-browser/README.md)

### [@bennyblader/ddk-rn](./packages/react-native) - React Native

React Native bindings using UniFFI for mobile DLC applications.

```bash
npm install @bennyblader/ddk-rn
```

**Features:**

- JSI-based high-performance bridge
- iOS and Android support, shipped as a prebuilt XCFramework + JNI libraries
- Requires the React Native new architecture; built and E2E-tested against RN 0.80
- TurboModule optimizations

[View package documentation →](./packages/react-native/README.md)

> Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk-rn@next`.

## 🎯 The contract API

The contract API runs the whole DLC lifecycle — offer, accept, fund, sign, settle,
and splice — without a contract store.

The library rebuilds transactions from the offer/accept/sign messages. Consumers
own persistent contract records and key metadata. Signing functions take a
`Signers` record, built once per wallet: the `ContractSignerProvider` that
answers for the contract key, implemented by the app or by the built-in
`ContractKeyProvider`, and the wallet that signs the party's funding inputs.
DDK prepares the transactions, asks each for what it signs, and verifies the
returned signatures.

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
     contractCetTransaction                contractRefundTransaction
   (oracles attested → pays                (locktime passed → returns
    the attested outcome)                    each party its collateral)
```

Each party's wallet signs its own funding inputs on the shared PSBT inside
`signAccept` (the offerer) and `finalizeSign` (the acceptor). The wallet is
anything that speaks BIP-174, or the built-in `DescriptorWallet` over a private
output descriptor.

Settlement needs no key. Both halves of the 2-of-2 are in the messages: the
refund signatures in the clear, and the CET signatures as adaptor signatures
that the oracle's attestation decrypts. Either party builds the same transaction
from the three messages.

### Walkthrough

Both packages expose these as free functions with identical names and argument
order, and both represent bytes as `Uint8Array`. In Node a `Buffer` is a
`Uint8Array`, so it can be passed anywhere bytes are taken.

```typescript
import {
  ContractKeyProvider,
  DescriptorWallet,
  Signers,
  Party,
  chainHashFromNetwork,
  fundingInput,
  createOffer,
  validateOffer,
  acceptOffer,
  validateAccept,
  signAccept,
  validateSign,
  finalizeSign,
  computeContractId,
  offerTemporaryContractId,
  contractCetTransaction,
  contractRefundTransaction,
} from '@bennyblader/ddk'; // or '@bennyblader/ddk-rn'

// Keys stay in Rust. Only the funding pubkey comes out.
const offererKeys = ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR);
const acceptorKeys = ContractKeyProvider.fromMnemonic(
  ACCEPTOR_MNEMONIC,
  undefined,
  'regtest'
);
// What each party signs with, built once per wallet: its contract keys and
// the wallet that signs its funding inputs.
const offererSigners = new Signers(offererKeys).withWallet(
  new DescriptorWallet(OFFERER_DESCRIPTOR)
);
// acceptorWallet is any FundingWallet; a party that funds nothing skips withWallet.
const acceptorSigners = new Signers(acceptorKeys).withWallet(acceptorWallet);

const offerTempId = Buffer.alloc(32, 1); // 32 bytes, chosen by the offerer

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
validateOffer(offer, 0, 4_294_967_295, BigInt(Math.floor(Date.now() / 1000)));
const accepted = acceptOffer(
  offer,
  {
    party: {
      // Both parties derive their key from the offer's temporary id.
      fundingPubkey: acceptorKeys.fundingPubkey(offerTemporaryContractId(offer)),
      fundingInputs: [/* the acceptor's UTXOs */],
      payoutSpk: ACCEPTOR_SPK,
      changeSpk: ACCEPTOR_SPK,
    },
    minTimeoutInterval: 0,
    maxTimeoutInterval: 4_294_967_295,
    nowUnix: BigInt(Math.floor(Date.now() / 1000)), // the acceptor's clock
  },
  acceptorSigners
);

// 3. Sign — the offerer's wallet signs its funding inputs and its contract key
//    signs the refund and CETs; the sign message carries its half
validateAccept(offer, accepted.accept);
const signed = await signAccept(offer, accepted.accept, offererSigners);

// 4. Finalize — the acceptor's wallet signs its funding inputs; out comes the
//    fully signed funding transaction
validateSign(offer, accepted.accept, signed.sign);
const fundingTx = await finalizeSign(offer, accepted.accept, signed.sign, acceptorSigners);

const contractId = computeContractId(offer, accepted.accept); // the funded contract's id

// 5. Settle — a CET once the oracles attest…
const cet = contractCetTransaction(offer, accepted.accept, signed.sign, [
  { oracleIndex: 0, attestation: ATTESTATION },
]);

// …or the refund once refundLocktime passes
const refund = contractRefundTransaction(offer, accepted.accept, signed.sign);
```

Runnable versions of exactly this flow:

- `examples/node/src/contract.ts` — `pnpm contract`
- `examples/react-native/src/App.tsx` — the on-device demo the Maestro E2E drives

### Signers

`acceptOffer`, `signAccept` and `finalizeSign` take one `Signers` object. It
holds nothing about any contract, so build it once per wallet:

```typescript
class Signers {
  constructor(contractKeys: ContractSignerProvider); // the contract funding key
  withWallet(wallet: FundingWallet): Signers;        // the party's funding inputs; skip it if it funds nothing
}
interface FundingWallet {
  // Sign and finalize the inputs you own in this BIP-174 PSBT; leave the rest.
  signFundingPsbt(psbt: Uint8Array): Promise<Uint8Array>;
}
```

Every key is found from the messages: the refund and CETs use the party's
funding key, a splice input uses the previous contract's, and the wallet
recognises its inputs by script. The library builds the funding PSBT, hands it
to the wallet at the step that needs it (`signAccept` for the offerer,
`finalizeSign` for the acceptor) and verifies what comes back. `FundingWallet`
is one async method, so the wallet that holds the coins signs them: a bdk
wallet's `sign`, a node's `walletprocesspsbt`. Those two lifecycle calls are
therefore async; `acceptOffer` never asks the wallet and stays synchronous.

```typescript
const signers = new Signers(contractKeys).withWallet({
  async signFundingPsbt(bytes) {
    const psbt = new PartiallySignedTransaction(toBase64(bytes));
    await bdkWallet.sign(psbt);
    return fromBase64(await psbt.serialize());
  },
});
```

The built-in `DescriptorWallet` signs from a private `wpkh()` or `sh(wpkh())`
descriptor, trying wildcard indexes up to a lookahead (1000 by default) to find
its inputs. It is for tests and scripts that have a descriptor and no wallet.
`createFundingPsbt` remains for a wallet that signs outside these calls.

A contract-key signer that answers later, in another process, goes through the
external signing API below.

#### Contract keys

`contractKeys` is asked for a key by a `ContractKeyRequest`, whose every field
the library reads from the messages:

```typescript
interface ContractSignerProvider {
  getSigner(key: ContractKeyRequest): ContractSigner;
}
interface ContractKeyRequest {
  fundingPubkey: Uint8Array;        // the key that must sign, as published in the offer or accept
  temporaryContractId: Uint8Array;  // the offer's; for a splice input, recovered from the input
  contractId: Uint8Array;           // fund txid ⊕ temporary id ⊕ output index
}
interface ContractSigner {
  signEcdsa(sighash: Uint8Array): Uint8Array; // 64-byte compact signature
  signAdaptor(sighash: Uint8Array, adaptorPoint: Uint8Array): Uint8Array; // 162 bytes
}
```

The built-in `ContractKeyProvider` is one such provider, with nothing stored.
Both parties derive their key for a contract from the offer's temporary id, as
ddk-manager does: the offerer chooses the id, the acceptor reads it from the
offer. `getSigner` derives the key the request names and checks it reproduces
the published public key, trying DDK's older derivation scheme when the current
one does not. So a provider built from the seed signs in any process, with no
registration and nothing to restore. All four constructors remain available:
`fromMnemonic`, `fromSeed`, `fromXprv`, and `fromDescriptor`; `fromDescriptor`
uses the descriptor's extended private key, not its BIP84 path.

```typescript
const keys = ContractKeyProvider.fromMnemonic(mnemonic, passphrase, network);
// Offerer: publish the key for the id it chose.
const offerPubkey = keys.fundingPubkey(temporaryContractId);
// Acceptor: publish the key for the id the offer carries.
const acceptPubkey = keys.fundingPubkey(offerTemporaryContractId(offer));
// Signing, in this process or any later one, needs nothing else:
const signed = await signAccept(offer, accept, new Signers(keys).withWallet(wallet));
```

A consumer provider resolves the same request its own way, and can delegate
DDK-derived keys to the built-in provider:

```typescript
const signers: ContractSignerProvider = {
  getSigner(key) {
    const stored = contracts.findByContractId(key.contractId);
    if (stored?.legacyPath) return legacyWallet.signerForPath(stored.legacyPath);
    return keys.getSigner(key);
  },
};
```

`PrivateKeySigner.fromSecretKey` is available when the consumer derives a local
legacy key and wants Rust to perform ECDSA/adaptor signing. It imports a 32-byte
secret and exposes `publicKey`, `signEcdsa`, and `signAdaptor`. A consumer may
instead implement those methods without importing a private key into Rust.

Contract-key callbacks are synchronous. Preload the metadata needed for
lookup; use the external signing API for signers that need network access or
user approval. Settlement takes no signer.

### Splicing

A splice is an ordinary offer containing a DLC funding input. Add wallet inputs
to contribute collateral, or reduce the successor's collateral to withdraw it.

```typescript
const spliceInput = createDlcSpliceInput(
  prevOffer, prevAccept, prevSign,
  Party.Offer, // the new offerer's side in the previous contract
  200n,
);
// Put spliceInput and any additional wallet inputs in offerParams.party.fundingInputs.
const offer = createOffer(offerParams);
const accepted = acceptOffer(offer, acceptParams, acceptorSigners);
const signed = await signAccept(offer, accepted.accept, offererSigners);
const fundingTx = await finalizeSign(offer, accepted.accept, signed.sign, acceptorSigners);
```

Signing reads each DLC input's previous contract ID and required funding public
key from the offer and calls `contractKeys`; the wallet is only asked about the
wallet inputs. No previous-contract list or previous temporary ID is passed to
lifecycle functions. `splicedContractIds(offer)` remains
available for inspection. The previous sign message lets `createDlcSpliceInput`
rebuild contracts created under the old fee rule.

### External signing

Prepare transactions, ask the consumer's external signer for signatures, then
complete the message. Enum contracts are supported; preparing a numeric contract
returns `ContractError.Unsupported` in both the provider and external flows.

```typescript
// Acceptor: omitted output serial IDs are chosen once during preparation.
const preparedAccept = prepareAcceptOffer(offer, acceptParams);
// Persist preparedAccept.context while approval is pending. It contains
// offer/accept bytes, including the chosen serial IDs, and no private keys.
const acceptResponse = await custody.sign(preparedAccept.request);
const accepted = completeAcceptOffer(preparedAccept.context, acceptResponse.contract);

// Offerer
const preparedSign = prepareSignAccept(offer, accepted.accept);
const signResponse = await custody.sign(preparedSign.request);
const signed = completeSignAccept(preparedSign.context, {
  contract: signResponse.contract,
  signedFundingPsbt: offererSignedPsbt,
  dlcInputSignatures: signResponse.dlcInputSignatures,
});

// Acceptor: once the offerer's sign message verifies, sign its half of each
// spliced input. Empty dlcInputs means the unsigned funding PSBT is enough.
const finalizeRequest = prepareFinalizeSign(offer, accepted.accept, signed.sign);
const fundingTx = finalizeSignWithSignatures(
  offer, accepted.accept, signed.sign, acceptorSignedPsbt,
  await custody.signSplice(finalizeRequest),
);
```

A request includes refund/CET PSBTs, each CET's adaptor point, and the funding
PSBT. Its `splice.dlcInputs` entries contain `{ inputIndex, key }`, with the
required funding public key and previous contract ID. DDK derives this
information from the messages; the custody adapter maps keys to its own signer
identities. The accept request lists the acceptor's splice halves too, so a
signer may produce them at either step.

Contract and splice signatures are verified before completion. Wallet inputs
must carry finalized witnesses in the funding PSBT. Refund and splice signatures
are 64-byte compact ECDSA with SIGHASH_ALL; adaptor signatures are 162 bytes in
request order. The consumer adapter handles the custody service's encodings.

### Validation and inspection

The lifecycle functions validate internally, but each check is also exposed
standalone so a stored or received message can be verified on its own:

| Function | Checks |
|---|---|
| `validateOffer(offer, minTimeout, maxTimeout, nowUnix)` | protocol version, funding inputs, fee rate, collateral, oracle timeouts, oracle event not yet matured |
| `validateAccept(offer, accept)` | the acceptor's CET adaptor signatures and refund signature |
| `validateSign(offer, accept, sign)` | the offerer's CET adaptor signatures and refund signature |
| `computeContractId(offer, accept)` | — returns the funded contract's 32-byte id |
| `offerTemporaryContractId(offer)` | — returns the offer's 32-byte temporary id, which both parties derive their keys from |
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
  nowUnix: bigint; // the acceptor's clock, unix seconds; a matured oracle event is rejected
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

interface SigningRequest {
  key: ContractKeyRequest; // the key every refund and CET signature verifies against
  refundPsbt: Bytes;
  cets: CetSigningRequest[]; // one per adaptor signature, in return order
  splice: SpliceSigningRequest; // this party's halves of the spliced inputs
}

interface SpliceSigningRequest {
  // also what prepareFinalizeSign returns
  fundingPsbt: Bytes; // DLC inputs carry witness_utxo + witness_script
  dlcInputs: { inputIndex: number; key: ContractKeyRequest }[];
}

interface CetSigningRequest {
  psbt: Bytes;
  adaptorPoint: Bytes; // 33 bytes
}

interface ContractSignatures {
  refundSignature: Bytes; // 64-byte compact ECDSA, SIGHASH_ALL
  cetAdaptorSignatures: Bytes[]; // 162 bytes each
}

interface DlcInputSignature {
  inputIndex: number;
  signature: Bytes; // 64-byte compact ECDSA, SIGHASH_ALL
}

interface OracleAttestationRef {
  oracleIndex: number; // position in the contract info's announcements
  attestation: Bytes; // wire-encoded OracleAttestation
}

class Signers {
  constructor(contractKeys: ContractSignerProvider);
  withWallet(wallet: FundingWallet): Signers;
}

interface FundingWallet {
  signFundingPsbt(psbt: Bytes): Promise<Bytes>; // BIP-174 in, BIP-174 with this wallet's inputs finalized out
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
`@bennyblader/ddk` takes one anywhere bytes are expected; returns are plain `Uint8Array`,
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

`ffi/src/` is the single source of truth for the interface. It is annotated
with UniFFI **proc-macros** (`#[derive(uniffi::Record)]`, `#[uniffi::export]`,
…) — there is no `.udl` file — and **both** packages are generated from the
compiled library by `uniffi-bindgen-react-native`: the JSI/C++ bindings for React
Native, and the N-API and wasm bindings for Node and browsers. Neither contains hand-written binding
code, so the Rust source and the generated TypeScript, C++, Swift, and Kotlin
cannot drift — from the crate or from each other.

That leaves one thing worth checking rather than three:

1. CI regenerates `packages/node-browser/{node,browser}/generated` and fails if it differs from what is committed
2. `packages/react-native/src/__tests__/contractBindings.test.js` checks that the generated JSI
   surface is complete — every function, record, and constructor present in both
   the TypeScript and the native symbol layer
3. `tests/conformance/contract.spec.ts` drives the full lifecycle end to end,
   including a splice rollover and the failure modes — against N-API and wasm

## 🛠️ Development

### Prerequisites

- Rust (latest stable)
- Node.js 20+
- pnpm
- Just (`cargo install just`)
- Android: `cargo install cargo-ndk --locked` and NDK 27.1.12297006
- The binding generator is installed by `pnpm install` at the root lockfile version.

### Project Structure

```text
ffi/                         # Shared Rust interface and UniFFI configuration
packages/
  node-browser/              # @bennyblader/ddk
    node/                    # Native loader and generated N-API bindings
    browser/                 # WASM loader and generated browser bindings
    scripts/                 # Build and release this package
  react-native/              # @bennyblader/ddk-rn
    src/generated/           # Generated TypeScript and TurboModule spec
    ios/                     # iOS adapter and XCFramework
    android/                 # Android adapter and JNI libraries
    cpp/                     # Generated JSI bindings
    justfile                 # Native build and device-test recipes
examples/
  node/
  browser/
  react-native/
tests/
  conformance/               # Shared Node/WASM contract tests
  compatibility/             # BAL interoperability and mobile replay vectors
justfile                     # Repository command entrypoint
```

### Development commands

Run these from the repository root:

```sh
just install
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

just build react-native ios
just build react-native android
just native example-ios      # Install CocoaPods for the mobile example
just example react-native ios
just example react-native android
just test react-native ios
just test react-native android
```

Node and browser remain one npm package. The package's export conditions select
the implementation; consumers keep importing `@bennyblader/ddk`.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for prerequisites, native diagnostics and
the release process. Native builds must be rebuilt after changing Rust exports.

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! Please ensure:

1. Checks and the relevant runtime tests pass (`just check`, `just test <runtime>`)
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

### Turborepo builds and remote cache

Run `pnpm install --frozen-lockfile` at the repository root. One pnpm workspace
owns both packages, all examples, and the compatibility tests. Package scripts
still own their toolchains; Turbo schedules them and caches their outputs.

```sh
pnpm build:node          # Native Node library, generated TS, and local link
pnpm build:browser       # WASM and generated browser bindings
pnpm build:ios           # iOS XCFramework and React Native bindings
pnpm build:android       # Android JNI libraries and React Native bindings
pnpm build:app:ios       # Bindings, then a Release simulator app
pnpm build:app:android   # Bindings, then a Release APK
pnpm check
pnpm format
```

Use `pnpm turbo`, which fingerprints the installed Rust, Node, C compiler,
Xcode/SDK, Java, and NDK toolchains before calling Turbo. Native caches are
separate for different hosts and toolchains. Build inputs include the Rust
sources, Cargo lockfile, binding configuration, and the workspace lockfile.
Changes confined to the example do not invalidate the native binding task.
Checks and formatting always execute. Device tests continue to run against the
built apps, including apps restored from cache.

The first binding generation also compiles the workspace's pinned UniFFI CLI.
Cargo, Xcode, and Gradle retain their incremental caches for builds that miss
Turbo's artifact cache. Turbo stores the finished libraries/apps, not entire
compiler working directories.

#### Try a fresh build and a cache hit

```sh
pnpm clean:all
pnpm build:node           # May restore from Vercel if a matching build exists
pnpm build:node           # Look for "cache hit" and the Cached task count
pnpm clean               # Remove outputs but keep local/remote Turbo caches
pnpm build:node           # Restore the library without compiling it
just example node
```

For a guaranteed fresh compile even when Vercel has the artifacts:

```sh
pnpm clean:all
pnpm turbo run link:node --filter=@bennyblader/ddk --force
pnpm build:node
```

`pnpm clean` removes repository build outputs and compiler working directories.
`pnpm clean:all` also clears the local Turbo cache. Both preserve installed
packages, committed generated source, SDKs, and Vercel's shared cache.

#### Remote caching

```sh
pnpm exec turbo login
pnpm exec turbo link
```

Select the Vercel team that owns the cache. Each developer authenticates on their
own machine; the local association and credentials are not committed.
GitHub Actions uses the `TURBO_TEAM` repository variable and a Vercel OIDC
policy restricted to this repository and `.github/workflows/ci.yml`. The workflow
exchanges GitHub identity for a short-lived cache token. Fork PRs build without
remote-cache credentials.
