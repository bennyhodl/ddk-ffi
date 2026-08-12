# @bennyblader/ddk-ts

TypeScript/Node.js bindings for the DLC Dev Kit (DDK), generated from the
`ddk-ffi` Rust crate by `uniffi-bindgen-react-native`'s N-API target. There is no
hand-written binding code here — the same crate produces these and
`@bennyblader/ddk-rn`, so the two cannot drift apart.

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

Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk-ts@next`.

The package is **ESM-only**: the generated library resolver uses
`import.meta.url`, so it cannot be `require`d.

### Bytes

Every `Vec<u8>` crosses the boundary as a `Uint8Array`. Node's `Buffer` is a
`Uint8Array` subclass, so **arguments take a Buffer unchanged**; only return
values differ, and wrapping one is zero-copy:

```typescript
const bytes = createFundTxLockingScript(localPubkey, remotePubkey) // Uint8Array
Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
```

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

A thrown error is a typed variant class carrying the Rust variant name in
`error.tag` (`'InvalidOffer'`, `'NoMatchingOutcome'`, `'InvalidPublicKey'`,
`'KeyError'`, …), with the `Display` string in `error.inner.message`. Switch on
`ContractError_Tags` / `DlcError_Tags`, or narrow with
`ContractError.NoMatchingOutcome.instanceOf(e)`.

## Development

### Prerequisites

- Node.js >= 18
- Rust >= 1.70
- pnpm
- `uniffi-bindgen-react-native`, at the version ddk-rn pins:
  `pnpm add -g uniffi-bindgen-react-native@0.31.0-3`

### Building from Source

```bash
# Install dependencies
pnpm install

# Build the ddk-ffi cdylib, generate the bindings from it, compile, and link
# the host platform package into node_modules
pnpm generate

# Same, with a debug cdylib — faster, and what the CI gate runs
pnpm generate:debug

# Build every published platform (needs the cross toolchains; CI does one per host)
pnpm build
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
├── src/                # GENERATED bindings — committed, never hand-edited
│   ├── ddk_ffi.ts      # the public API
│   ├── ddk_ffi-ffi.ts  # the FFI layer + the cdylib resolver
│   └── index.ts        # entry point
├── dist/               # tsc output (git-ignored, shipped in the tarball)
├── platform/           # one npm package per target (git-ignored)
│   └── darwin-arm64/   # package.json + libddk_ffi.dylib
├── example/            # Example TypeScript application
├── __test__/           # vitest suites, run against dist/
└── scripts/
    ├── build-release.mjs   # cargo build → generate → tsc → platform packages
    ├── publish-release.mjs # platform packages first, then the main package
    ├── fix-esm-imports.mjs # ubrn emits extensionless imports; Node ESM rejects them
    └── verify-package.mjs  # prepublishOnly guard
```

### Testing

```bash
pnpm generate:debug  # the tests import dist/, so build it first
pnpm test
```

`__test__/contract.spec.ts` drives the complete lifecycle offer-to-settlement,
including a splice-out rollover and the failure modes that matter: a forged
attestation, an outcome no CET covers, and a splice key derived from the wrong
party's prior contract.

### Platform Support

| Platform | Architecture          | Status           |
| -------- | --------------------- | ---------------- |
| macOS    | ARM64 (Apple Silicon) | ✅ Native binary |
| Linux    | x64 (glibc)           | ✅ Native binary |

Other targets (macOS x64, Windows x64, Linux ARM64) are already mapped in
`scripts/build-release.mjs`; adding one means listing it there under `PUBLISHED`
and in the publish workflow's build matrix. The browser is a separate question —
see the note below.

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
one cdylib per platform on its own runner and then runs
`scripts/publish-release.mjs`: platform packages first, then the main package
with its `optionalDependencies` filled in. Nothing is published from a developer
machine — no single host can build every platform this repo ships, and
`prepublishOnly` refuses a hand-run `npm publish` that would ship no library.

A prerelease version (`just release 0.5.0-rc1`) publishes to the `next`
dist-tag rather than `latest`.

### API Compatibility

Parity with `@bennyblader/ddk-rn` is now structural rather than enforced: both
packages are generated from the same `ddk-ffi` crate by the same bindgen, so the
same names, the same argument lists and the same `Uint8Array` byte type appear on
both. The old `verify-parity.cjs` / `verify-types.cjs` scripts are gone with the
drift they existed to catch; CI instead checks that the committed `src/` still
matches the crate.

### The browser

There is no browser build at the moment. It previously came from napi-rs plus
`wasm32-wasip1-threads` and emnapi, which the N-API generator structurally cannot
produce — `@ubjs/node` dlopens a native cdylib, and neither dlopen nor native
addons exist in a browser. ubrn has a separate `generate wasm` path
(wasm-bindgen, `wasm32-unknown-unknown`) that restores it from this same crate;
that is tracked as follow-up work, not a dead end.

## Troubleshooting

### Missing Binary

A `ResolveLibPathError` at the first call means npm installed no platform
package for this machine — check the table above, and check that the
`@bennyblader/ddk-ts-<triple>` optionalDependency was not skipped by an
`--omit=optional` install. From a checkout, `pnpm generate` builds and links the
host one.

### ESM only

`require('@bennyblader/ddk-ts')` will not work. The generated resolver locates
the platform package through `import.meta.url`, which has no CommonJS equivalent,
so a dual build would break it. Use `import`, and set `"type": "module"` (or use
`.mjs`) in a consuming package.

### BigInt Support

All 64-bit integers are represented as JavaScript `BigInt`. Make sure your Node.js version supports BigInt (Node.js 10.4.0+).

## License

MIT
