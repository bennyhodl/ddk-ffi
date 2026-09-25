import * as bitcoin from 'bitcoinjs-lib'

import { ddk, DdkParty, type DdkFundedInput } from './ddk.js'
import type { EnumScenario } from './scenario.js'
import { bytes } from './util.js'

/**
 * A synthetic (never-broadcast) transaction paying `valueSats` to the party's
 * wallet at `index` — a deterministic funding UTXO for offline tests and
 * vectors, mirroring the ddk-ffi fixture pattern.
 */
export function syntheticFundedInput(
  party: DdkParty,
  index: number,
  valueSats: number,
  inputSerialId: bigint,
): DdkFundedInput {
  const tx = new bitcoin.Transaction()
  tx.version = 2
  tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff)
  tx.addOutput(party.scriptPubkey(index), valueSats)
  const prevTxHex = tx.toHex()
  return {
    fundingInput: ddk.fundingInput(Buffer.from(prevTxHex, 'hex'), 0, inputSerialId, 0xffffffff, 108, Buffer.alloc(0)),
    inputSerialId,
    derivationIndex: index,
    prevTxHex,
    vout: 0,
  }
}

export interface DdkOfferInputs {
  scenario: EnumScenario
  offerer: DdkParty
  temporaryContractId: Buffer
  offerCollateralSats: bigint
  fundingInputs: Uint8Array[]
  payoutSpk: Buffer
  changeSpk: Buffer
  payoutSerialId: bigint
  changeSerialId: bigint
  fundOutputSerialId: bigint
  contractFlags?: number
}

/** Builds a ddk offer from a scenario with fully explicit (deterministic) ids. */
export function makeDdkOffer(cfg: DdkOfferInputs): Uint8Array {
  return ddk.createOffer({
    chainHash: ddk.chainHashFromNetwork('regtest'),
    temporaryContractId: cfg.temporaryContractId,
    contractInfo: cfg.scenario.contractInfoBytes,
    offerCollateralSats: cfg.offerCollateralSats,
    party: {
      fundingPubkey: bytes(cfg.offerer.keys.fundingPubkey(cfg.temporaryContractId)),
      fundingInputs: cfg.fundingInputs,
      payoutSpk: cfg.payoutSpk,
      payoutSerialId: cfg.payoutSerialId,
      changeSpk: cfg.changeSpk,
      changeSerialId: cfg.changeSerialId,
    },
    fundOutputSerialId: cfg.fundOutputSerialId,
    feeRatePerVb: cfg.scenario.feeRatePerVb,
    cetLocktime: cfg.scenario.cetLocktime,
    refundLocktime: cfg.scenario.refundLocktime,
    contractFlags: cfg.contractFlags ?? 0,
  })
}

/** Txid (display order) of a raw transaction. */
export function txidOf(raw: Uint8Array): string {
  return bitcoin.Transaction.fromBuffer(bytes(raw)).getId()
}

/** Index of the DLC funding output (the P2WSH of the funding witness script) in a fund tx. */
export function fundVout(fundRaw: Uint8Array, fundingWitnessScript: Uint8Array): number {
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: bytes(fundingWitnessScript) } }).output!
  const tx = bitcoin.Transaction.fromBuffer(bytes(fundRaw))
  const vout = tx.outs.findIndex((o) => o.script.equals(p2wsh))
  if (vout < 0) throw new Error('fund output not found')
  return vout
}
