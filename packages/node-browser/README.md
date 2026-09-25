# @bennyblader/ddk

Bindings for the DLC Dev Kit (DDK) in Node.js and browsers, generated from the
`ddk-ffi` Rust crate by `uniffi-bindgen-react-native`. There is no hand-written
binding code here — the same crate produces this package and
`@bennyblader/ddk-rn`, so they cannot drift apart.

It replaces `@bennyblader/ddk-ts`: same API, plus a browser build.

## Installation

```bash
npm install @bennyblader/ddk
# or
pnpm add @bennyblader/ddk
```

One import, two bindings. The package's `exports` conditions choose at resolve
time, so no code runs to decide and a browser bundle never contains the Node
binding:

| Environment                 | Binding        | Where it comes from                              |
| --------------------------- | -------------- | ------------------------------------------------ |
| Node                        | N-API (native) | a prebuilt `@bennyblader/ddk-<platform>` package |
| Browsers, and anything else | WebAssembly    | `ddk_ffi.wasm`, inside this package              |

Nothing is compiled on install. npm picks the one platform package that matches
the machine through `optionalDependencies` (by `os`/`cpu`); no install script
runs:

- macOS ARM64 (Apple Silicon) — `@bennyblader/ddk-darwin-arm64`
- Linux x64 (glibc) — `@bennyblader/ddk-linux-x64-gnu`

**On Node, a machine with no platform package throws at import** instead of
quietly using the slower wasm build. To run there anyway, import
`@bennyblader/ddk/wasm` explicitly (see below).

Prereleases publish to the `next` dist-tag: `npm install @bennyblader/ddk@next`.

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
import { init, version, createFundTxLockingScript } from '@bennyblader/ddk'

await init() // once: loads the wasm in a browser; a no-op on Node
console.log(`DDK Version: ${version()}`)
```

Every call is synchronous. `init()` is the one asynchronous step, and code that
only ever runs on Node can skip it.

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
} from '@bennyblader/ddk'

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

`../../examples/node/src/contract.ts` runs the complete flow — offer to settlement, offline
and deterministic:

```bash
pnpm example:contract
```

For complete API documentation, see the [main README](../../README.md#-the-contract-api).

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
- The pinned binding generator, installed with the root pnpm workspace.

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

### Development layout

```text
packages/node-browser/
  node/index.ts              # Handwritten native loader
  node/generated/            # Generated N-API bindings
  browser/index.ts           # Handwritten WASM loader
  browser/generated/         # Generated WASM bindings
  scripts/                   # Generation, builds and publishing
  dist/                      # Published JavaScript, types and WASM
  platform/                  # Native binary packages
```

Examples live in `../../examples/node/` and `../../examples/browser/`. Shared
runtime tests live in `../../tests/conformance/`. The root pnpm workspace
includes both packages, all examples, and the shared tests.

From the repository root:

```sh
just build node
just build browser
just test node
just test browser
just example node
just example browser
```

### Testing

```bash
pnpm generate:debug  # the tests import dist/node/, so build it first
pnpm test
pnpm build:wasm:debug
pnpm test:wasm       # the same specs, against dist/wasm/
```

`../../tests/conformance/contract.spec.ts` drives the complete lifecycle offer-to-settlement,
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
and in the publish workflow's build matrix. Every other platform can use
`@bennyblader/ddk/wasm` — see below.

### Release Process

`ddk` and `ddk-rn` are versioned and released together:

```bash
just release 0.5.0
```

This will:

1. Check the working directory is clean
2. Set the version in `packages/node-browser/package.json`, `packages/react-native/package.json` and `ffi/Cargo.toml`
3. Commit, tag as `v0.5.0` and push

Publishing happens in CI. Pushing the tag triggers
[`.github/workflows/publish.yml`](../../.github/workflows/publish.yml), which builds
one cdylib per platform on its own runner, and the wasm module once, and then runs
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
drift they existed to catch; CI instead checks that the committed
`node/generated/` and `browser/generated/` still matches the crate.

### Browsers and wasm

In a browser, `@bennyblader/ddk` resolves to a WebAssembly build of the same
crate, with the same API. `@bennyblader/ddk/wasm` selects that build explicitly
in any environment — for example Node on a platform with no native binary.
Prefer the native binding where there is one: wasm is slower.

```typescript
import { init, version } from '@bennyblader/ddk' // or '@bennyblader/ddk/wasm'

await init() // required before any other call
console.log(version())
```

Here `init()` does real work: it fetches and
instantiates `ddk_ffi.wasm` (4.8MB, 2.9MB gzipped), which the package locates
through `new URL(..., import.meta.url)`; Vite, webpack 5, Rollup and Parcel copy
the file and rewrite that URL at build time. To serve the file from somewhere
else, pass its location: `init(url | path | Response | bytes)`. No
cross-origin isolation (COOP/COEP headers) is needed.

Under **Vite's dev server**, exclude the package from dependency pre-bundling —
pre-bundling moves it into `.vite/deps`, where the relative URL no longer
resolves. `vite build` needs nothing:

```typescript
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ['@bennyblader/ddk'] } })
```

`../../examples/browser/` is a working Vite app; `pnpm smoke` there builds it and loads
it in headless Chrome.

## Troubleshooting

### Missing Binary

`@bennyblader/ddk has no native library for <platform>`, thrown at import, means
npm installed no platform package for this machine — check the table above, and
check that the `@bennyblader/ddk-<triple>` optionalDependency was not skipped by
an `--omit=optional` install. Either install a supported platform's package, or
import `@bennyblader/ddk/wasm`. From a checkout, `pnpm generate` builds and links
the host one.

### ESM only

`require('@bennyblader/ddk')` will not work. The generated resolver locates
the platform package through `import.meta.url`, which has no CommonJS equivalent,
so a dual build would break it. Use `import`, and set `"type": "module"` (or use
`.mjs`) in a consuming package.

### BigInt Support

All 64-bit integers are represented as JavaScript `BigInt`. Make sure your Node.js version supports BigInt (Node.js 10.4.0+).

## License

MIT
