# DLC Dev Kit FFI Bindings

**Rust-powered DLC (Discreet Log Contracts) bindings for JavaScript environments**

This repository provides high-performance Rust bindings for the [rust-dlc](https://github.com/p2pderivatives/rust-dlc) library, making DLC functionality available in:

- **Node.js/TypeScript**: [@bennyblader/ddk-ts](./ddk-ts) - NAPI-RS based native bindings
- **React Native**: [@bennyblader/ddk-rn](./ddk-rn) - UniFFI-based native bindings with JSI

[![GitHub](https://img.shields.io/github/license/bennyhodl/ddk-ffi)](https://github.com/bennyhodl/ddk-ffi/blob/master/LICENSE)

## 📦 Packages

### [@bennyblader/ddk-ts](./ddk-ts) - Node.js/TypeScript

Native Node.js bindings using NAPI-RS for server-side applications, CLI tools, and desktop apps.

```bash
npm install @bennyblader/ddk-ts
```

**Features:**

- Zero-copy data transfer via NAPI
- Prebuilt binaries for macOS ARM64 and Linux x64
- Full TypeScript support
- Synchronous API for performance

[View package documentation →](./ddk-ts/README.md)

### [@bennyblader/ddk-rn](./ddk-rn) - React Native

React Native bindings using UniFFI for mobile DLC applications.

```bash
npm install @bennyblader/ddk-rn
```

**Features:**

- JSI-based high-performance bridge
- iOS and Android support
- React Native 0.75+ with new architecture
- TurboModule optimizations

[View package documentation →](./ddk-rn/README.md)

## 🎯 API Reference

Both packages expose the same API, ensuring complete compatibility across platforms. The API is generated from UniFFI definitions, guaranteeing consistency.

### Core Functions

#### `version(): string`

Returns the version of the DDK library.

```typescript
const ddkVersion = version();
console.log(`DDK Version: ${ddkVersion}`);
```

### Transaction Creation

#### `createDlcTransactions()`

Creates a complete set of DLC transactions including funding, CETs, and refund.

```typescript
createDlcTransactions(
  outcomes: DlcOutcome[],
  localParams: PartyParams,
  remoteParams: PartyParams,
  refundLocktime: number,
  feeRate: bigint,
  fundLockTime: number,
  cetLockTime: number,
  fundOutputSerialId: bigint
): DlcTransactions
```

#### `createFundTxLockingScript()`

Creates a 2-of-2 multisig locking script for the funding transaction.

```typescript
createFundTxLockingScript(
  localFundPubkey: Buffer,
  remoteFundPubkey: Buffer
): Buffer
```

#### `createCets()`

Creates Contract Execution Transactions for all possible outcomes.

```typescript
createCets(
  fundTxId: string,
  fundVout: number,
  localFinalScriptPubkey: Buffer,
  remoteFinalScriptPubkey: Buffer,
  outcomes: DlcOutcome[],
  lockTime: number,
  localSerialId: bigint,
  remoteSerialId: bigint
): Transaction[]
```

#### `createRefundTransaction()`

Creates a refund transaction with CSV timelock.

```typescript
createRefundTransaction(
  localFinalScriptPubkey: Buffer,
  remoteFinalScriptPubkey: Buffer,
  localAmount: bigint,
  remoteAmount: bigint,
  lockTime: number,
  fundTxId: string,
  fundVout: number
): Transaction
```

### Signing & Verification

#### `signFundTransactionInput()`

Signs a funding transaction input.

```typescript
signFundTransactionInput(
  fundTransaction: Transaction,
  privkey: Buffer,
  prevTxId: string,
  prevTxVout: number,
  value: bigint
): Transaction
```

#### `verifyFundTxSignature()`

Verifies a signature on a funding transaction.

```typescript
verifyFundTxSignature(
  fundTx: Transaction,
  signature: Buffer,
  pubkey: Buffer,
  txid: string,
  vout: number,
  inputAmount: bigint
): boolean
```

#### `createCetAdaptorSignatureFromOracleInfo()`

Creates adaptor signatures for oracle-based execution.

```typescript
createCetAdaptorSignatureFromOracleInfo(
  cet: Transaction,
  oracleInfo: OracleInfo,
  fundingSk: Buffer,
  fundingScriptPubkey: Buffer,
  totalCollateral: bigint,
  msgs: Buffer[]
): AdaptorSignature
```

### Utility Functions

#### `isDustOutput()`

Checks if an output is below the dust threshold.

```typescript
isDustOutput(output: TxOutput): boolean
```

#### `getTotalInputVsize()`

Calculates the virtual size of inputs for fee estimation.

```typescript
getTotalInputVsize(inputs: TxInputInfo[]): number
```

#### `getChangeOutputAndFees()`

Calculates change outputs and fees for a party.

```typescript
getChangeOutputAndFees(
  params: PartyParams,
  feeRate: bigint
): ChangeOutputAndFees
```

### Type Definitions

```typescript
interface Transaction {
  version: number;
  lockTime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  rawBytes: Buffer;
}

interface TxOutput {
  value: bigint;
  scriptPubkey: Buffer;
}

interface TxInput {
  txid: string;
  vout: number;
  scriptSig: Buffer;
  sequence: number;
  witness: Buffer[];
}

interface TxInputInfo {
  txid: string;
  vout: number;
  scriptSig: Buffer;
  maxWitnessLength: number;
  serialId: bigint;
}

interface DlcOutcome {
  localPayout: bigint;
  remotePayout: bigint;
}

interface PartyParams {
  fundPubkey: Buffer;
  changeScriptPubkey: Buffer;
  changeSerialId: bigint;
  payoutScriptPubkey: Buffer;
  payoutSerialId: bigint;
  inputs: TxInputInfo[];
  inputAmount: bigint;
  collateral: bigint;
  dlcInputs: DlcInputInfo[];
}

interface DlcTransactions {
  fund: Transaction;
  cets: Transaction[];
  refund: Transaction;
  fundingScriptPubkey: Buffer;
}

interface OracleInfo {
  publicKey: Buffer;
  nonces: Buffer[];
}

interface AdaptorSignature {
  signature: Buffer;
  proof: Buffer;
}

interface ChangeOutputAndFees {
  changeOutput: TxOutput;
  fundFee: bigint;
  cetFee: bigint;
}
```

## 🏗️ Architecture

Both packages follow a **pure wrapper approach** around rust-dlc:

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────┐
│   JavaScript    │    │   Generated  │    │    Rust     │
│   Application   │───▶│   Bindings   │───▶│   rust-dlc  │
│                 │    │  (TS + FFI)  │    │   (Core)    │
└─────────────────┘    └──────────────┘    └─────────────┘
```

### API Compatibility

The packages maintain 100% API compatibility through:

1. **Shared UDL**: Single UniFFI Definition Language file defines the interface
2. **Verification Scripts**: Automated checks ensure parity between implementations
3. **Type Safety**: Full TypeScript definitions generated from UDL
4. **Testing**: Comprehensive test suites verify behavior consistency

View the [compatibility verification script](./ddk-ts/scripts/verify-parity.cjs) that ensures both packages expose identical APIs.

## 🛠️ Development

### Prerequisites

- Rust (latest stable)
- Node.js 18+
- Just (`cargo install just`)

### Project Structure

```
.
├── ddk-ffi/           # Rust crate with UniFFI definitions
│   ├── src/
│   │   ├── lib.rs     # Rust implementation
│   │   └── ddk_ffi.udl # UniFFI interface definitions
│   └── Cargo.toml
│
├── ddk-ts/            # Node.js/TypeScript package
│   ├── src-napi/      # NAPI-RS Rust source
│   ├── src/           # Generated JS/TS
│   └── README.md
│
├── ddk-rn/            # React Native package
│   ├── src/           # Generated TypeScript
│   ├── cpp/           # Generated C++ JSI bindings
│   ├── ios/           # iOS native module
│   ├── android/       # Android native module
│   └── README.md
│
└── justfile           # Build automation
```

### Quick Commands

```bash
# TypeScript/Node.js
just ts-build          # Build for current platform
just ts-build-all      # Build for all platforms
just ts-test           # Run tests

# React Native
just uniffi            # Generate all bindings
just build-ios         # Build iOS
just build-android     # Build Android

# Release both packages (bumps versions, tags, pushes; CI publishes)
just release 0.2.0

# Clean everything
just clean
```

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! Please ensure:

1. All tests pass (`cargo test`, `pnpm test`)
2. Bindings are regenerated when changing Rust code
3. API compatibility is maintained
4. Documentation is updated

## 🔗 Links

- **GitHub**: https://github.com/bennyhodl/ddk-ffi
- **rust-dlc**: https://github.com/p2pderivatives/rust-dlc
- **NAPI-RS**: https://napi.rs
- **UniFFI**: https://mozilla.github.io/uniffi-rs/

---

Built with ❤️ using [rust-dlc](https://github.com/p2pderivatives/rust-dlc)
