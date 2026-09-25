import { CET_LOCKTIME, FEE_RATE_PER_VB, REFUND_LOCKTIME } from './config.js'
import { CompatOracle } from './oracle.js'
import { buildEnumContractInfo, type EnumOutcomePayout } from './messages.js'

/**
 * The outcome set lygos loan contracts use (src/lib/dlc/outcomes in
 * lygos-app / @lygos/utils): four required outcomes plus two optional ones.
 */
export const LYGOS_LOAN_OUTCOMES = [
  'not-paid',
  'repaid',
  'liquidated-by-maturation-date',
  'liquidated-by-price-threshold',
  'updated',
  'liquidated-by-interest-failure',
] as const

export interface EnumScenario {
  oracle: CompatOracle
  eventId: string
  contractInfo: any
  contractInfoBytes: Buffer
  totalCollateral: bigint
  outcomes: EnumOutcomePayout[]
  feeRatePerVb: bigint
  cetLocktime: number
  refundLocktime: number
}

/** A simple two-outcome enum contract (the ddk-ffi fixture shape). */
export function upDownScenario(eventId = 'compat-up-down', totalCollateral = 1_000_000n): EnumScenario {
  const oracle = new CompatOracle(eventId)
  const outcomes: EnumOutcomePayout[] = [
    { outcome: 'up', localPayout: totalCollateral },
    { outcome: 'down', localPayout: 0n },
  ]
  const contractInfo = buildEnumContractInfo(oracle, eventId, outcomes, totalCollateral)
  return {
    oracle,
    eventId,
    contractInfo,
    contractInfoBytes: contractInfo.serialize(),
    totalCollateral,
    outcomes,
    feeRatePerVb: FEE_RATE_PER_VB,
    cetLocktime: CET_LOCKTIME,
    refundLocktime: REFUND_LOCKTIME,
  }
}

/** The lygos loan shape: six enum outcomes, uneven payouts. */
export function lygosLoanScenario(eventId = 'compat-loan', totalCollateral = 1_000_000n): EnumScenario {
  const oracle = new CompatOracle(eventId)
  const half = totalCollateral / 2n
  const outcomes: EnumOutcomePayout[] = [
    { outcome: 'not-paid', localPayout: 0n },
    { outcome: 'repaid', localPayout: totalCollateral },
    { outcome: 'liquidated-by-maturation-date', localPayout: 0n },
    { outcome: 'liquidated-by-price-threshold', localPayout: half },
    { outcome: 'updated', localPayout: totalCollateral },
    { outcome: 'liquidated-by-interest-failure', localPayout: 0n },
  ]
  const contractInfo = buildEnumContractInfo(oracle, eventId, outcomes, totalCollateral)
  return {
    oracle,
    eventId,
    contractInfo,
    contractInfoBytes: contractInfo.serialize(),
    totalCollateral,
    outcomes,
    feeRatePerVb: FEE_RATE_PER_VB,
    cetLocktime: CET_LOCKTIME,
    refundLocktime: REFUND_LOCKTIME,
  }
}
