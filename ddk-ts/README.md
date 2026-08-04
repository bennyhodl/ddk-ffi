# @bennyblader/ddk-ts

TypeScript/Node.js bindings for the DLC Dev Kit (DDK) - NAPI-RS based native bindings for Node.js applications.

## Installation

```bash
npm install @bennyblader/ddk-ts
# or
pnpm add @bennyblader/ddk-ts
```

Nothing is compiled on install. Prebuilt platform binaries arrive through
`optionalDependencies`:

- macOS ARM64 (Apple Silicon) — `@bennyblader/ddk-ts-darwin-arm64`
- Linux x64 (glibc) — `@bennyblader/ddk-ts-linux-x64-gnu`
- `wasm32-wasip1-threads` — `@bennyblader/ddk-ts-wasm32-wasi`, the fallback for
  any platform not in the matrix

Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk-ts@next`.

## Quick Start

```typescript
import { version, createFundTxLockingScript } from '@bennyblader/ddk-ts'

console.log(`DDK Version: ${version()}`)
```

### The contract API

The whole DLC lifecycle, with no contract store — every transaction is rebuilt
from the offer/accept/sign wire messages when it is needed, and funding secret
keys stay inside Rust behind a `ContractKeyProvider`.

```typescript
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  createOffer,
  acceptOffer,
  signAccept,
  finalizeSign,
  signContractCet,
} from '@bennyblader/ddk-ts'

const keys = ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest')
const temporaryContractId = Buffer.alloc(32, 1)

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
})
// …acceptOffer → sign the funding PSBT → signAccept → finalizeSign →
//   signContractCet / signContractRefund
```

`example/src/contract.ts` runs the complete flow — offer to settlement, offline
and deterministic:

```bash
cd example && pnpm contract
```

For complete API documentation, see the [main README](../README.md#-the-contract-api).

### Errors

A thrown error exposes the Rust variant as `error.code` (`'InvalidOffer'`,
`'NoMatchingOutcome'`, `'InvalidPublicKey'`, `'KeyError'`, …) with the `Display`
string as `error.message`.

## Development

### Prerequisites

- Node.js >= 18
- Rust >= 1.70
- pnpm
- NAPI-RS CLI: `npm install -g @napi-rs/cli`

### Building from Source

```bash
# Install dependencies
pnpm install

# Build for current platform
pnpm build

# Build for all supported platforms (Darwin ARM64 and Linux x64)
pnpm build:all

# Build the WASI fallback
pnpm build:wasm
```

### Just Commands

```bash
# Build TypeScript bindings for current platform
just ts-build

# Build for all supported platforms
just ts-build-all

# Run example
just ts-example

# Run tests
just ts-test

# Release new version (bumps both packages, tags, pushes; CI publishes)
just release <version>
```

### Project Structure

```
ddk-ts/
├── src/                # Rust NAPI-RS source code
│   ├── lib.rs          # transaction API wrappers
│   ├── contract.rs     # stateless contract API
│   ├── types.rs        # type definitions
│   ├── conversions.rs  # Rust ↔ JS type conversions
│   └── error.rs        # DLCError/ContractError → JS error codes
├── dist/               # Generated output (git-ignored, shipped in the tarball)
│   ├── index.js        # main entry point (generated)
│   ├── index.d.ts      # TypeScript definitions (generated)
│   └── *.node / *.wasm # the native binary for this platform
├── example/            # Example TypeScript application
├── example-browser/    # Vite example against the WASM build
├── __test__/           # vitest suites
└── scripts/            # Verification scripts
    ├── verify-parity.cjs # every ddk-ffi export is exposed here
    └── verify-types.cjs  # the generated type definitions are complete
```

### Testing

```bash
# Run all tests
pnpm test

# Rust unit tests, verification, and the vitest suites together
pnpm test:all

# Run verification scripts
pnpm verify        # Run all verification checks
pnpm verify:parity # Check API parity with the ddk-ffi interface
pnpm verify:types  # Verify TypeScript types
```

`__test__/contract.spec.ts` drives the complete lifecycle offer-to-settlement,
including a splice-out rollover and the failure modes that matter: a forged
attestation, an outcome no CET covers, and a splice key derived from the wrong
party's prior contract.

### Platform Support

| Platform | Architecture          | Status                |
| -------- | --------------------- | --------------------- |
| macOS    | ARM64 (Apple Silicon) | ✅ Native binary      |
| Linux    | x64 (glibc)           | ✅ Native binary      |
| Any      | WASI                  | ✅ WASM fallback      |
| macOS    | x64 (Intel)           | ⚠️ WASM fallback only |
| Windows  | x64                   | ⚠️ WASM fallback only |
| Linux    | ARM64                 | ⚠️ WASM fallback only |

### Release Process

`ddk-ts` and `ddk-rn` are versioned and released together:

```bash
just release 0.5.0
```

This will:

1. Check the working directory is clean
2. Set the version in `ddk-ts/package.json`, `ddk-rn/package.json` and `ddk-ffi/Cargo.toml`
3. Commit, tag as `v0.5.0` and push

Publishing happens in CI. Pushing the tag triggers
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which builds
each napi platform binary on its own runner, verifies parity and types, and
publishes. Nothing is published from a developer machine — no single host can
build every platform this repo ships.

A prerelease version (`just release 0.5.0-rc1`) publishes to the `next`
dist-tag rather than `latest`.

### API Compatibility

These bindings are hand-written NAPI over the same crates `ddk-ffi` wraps, so
parity with `@bennyblader/ddk-rn` is enforced rather than free. The
[verify-parity.cjs](scripts/verify-parity.cjs) script checks that every function
`ddk-ffi` exports is exposed here; `verify-types.cjs` checks the generated type
definitions. Both run in CI and in `pnpm verify`.

Two intentional differences from `ddk-rn`: bytes are `Buffer` here and
`ArrayBuffer` there, and a dozen transaction operations that UniFFI attaches to
records (`TxOutput.isDust`, `Transaction.signCet`, …) are free functions here,
because NAPI has no equivalent. See the [comparison
table](../README.md#where-the-two-packages-differ).

## Troubleshooting

### Missing Binary

If you get an error about missing binaries, ensure your platform is supported or build from source:

```bash
pnpm build
```

### ESM imports

The package is CommonJS. `require` and a default `import` from an ESM file both
work; the browser/WASM entries (`dist/browser.js`,
`dist/ddk-ts.wasi-browser.js`) are ESM and will not resolve under it — the Node
bindings are the supported path.

### BigInt Support

All 64-bit integers are represented as JavaScript `BigInt`. Make sure your Node.js version supports BigInt (Node.js 10.4.0+).

## License

MIT
