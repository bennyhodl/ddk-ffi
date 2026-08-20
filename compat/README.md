# ddk ↔ bitcoin-abstraction-layer compatibility suite

Proves that ddk's contract/message API (ddk-ts and ddk-rn, generated from
`ddk-ffi`) is wire- and lifecycle-compatible with the stack lygos is migrating
away from: **bitcoin-abstraction-layer (BAL)** + **@node-dlc 1.2.1**. The BAL
party in every test runs the **latest published npm release**
(`@atomicfinance/* 4.3.6`) paired with the ddk-ts release production ships as
its engine (`@bennyblader/ddk-ts@0.3.42`) — the exact combination lygos-app
and orange-grove run — while the ddk party runs this repo's ddk-ts. The two
sides exchange nothing but wire bytes.

Two dependency details make that pairing work:

- The 0.3.42 engine is installed under the **`bal-ddk-ts` alias** so it can
  coexist with the `link:../ddk-ts` the ddk party tests.
- It carries a **pnpm patch** (`patches/`, wired in `pnpm-workspace.yaml`)
  removing its mislabeled `"type": "module"` — its dist is CJS. This is the
  same patch orange-grove ships for the same reason.
- `@node-dlc` is pinned to exactly `1.2.1`, the version every published BAL
  package pins, so this suite's message objects and BAL's internals share one
  class identity.

To test a newer BAL release, bump the `@atomicfinance/*` versions in
`package.json` (and `bal-ddk-ts` if BAL's expected ddk engine moves) and
re-run; the "known divergences" tests below will tell you if a bump fixed
them.

## What is covered

| Suite | Network | What it proves |
|---|---|---|
| `__test__/messages.spec.ts` | none | Byte-identical serialization: ddk `createOffer` vs a field-by-field node-dlc `DlcOffer` (including the lygos six-outcome loan shape and `CONTRACT_FLAG_REFUND_TO_ACCEPTER`), funding-input encoding, accept/sign round-trips, the 65+97 adaptor-signature split, contract-id derivation (ddk == reference XOR == `DlcSign.contractId`), payout-table parity, oracle announcement/attestation validation in both stacks, and rejection of the legacy cfd attestation tagging. Also pins the `parseCets=false` partial-parse hazard lygos-app relies on. |
| `__test__/lifecycle.spec.ts` | regtest | Entering and closing contracts across implementations, both role directions: ddk offers / BAL accepts and BAL offers / ddk accepts; CET execution by either side on an oracle attestation; refund broadcast by either side; single-funded contracts (the lygos loan pattern: full offer collateral, zero accepter inputs). Every contract's fund/CET/refund transaction set is byte-compared between the two stacks before broadcasting on a real bitcoind. |
| `__test__/splice.spec.ts` | regtest | Splicing a live contract's 2-of-2 into a successor contract, both directions (ddk splice-offerer with BAL finalizing, and BAL splice-offerer with ddk finalizing via `finalizeSignSpliced`), with the splice `FundingInput` built independently by both stacks and byte-compared, then the successor settled on-chain. |
| `__test__/vectors.spec.ts` | none | Guards `vectors/compat-vectors.json` — the committed transcript that ddk-rn replays **on device** (see below). |

## ddk-rn coverage

ddk-rn's JSI bindings cannot run under Node, so the same corpus is replayed on
device:

- `scripts/generate-vectors.ts` produces a deterministic transcript (a
  dual-funded six-outcome loan contract plus a spliced successor), validates
  **every message against @node-dlc at generation time**, and writes it to
  `vectors/compat-vectors.json` and `ddk-rn/example/src/compatVectors.ts`,
  along with a verbatim copy of the replay code
  (`ddk-rn/example/src/compatReplay.ts` — `src/replay.ts` is dependency-free
  and parameterized by the ddk module precisely so the identical code runs in
  both places).
- The example app's **"Run the BAL compat replay"** button executes it through
  the real ddk-rn bindings and byte-compares every deterministic artifact;
  `ddk-rn/example/.maestro/compat-flow.yaml` asserts it in the E2E suite
  (`just e2e-ios` / `just e2e-android`).
- Adaptor signatures are randomized by secp256k1-zkp, so accept/sign messages
  are committed as replay *inputs*; the byte-compared artifacts are the
  deterministic derivations (funding PSBT, signed funding txs, contract ids,
  CET, refund, splice input). The replay also regenerates a fresh accept/sign
  each run to prove the build still produces valid messages.

## Running

```sh
just compat-install        # once; everything comes from npm
just ts-build              # the suite tests ddk-ts's current dist
just compat-test           # everything (spawns a throwaway regtest bitcoind)
just compat-test-messages  # offline suites only
just compat-vectors        # regenerate the vectors after a Rust core change
```

The regtest node: when `DDK_COMPAT_RPC_URL` is unset, the vitest global setup
spawns a throwaway `bitcoind -regtest` on port 18543 and deletes its datadir
afterwards. Set `DDK_COMPAT_RPC_URL` / `DDK_COMPAT_RPC_USER` /
`DDK_COMPAT_RPC_PASS` to use an existing node instead (the lygos-dev stack's
`http://localhost:18443`, `admin1`/`123` works); the suite creates and mines
into its own wallet (`ddk-compat`) and never touches other wallets.

## Known divergences the suite pins (tests fail when they get fixed)

1. **BAL's `acceptDlcOffer` writes a non-spec `temporaryContractId`**
   (`@atomicfinance/bitcoin-ddk-provider@4.3.6`,
   `dist/BitcoinDdkProvider.js:1968`: `sha256(offer.serialize())` instead of
   echoing the offer's). BAL never notices — it derives contract ids from the
   offer side — and the orange-grove backend's hand-built accepts copy the id
   correctly, so production is unaffected; but spec-conforming counterparties
   (ddk, rust-dlc) reject such accepts. The harness patches the field (nothing
   signs over it); `lifecycle.spec.ts › known BAL divergences` fails when BAL
   fixes it, which is the signal to drop the patch in `src/cross.ts`.
   Upstream: AtomicFinance/bitcoin-abstraction-layer#215; tracked here by #26.
2. **Splice funding-signature witness framing**: ddk puts `[signature]` in the
   sign message for a DLC input; BAL requires `[signature, publicKey]` and
   crashes on the one-element form (ddk itself accepts both — it reads only
   the first element). `shimSpliceSignForBal` in `src/cross.ts` appends the
   pubkey; `splice.spec.ts › known BAL divergences (splice)` pins it.
   Upstream: AtomicFinance/bitcoin-abstraction-layer#216; tracked here by #27.

## Findings worth knowing (asserted, not worked around)

- @node-dlc 1.2.1 and ddk agree on enum attestation tagging (BIP340 over
  `taggedHash('DLC/oracle/attestation/v0', raw utf8 outcome)`); the legacy cfd
  convention (`sha256(outcome)` first) is rejected by **both** stacks.
- `DlcAccept.deserialize(buf, parseCets=false)` — which lygos-app uses — is a
  **partial parse**: everything from `refundSignature` onward is garbage, and
  reserializing it does not reproduce the message. The fields lygos reads all
  sit before the signature block (asserted); a partially-parsed accept must
  never be forwarded as the message.
- Single-funded offers interop cleanly: node-dlc auto-detects them
  (`offerCollateral == totalCollateral`, no wire field), and ddk accepts a
  zero-input accepter.

## CI

The whole suite runs in the `check` job of `ci.yml` — the gate, so nothing else
builds unless ddk and BAL still agree. It sits there rather than in a job of its
own because the expensive prerequisite is already met: `pnpm generate:debug`
builds the debug cdylib and symlinks `node_modules/@bennyblader/ddk-ts-<triple>`,
which is what `resolveLibPath()` resolves through. `compat/` reaches that via
`link:../ddk-ts`, so CI tests the ddk-ts built from the commit under test, while
the BAL side installs from npm like any other dependency.

Bitcoin Core is installed from a pinned, checksummed bitcoincore.org tarball
(`BITCOIN_VERSION` / `BITCOIN_SHA256` in `ci.yml`) because Ubuntu packages no
bitcoind. Pin them together, and prefer the version you run locally — an
unpinned node would mean a green run proved compatibility against whatever Core
shipped last rather than against what these suites were written for.

## What is intentionally out of scope

- **Mutual close (`DlcClose`)**: a BAL-only extension message; ddk has no
  counterpart, lygos-app's only call site is dead code, and the backend closes
  via CET execution or refund.
- **Numeric (digit-decomposition) contracts**: lygos uses enum contracts
  exclusively. `contractInfoPayouts` numeric rows exist in ddk, but no numeric
  lifecycle is exercised here.
- **Numeric contracts in CI**: see above — nothing numeric is exercised
  anywhere, CI included.
