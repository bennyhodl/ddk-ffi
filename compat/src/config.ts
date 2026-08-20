import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The ddk-ffi repository root (compat/src -> compat -> repo root). */
export const REPO_ROOT = resolve(here, '..', '..')

/**
 * Regtest node connection. When DDK_COMPAT_RPC_URL is not set, the suite's
 * global setup spawns a throwaway bitcoind on this port and tears it down
 * afterwards; set the env vars to run against an existing node instead
 * (e.g. the lygos-dev stack: http://localhost:18443, admin1/123).
 */
export const RPC_URL = process.env.DDK_COMPAT_RPC_URL ?? 'http://127.0.0.1:18543'
export const RPC_USER = process.env.DDK_COMPAT_RPC_USER ?? 'admin1'
export const RPC_PASS = process.env.DDK_COMPAT_RPC_PASS ?? '123'
export const RPC_WALLET = process.env.DDK_COMPAT_RPC_WALLET ?? 'ddk-compat'
export const SPAWNED_NODE = process.env.DDK_COMPAT_RPC_URL === undefined

// Standard parameters used across the suites. The locktimes are in the past
// (the same values BAL's own integration tests use) so CETs and refunds are
// immediately broadcastable on regtest.
export const FEE_RATE_PER_VB = 10n
export const CET_LOCKTIME = 1_617_170_572
export const REFUND_LOCKTIME = 1_617_170_573
// The announcement's maturity epoch is far in the past too, so the ddk side
// accepts any refund locktime within the oracle-timeout window. The window is
// checked as `maturity + interval` in u32 arithmetic, so it must not overflow.
export const EVENT_MATURITY_EPOCH = 1_617_170_572
export const MIN_TIMEOUT_INTERVAL = 0
export const MAX_TIMEOUT_INTERVAL = 365 * 24 * 3600

// Fixed mnemonics: the parties must be deterministic so the message-parity
// assertions and the committed ddk-rn vectors are reproducible.
export const DDK_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const BAL_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
