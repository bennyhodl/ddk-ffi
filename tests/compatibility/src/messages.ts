import { nodeDlc, nodeDlcBitcoin } from './bal.js'
import type { CompatOracle } from './oracle.js'

export interface EnumOutcomePayout {
  outcome: string
  /** The OFFERING party's payout for this outcome, in sats. */
  localPayout: bigint
}

/**
 * A node-dlc SingleContractInfo for an enum event: the shape lygos loans use
 * (raw string outcomes, single oracle). Its serialize() bytes are what the ddk
 * side consumes as CreateOfferParams.contractInfo.
 */
export function buildEnumContractInfo(
  oracle: CompatOracle,
  eventId: string,
  outcomes: EnumOutcomePayout[],
  totalCollateral: bigint,
  maturityEpoch?: number,
): any {
  const oracleInfo = new nodeDlc.SingleOracleInfo()
  oracleInfo.announcement = oracle.buildEnumAnnouncement(
    eventId,
    outcomes.map((o) => o.outcome),
    maturityEpoch,
  )

  const descriptor = new nodeDlc.EnumeratedDescriptor()
  descriptor.outcomes = outcomes.map((o) => ({ outcome: o.outcome, localPayout: o.localPayout }))

  const contractInfo = new nodeDlc.SingleContractInfo()
  contractInfo.totalCollateral = totalCollateral
  contractInfo.contractDescriptor = descriptor
  contractInfo.oracleInfo = oracleInfo
  return contractInfo
}

export interface ReferenceFundingInput {
  prevTxHex: string
  prevTxVout: number
  inputSerialId: bigint
  maxWitnessLen?: number
  sequence?: number
}

/** A node-dlc FundingInput built field-by-field (the @lygos/utils pattern). */
export function buildNodeDlcFundingInput(input: ReferenceFundingInput): any {
  const fi = new nodeDlc.FundingInput()
  fi.inputSerialId = input.inputSerialId
  fi.prevTx = nodeDlcBitcoin.Tx.fromHex(input.prevTxHex)
  fi.prevTxVout = input.prevTxVout
  fi.sequence = nodeDlcBitcoin.Sequence
    ? new nodeDlcBitcoin.Sequence(input.sequence ?? 0xffffffff)
    : input.sequence ?? 0xffffffff
  fi.maxWitnessLen = input.maxWitnessLen ?? 108
  fi.redeemScript = Buffer.alloc(0)
  return fi
}

export interface ReferenceOfferParams {
  chainHash: Buffer
  temporaryContractId: Buffer
  contractInfo: any
  fundingPubkey: Buffer
  payoutSpk: Buffer
  payoutSerialId: bigint
  offerCollateral: bigint
  fundingInputs: any[]
  changeSpk: Buffer
  changeSerialId: bigint
  fundOutputSerialId: bigint
  feeRatePerVb: bigint
  cetLocktime: number
  refundLocktime: number
  contractFlags?: number
}

/**
 * A node-dlc DlcOffer built field-by-field, mirroring what
 * @lygos/utils buildLoanDlcOffer does in production. This is the reference
 * the ddk-built offer must match byte-for-byte.
 */
export function buildReferenceOffer(params: ReferenceOfferParams): any {
  const offer = new nodeDlc.DlcOffer()
  offer.contractFlags = Buffer.from([params.contractFlags ?? 0])
  offer.chainHash = params.chainHash
  offer.temporaryContractId = params.temporaryContractId
  offer.contractInfo = params.contractInfo
  offer.fundingPubkey = params.fundingPubkey
  offer.payoutSpk = params.payoutSpk
  offer.payoutSerialId = params.payoutSerialId
  offer.offerCollateral = params.offerCollateral
  offer.fundingInputs = params.fundingInputs
  offer.changeSpk = params.changeSpk
  offer.changeSerialId = params.changeSerialId
  offer.fundOutputSerialId = params.fundOutputSerialId
  offer.feeRatePerVb = params.feeRatePerVb
  offer.cetLocktime = params.cetLocktime
  offer.refundLocktime = params.refundLocktime
  return offer
}
