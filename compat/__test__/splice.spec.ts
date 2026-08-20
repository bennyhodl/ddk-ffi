import * as bitcoin from 'bitcoinjs-lib'
import { beforeAll, describe, expect, test } from 'vitest'

import { balTypes, createBalParty, nodeDlc, type BalParty } from '../src/bal.js'
import {
  balExecuteCet,
  ddkSettleCet,
  enterBalOfferDdkAccept,
  enterDdkOfferBalAccept,
  shimSpliceSignForBal,
  spliceWitnessShimNeeded,
} from '../src/cross.js'
import { BAL_MNEMONIC, DDK_MNEMONIC, MAX_TIMEOUT_INTERVAL, MIN_TIMEOUT_INTERVAL } from '../src/config.js'
import { ddk, DdkParty } from '../src/ddk.js'
import { fundVout, makeDdkOffer, txidOf } from '../src/flow.js'
import { BitcoindRpc } from '../src/rpc.js'
import { upDownScenario } from '../src/scenario.js'
import { bytes, hex, tempId, tlvBody } from '../src/util.js'

const rpc = new BitcoindRpc()
let ddkParty: DdkParty
let balParty: BalParty

beforeAll(async () => {
  await rpc.prepareWallet()
  ddkParty = new DdkParty(DDK_MNEMONIC)
  balParty = createBalParty(BAL_MNEMONIC)
})

/** Value in sats of a raw tx's output at `vout`. */
function outputValue(raw: Uint8Array, vout: number): bigint {
  return BigInt(bitcoin.Transaction.fromBuffer(bytes(raw)).outs[vout]!.value)
}

async function assertSpends(txid: string, spentTxId: string): Promise<void> {
  const raw = await rpc.call<string>('getrawtransaction', [txid])
  const tx = bitcoin.Transaction.fromHex(raw)
  const spent = tx.ins.map((i) => Buffer.from(i.hash).reverse().toString('hex'))
  expect(spent).toContain(spentTxId)
}

describe('splice: ddk offers the successor contract, BAL accepts', () => {
  test('the base 2-of-2 is respliced into a new contract and settled', async () => {
    // Base contract: ddk offered, BAL accepted, funded and confirmed.
    const base = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, upDownScenario('splice-a-base'), {
      offerCollateralSats: 600_000n,
    })

    const baseFundVout = fundVout(base.ddkTransactions.fund.rawBytes, base.ddkTransactions.fundingWitnessScript)
    const baseFundValue = outputValue(base.ddkTransactions.fund.rawBytes, baseFundVout)
    const baseContractId = hex(ddk.computeContractId(base.offer, base.accept))

    // The splice funding input, built independently by both stacks — they
    // must agree byte-for-byte.
    const spliceSerialId = 7n
    const ddkSpliceInput = ddk.createDlcSpliceInput(base.offer, base.accept, ddk.Party.Offer, spliceSerialId, 220)

    const balInputInfo = balParty.client.dlc.createDlcInputInfo(
      base.fundTxId,
      baseFundVout,
      baseFundValue,
      base.balOffer.fundingPubkey.toString('hex'), // ddk was the base offerer
      base.balAccept.fundingPubkey.toString('hex'),
      baseContractId,
      220,
      spliceSerialId,
    )
    const balSpliceInput = await balParty.client.getMethod('createDlcFundingInput')(
      balInputInfo,
      bytes(base.ddkTransactions.fund.rawBytes).toString('hex'),
    )
    expect(balSpliceInput.serializeBody().toString('hex')).toBe(hex(ddkSpliceInput))

    // Successor contract: single-funded by the base DLC input alone.
    const scenario2 = upDownScenario('splice-a-next', 600_000n)
    const tempId2 = tempId(0xd1)
    const offer2 = makeDdkOffer({
      scenario: scenario2,
      offerer: ddkParty,
      temporaryContractId: tempId2,
      offerCollateralSats: scenario2.totalCollateral,
      fundingInputs: [ddkSpliceInput],
      payoutSpk: ddkParty.scriptPubkey(1),
      changeSpk: ddkParty.scriptPubkey(2),
      payoutSerialId: 1n,
      changeSerialId: 2n,
      fundOutputSerialId: 3n,
    })

    const balOffer2 = nodeDlc.DlcOffer.deserialize(bytes(offer2))
    balOffer2.validate()
    expect(balOffer2.fundingInputs[0].dlcInput.contractId.toString('hex')).toBe(baseContractId)

    const acceptResponse2 = await balParty.dlc.acceptDlcOffer(balOffer2)
    const balAccept2 = acceptResponse2.dlcAccept
    if (!balAccept2.temporaryContractId.equals(balOffer2.temporaryContractId)) {
      balAccept2.temporaryContractId = balOffer2.temporaryContractId // see src/cross.ts
    }
    const accept2: Uint8Array = balAccept2.serialize()
    ddk.validateAccept(offer2, accept2)

    // ddk signs: no wallet inputs, so the PSBT goes in unsigned; the DLC
    // input signature comes from the splice key re-derivation.
    const psbt2 = ddk.createFundingPsbt(offer2, accept2)
    const signResult2 = ddk.signAcceptSpliced(offer2, accept2, ddkParty.keys, tempId2, psbt2, [
      { inputSerialId: spliceSerialId, priorTemporaryContractId: base.ddkTempId },
    ])
    // BAL needs [signature, pubkey] witness elements for DLC inputs; ddk
    // emits [signature]. See shimSpliceSignForBal for the full story.
    const sign2 = shimSpliceSignForBal(signResult2.sign, balOffer2)

    // BAL adds its half of the base 2-of-2 and broadcasts.
    const balSign2 = nodeDlc.DlcSign.deserialize(bytes(sign2))
    const fundTx2 = await balParty.dlc.finalizeDlcSign(balOffer2, balAccept2, balSign2, acceptResponse2.dlcTransactions)
    const fundTxId2 = await rpc.broadcastAndConfirm(fundTx2.serialize().toString('hex'))
    await assertSpends(fundTxId2, base.fundTxId)

    // Settle the successor: BAL executes on an attestation.
    const contract2 = {
      scenario: scenario2,
      offer: offer2,
      accept: accept2,
      sign: sign2,
      balOffer: balOffer2,
      balAccept: balAccept2,
      balSign: balSign2,
      balTransactions: acceptResponse2.dlcTransactions,
      ddkTransactions: ddk.dlcTransactionsFromMessages(offer2, accept2),
      fundTxId: fundTxId2,
      ddkParty,
      ddkTempId: tempId2,
      ddkIsOfferer: true,
    }
    const attestation2 = scenario2.oracle.attestEnum(scenario2.eventId, 'up')
    const cetTxId = await balExecuteCet(rpc, balParty, contract2, attestation2)
    await assertSpends(cetTxId, fundTxId2)
  })
})

describe('splice: BAL offers the successor contract, ddk accepts', () => {
  test('the base 2-of-2 is respliced into a new contract and settled', async () => {
    // Base contract: BAL offered, ddk accepted, funded and confirmed.
    const base = await enterBalOfferDdkAccept(rpc, balParty, ddkParty, upDownScenario('splice-b-base'), {
      offerCollateralSats: 600_000n,
    })

    const baseFundVout = fundVout(base.ddkTransactions.fund.rawBytes, base.ddkTransactions.fundingWitnessScript)
    const baseFundValue = outputValue(base.ddkTransactions.fund.rawBytes, baseFundVout)
    const baseContractId = hex(ddk.computeContractId(base.offer, base.accept))

    const spliceSerialId = 9n
    const balInputInfo = balParty.client.dlc.createDlcInputInfo(
      base.fundTxId,
      baseFundVout,
      baseFundValue,
      base.balOffer.fundingPubkey.toString('hex'), // BAL was the base offerer
      base.balAccept.fundingPubkey.toString('hex'),
      baseContractId,
      220,
      spliceSerialId,
    )
    const balSpliceInput = await balParty.client.getMethod('createDlcFundingInput')(
      balInputInfo,
      bytes(base.ddkTransactions.fund.rawBytes).toString('hex'),
    )
    // ddk rebuilds the same wire input from the messages alone. DlcInput's
    // local/remote fields are seat-relative and this input will appear in
    // BAL's offer, so both constructions use the base OFFERER's seat.
    const ddkSpliceInput = ddk.createDlcSpliceInput(base.offer, base.accept, ddk.Party.Offer, spliceSerialId, 220)
    expect(balSpliceInput.serializeBody().toString('hex')).toBe(hex(ddkSpliceInput))

    // The client facade converts the FundingInput to the Input model that the
    // collateral math and createDlcOffer consume (the lygos-app pattern).
    const balSpliceInputModel = await balParty.dlc.createDlcFundingInput(
      balInputInfo,
      bytes(base.ddkTransactions.fund.rawBytes).toString('hex'),
    )

    // BAL builds the successor offer around the DLC input, exact-collateral.
    const maxCollateral: bigint = await balParty.dlc.calculateMaxCollateral(
      [balSpliceInputModel],
      upDownScenario('splice-b-base').feeRatePerVb,
      1,
    )
    const total2 = maxCollateral - 1_000n
    const scenario2 = upDownScenario('splice-b-next', total2)
    const balOffer2 = await balParty.dlc.createDlcOffer(
      scenario2.contractInfo,
      total2,
      scenario2.feeRatePerVb,
      scenario2.cetLocktime,
      scenario2.refundLocktime,
      [balSpliceInputModel],
      balTypes.InputSupplementationMode.None,
    )
    const offer2: Uint8Array = balOffer2.serialize()
    ddk.validateOffer(offer2, MIN_TIMEOUT_INTERVAL, MAX_TIMEOUT_INTERVAL)

    // ddk accepts with no inputs (single-funded successor).
    const tempId2 = tempId(0xd2)
    const acceptResult2 = ddk.acceptOffer(
      offer2,
      {
        party: {
          fundingPubkey: ddkParty.keys.fundingPubkey(tempId2),
          fundingInputs: [],
          payoutSpk: ddkParty.scriptPubkey(1),
          payoutSerialId: 4n,
          changeSpk: ddkParty.scriptPubkey(2),
          changeSerialId: 5n,
        },
        minTimeoutInterval: MIN_TIMEOUT_INTERVAL,
        maxTimeoutInterval: MAX_TIMEOUT_INTERVAL,
      },
      ddkParty.keys,
      tempId2,
    )
    const accept2 = acceptResult2.accept

    const balAccept2 = nodeDlc.DlcAccept.deserialize(bytes(accept2))
    balAccept2.validate()
    const signResponse2 = await balParty.dlc.signDlcAccept(balOffer2, balAccept2)
    const sign2: Uint8Array = signResponse2.dlcSign.serialize()
    ddk.validateSign(offer2, accept2, sign2)

    // ddk finalizes: adds its half of the base 2-of-2 via the splice key and
    // broadcasts the successor funding transaction.
    const fundingTx2 = ddk.finalizeSignSpliced(offer2, accept2, sign2, acceptResult2.fundingPsbt, ddkParty.keys, [
      { inputSerialId: spliceSerialId, priorTemporaryContractId: base.ddkTempId },
    ])
    const fundTxId2 = await rpc.broadcastAndConfirm(hex(fundingTx2))
    await assertSpends(fundTxId2, base.fundTxId)
    expect(fundTxId2).toBe(txidOf(acceptResult2.transactions.fund.rawBytes))

    // Settle the successor: ddk signs the CET on an attestation.
    const contract2 = {
      scenario: scenario2,
      offer: offer2,
      accept: accept2,
      sign: sign2,
      balOffer: balOffer2,
      balAccept: balAccept2,
      balSign: signResponse2.dlcSign,
      balTransactions: signResponse2.dlcTransactions,
      ddkTransactions: ddk.dlcTransactionsFromMessages(offer2, accept2),
      fundTxId: fundTxId2,
      ddkParty,
      ddkTempId: tempId2,
      ddkIsOfferer: false,
    }
    const attestation2 = scenario2.oracle.attestEnum(scenario2.eventId, 'down')
    const cetTxId = await ddkSettleCet(rpc, contract2, tlvBody(attestation2.serialize()))
    await assertSpends(cetTxId, fundTxId2)
  })
})

describe('known BAL divergences (splice)', () => {
  test('BAL still needs [signature, pubkey] witness elements for DLC inputs', () => {
    // ddk emits a single-element witness for a splice input's funding
    // signature; BAL's finalizeDlcSign requires a second (pubkey) element.
    // The harness appends it (shimSpliceSignForBal). When BAL learns to
    // derive the pubkey from the DlcInput, this fails on purpose: remove the
    // shim with it.
    // Upstream: AtomicFinance/bitcoin-abstraction-layer#216. Tracked here by #27.
    expect(spliceWitnessShimNeeded()).toBe(true)
  })
})
