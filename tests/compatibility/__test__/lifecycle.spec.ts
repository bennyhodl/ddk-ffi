import * as bitcoin from 'bitcoinjs-lib'
import { beforeAll, describe, expect, test } from 'vitest'

import { createBalParty, type BalParty } from '../src/bal.js'
import {
  balAcceptTempIdBugPresent,
  balExecuteCet,
  balRefund,
  ddkRefund,
  ddkSettleCet,
  enterBalOfferDdkAccept,
  enterDdkOfferBalAccept,
} from '../src/cross.js'
import { BAL_MNEMONIC, DDK_MNEMONIC } from '../src/config.js'
import { DdkParty } from '../src/ddk.js'
import { BitcoindRpc } from '../src/rpc.js'
import { lygosLoanScenario, upDownScenario } from '../src/scenario.js'
import { tlvBody } from '../src/util.js'

const rpc = new BitcoindRpc()
let ddkParty: DdkParty
let balParty: BalParty

beforeAll(async () => {
  await rpc.prepareWallet()
  ddkParty = new DdkParty(DDK_MNEMONIC)
  balParty = createBalParty(BAL_MNEMONIC)
})

/** Asserts the settlement tx spends the fund tx and pays out the full collateral. */
async function assertSettlement(txid: string, contractFundTxId: string, totalCollateral: bigint): Promise<void> {
  const raw = await rpc.call<string>('getrawtransaction', [txid])
  const tx = bitcoin.Transaction.fromHex(raw)
  expect(tx.ins.length).toBe(1)
  const spentTxId = Buffer.from(tx.ins[0]!.hash).reverse().toString('hex')
  expect(spentTxId).toBe(contractFundTxId)
  const totalOut = tx.outs.reduce((sum, o) => sum + BigInt(o.value), 0n)
  expect(totalOut).toBe(totalCollateral)
}

describe('enter + close: ddk offers, BAL accepts', () => {
  test('BAL executes the CET after the oracle attests', async () => {
    const scenario = upDownScenario('lifecycle-a')
    const contract = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'up')
    const cetTxId = await balExecuteCet(rpc, balParty, contract, attestation)
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })

  test('ddk settles the CET after the oracle attests', async () => {
    const scenario = upDownScenario('lifecycle-b')
    const contract = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'down')
    const cetTxId = await ddkSettleCet(rpc, contract, tlvBody(attestation.serialize()))
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })

  test('BAL broadcasts the refund after the locktime', async () => {
    const scenario = upDownScenario('lifecycle-c')
    const contract = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const refundTxId = await balRefund(rpc, balParty, contract)
    await assertSettlement(refundTxId, contract.fundTxId, scenario.totalCollateral)
  })
})

describe('enter + close: BAL offers, ddk accepts', () => {
  test('ddk settles the CET after the oracle attests', async () => {
    const scenario = upDownScenario('lifecycle-d')
    const contract = await enterBalOfferDdkAccept(rpc, balParty, ddkParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'up')
    const cetTxId = await ddkSettleCet(rpc, contract, tlvBody(attestation.serialize()))
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })

  test('BAL executes the CET after the oracle attests', async () => {
    const scenario = upDownScenario('lifecycle-e')
    const contract = await enterBalOfferDdkAccept(rpc, balParty, ddkParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'down')
    const cetTxId = await balExecuteCet(rpc, balParty, contract, attestation)
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })

  test('ddk broadcasts the refund after the locktime', async () => {
    const scenario = upDownScenario('lifecycle-f')
    const contract = await enterBalOfferDdkAccept(rpc, balParty, ddkParty, scenario, {
      offerCollateralSats: 600_000n,
    })
    const refundTxId = await ddkRefund(rpc, contract)
    await assertSettlement(refundTxId, contract.fundTxId, scenario.totalCollateral)
  })
})

describe('single-funded contracts (the lygos loan pattern)', () => {
  test('ddk offers the full collateral, BAL accepts with no inputs, BAL executes', async () => {
    const scenario = lygosLoanScenario('lifecycle-sf-a')
    const contract = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, scenario, {
      offerCollateralSats: scenario.totalCollateral,
      singleFunded: true,
    })
    expect(contract.balOffer.isSingleFunded()).toBe(true)
    expect(contract.balAccept.fundingInputs.length).toBe(0)

    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'repaid')
    const cetTxId = await balExecuteCet(rpc, balParty, contract, attestation)
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })

  test('ddk offers the full collateral and settles a liquidation outcome itself', async () => {
    const scenario = lygosLoanScenario('lifecycle-sf-b')
    const contract = await enterDdkOfferBalAccept(rpc, ddkParty, balParty, scenario, {
      offerCollateralSats: scenario.totalCollateral,
      singleFunded: true,
    })
    const attestation = scenario.oracle.attestEnum(scenario.eventId, 'liquidated-by-price-threshold')
    const cetTxId = await ddkSettleCet(rpc, contract, tlvBody(attestation.serialize()))
    await assertSettlement(cetTxId, contract.fundTxId, scenario.totalCollateral)
  })
})

describe('known BAL divergences', () => {
  test('BAL acceptDlcOffer still writes a non-spec temporaryContractId', () => {
    // BitcoinDdkProvider.acceptDlcOffer sets sha256(offer) instead of echoing
    // the offer's temporary contract id; the cross harness patches it (see
    // src/cross.ts). When BAL fixes this, this test fails on purpose: delete
    // it together with the patch in enterDdkOfferBalAccept.
    // Upstream: AtomicFinance/bitcoin-abstraction-layer#215. Tracked here by #26.
    expect(balAcceptTempIdBugPresent()).toBe(true)
  })
})
