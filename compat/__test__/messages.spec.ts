import { describe, expect, test } from 'vitest'

import { balTypes, nodeDlc } from '../src/bal.js'
import { BAL_MNEMONIC, DDK_MNEMONIC, MAX_TIMEOUT_INTERVAL, MIN_TIMEOUT_INTERVAL } from '../src/config.js'
import { ddk, DdkParty } from '../src/ddk.js'
import { fundVout, makeDdkOffer, syntheticFundedInput, txidOf } from '../src/flow.js'
import { buildNodeDlcFundingInput, buildReferenceOffer } from '../src/messages.js'
import { lygosLoanScenario, upDownScenario } from '../src/scenario.js'
import { buf, bytes, hex, referenceContractId, tempId, tlvBody } from '../src/util.js'

const offerer = new DdkParty(DDK_MNEMONIC)
const acceptor = new DdkParty(BAL_MNEMONIC)

const OFFER_TEMP_ID = tempId(0x11)
const ACCEPT_TEMP_ID = tempId(0x22)

/** Deterministic offline dual-funded flow, entirely through the ddk API. */
function runOfflineFlow(scenario = upDownScenario()) {
  const offererInput = syntheticFundedInput(offerer, 0, 2_000_000, 100n)
  const acceptorInput = syntheticFundedInput(acceptor, 0, 2_000_000, 200n)

  const offer = makeDdkOffer({
    scenario,
    offerer,
    temporaryContractId: OFFER_TEMP_ID,
    offerCollateralSats: 600_000n,
    fundingInputs: [offererInput.fundingInput],
    payoutSpk: offerer.scriptPubkey(1),
    changeSpk: offerer.scriptPubkey(2),
    payoutSerialId: 1n,
    changeSerialId: 2n,
    fundOutputSerialId: 3n,
  })

  const acceptResult = ddk.acceptOffer(
    offer,
    {
      party: {
        fundingPubkey: acceptor.keys.fundingPubkey(ACCEPT_TEMP_ID),
        fundingInputs: [acceptorInput.fundingInput],
        payoutSpk: acceptor.scriptPubkey(1),
        payoutSerialId: 4n,
        changeSpk: acceptor.scriptPubkey(2),
        changeSerialId: 5n,
      },
      minTimeoutInterval: MIN_TIMEOUT_INTERVAL,
      maxTimeoutInterval: MAX_TIMEOUT_INTERVAL,
    },
    acceptor.keys,
    ACCEPT_TEMP_ID,
  )
  const accept = acceptResult.accept

  const offererSignedPsbt = offerer.signFundingPsbt(offer, accept, acceptResult.fundingPsbt, [offererInput])
  const signResult = ddk.signAccept(offer, accept, offerer.keys, OFFER_TEMP_ID, offererSignedPsbt)
  const acceptorSignedPsbt = acceptor.signFundingPsbt(offer, accept, acceptResult.fundingPsbt, [acceptorInput])
  const fundingTx = ddk.finalizeSign(offer, accept, signResult.sign, acceptorSignedPsbt)

  return { scenario, offer, accept, acceptResult, sign: signResult.sign, signResult, fundingTx }
}

const flow = runOfflineFlow()

describe('offer serialization parity', () => {
  test('ddk fundingInput encodes exactly like a node-dlc FundingInput body', () => {
    const input = syntheticFundedInput(offerer, 0, 2_000_000, 100n)
    const reference = buildNodeDlcFundingInput({
      prevTxHex: input.prevTxHex,
      prevTxVout: input.vout,
      inputSerialId: input.inputSerialId,
    })
    expect(hex(input.fundingInput)).toBe(reference.serializeBody().toString('hex'))
  })

  test('ddk createOffer is byte-identical to a field-by-field node-dlc DlcOffer', () => {
    const scenario = upDownScenario()
    const input = syntheticFundedInput(offerer, 0, 2_000_000, 100n)
    const offer = makeDdkOffer({
      scenario,
      offerer,
      temporaryContractId: OFFER_TEMP_ID,
      offerCollateralSats: 600_000n,
      fundingInputs: [input.fundingInput],
      payoutSpk: offerer.scriptPubkey(1),
      changeSpk: offerer.scriptPubkey(2),
      payoutSerialId: 1n,
      changeSerialId: 2n,
      fundOutputSerialId: 3n,
    })

    const reference = buildReferenceOffer({
      chainHash: bytes(ddk.chainHashFromNetwork('regtest')),
      temporaryContractId: OFFER_TEMP_ID,
      contractInfo: scenario.contractInfo,
      fundingPubkey: bytes(offerer.keys.fundingPubkey(OFFER_TEMP_ID)),
      payoutSpk: offerer.scriptPubkey(1),
      payoutSerialId: 1n,
      offerCollateral: 600_000n,
      fundingInputs: [
        buildNodeDlcFundingInput({ prevTxHex: input.prevTxHex, prevTxVout: input.vout, inputSerialId: 100n }),
      ],
      changeSpk: offerer.scriptPubkey(2),
      changeSerialId: 2n,
      fundOutputSerialId: 3n,
      feeRatePerVb: scenario.feeRatePerVb,
      cetLocktime: scenario.cetLocktime,
      refundLocktime: scenario.refundLocktime,
    })

    expect(hex(offer)).toBe(reference.serialize().toString('hex'))
  })

  test('lygos loan shape: six outcomes + REFUND_TO_ACCEPTER flag, byte-identical', () => {
    const scenario = lygosLoanScenario()
    const flag = balTypes.CONTRACT_FLAG_REFUND_TO_ACCEPTER as number
    const input = syntheticFundedInput(offerer, 0, 2_000_000, 100n)
    const common = {
      payoutSpk: offerer.scriptPubkey(1),
      changeSpk: offerer.scriptPubkey(2),
    }
    const offer = makeDdkOffer({
      scenario,
      offerer,
      temporaryContractId: OFFER_TEMP_ID,
      offerCollateralSats: scenario.totalCollateral,
      fundingInputs: [input.fundingInput],
      ...common,
      payoutSerialId: 1n,
      changeSerialId: 2n,
      fundOutputSerialId: 3n,
      contractFlags: flag,
    })
    const reference = buildReferenceOffer({
      chainHash: bytes(ddk.chainHashFromNetwork('regtest')),
      temporaryContractId: OFFER_TEMP_ID,
      contractInfo: scenario.contractInfo,
      fundingPubkey: bytes(offerer.keys.fundingPubkey(OFFER_TEMP_ID)),
      ...common,
      payoutSerialId: 1n,
      offerCollateral: scenario.totalCollateral,
      fundingInputs: [
        buildNodeDlcFundingInput({ prevTxHex: input.prevTxHex, prevTxVout: input.vout, inputSerialId: 100n }),
      ],
      changeSerialId: 2n,
      fundOutputSerialId: 3n,
      feeRatePerVb: scenario.feeRatePerVb,
      cetLocktime: scenario.cetLocktime,
      refundLocktime: scenario.refundLocktime,
      contractFlags: flag,
    })
    expect(hex(offer)).toBe(reference.serialize().toString('hex'))

    // A full-collateral offer is what lygos-app sends; node-dlc must see it as
    // single-funded (auto-detected, no wire field).
    const parsed = nodeDlc.DlcOffer.deserialize(bytes(offer))
    expect(parsed.isSingleFunded()).toBe(true)
    expect(parsed.contractFlags[0]).toBe(flag)

    // And ddk itself must keep accepting flagged offers — contract_flags is a
    // passthrough byte in ddk-messages, but this is load-bearing for every
    // lygos loan offer, so pin it.
    expect(() => ddk.validateOffer(offer, MIN_TIMEOUT_INTERVAL, MAX_TIMEOUT_INTERVAL)).not.toThrow()
  })

  test('node-dlc round-trips the ddk offer byte-stably and validates it', () => {
    const parsed = nodeDlc.DlcOffer.deserialize(bytes(flow.offer))
    expect(() => parsed.validate()).not.toThrow()
    expect(parsed.serialize().toString('hex')).toBe(hex(flow.offer))
  })

  test('ddk validates a node-dlc-built offer', () => {
    const parsed = nodeDlc.DlcOffer.deserialize(bytes(flow.offer))
    // Round-trip through node-dlc, then hand back to ddk.
    expect(() => ddk.validateOffer(parsed.serialize(), MIN_TIMEOUT_INTERVAL, MAX_TIMEOUT_INTERVAL)).not.toThrow()
  })
})

describe('accept / sign serialization parity', () => {
  test('node-dlc round-trips the ddk accept byte-stably and validates it', () => {
    const parsed = nodeDlc.DlcAccept.deserialize(bytes(flow.accept))
    expect(() => parsed.validate()).not.toThrow()
    expect(parsed.serialize().toString('hex')).toBe(hex(flow.accept))
  })

  test('accept adaptor signatures split into 65-byte encryptedSig + 97-byte dleqProof', () => {
    const parsed = nodeDlc.DlcAccept.deserialize(bytes(flow.accept))
    const sigs = parsed.cetAdaptorSignatures.sigs
    expect(sigs.length).toBe(flow.acceptResult.transactions.cets.length)
    for (const sig of sigs) {
      expect(sig.encryptedSig.length).toBe(65)
      expect(sig.dleqProof.length).toBe(97)
    }
    expect(parsed.refundSignature.length).toBe(64)
  })

  test('lygos parseCets=false parsing is partial: leading fields OK, NEVER reserialize', () => {
    // lygos-app deserializes accepts with DlcAccept.deserialize(buf, false).
    // That is a PARTIAL parse: node-dlc substitutes empty adaptor signatures
    // and then misreads the signature block, so everything from
    // refundSignature onward is garbage. The fields lygos actually reads all
    // sit before the signature block and must match the full parse — and a
    // reserialized partial parse must never be treated as the message.
    const partial = nodeDlc.DlcAccept.deserialize(bytes(flow.accept), false)
    const full = nodeDlc.DlcAccept.deserialize(bytes(flow.accept))

    expect(partial.temporaryContractId.equals(full.temporaryContractId)).toBe(true)
    expect(partial.acceptCollateral).toBe(full.acceptCollateral)
    expect(partial.fundingPubkey.equals(full.fundingPubkey)).toBe(true)
    expect(partial.payoutSpk.equals(full.payoutSpk)).toBe(true)
    expect(partial.payoutSerialId).toBe(full.payoutSerialId)
    expect(partial.changeSpk.equals(full.changeSpk)).toBe(true)
    expect(partial.changeSerialId).toBe(full.changeSerialId)
    expect(partial.fundingInputs.length).toBe(full.fundingInputs.length)

    // The hazard, pinned: the partial parse does NOT round-trip.
    expect(partial.cetAdaptorSignatures.sigs.length).toBe(0)
    expect(partial.serialize().toString('hex')).not.toBe(hex(flow.accept))
  })

  test('node-dlc round-trips the ddk sign byte-stably', () => {
    const parsed = nodeDlc.DlcSign.deserialize(bytes(flow.sign))
    expect(parsed.serialize().toString('hex')).toBe(hex(flow.sign))
    expect(parsed.cetAdaptorSignatures.sigs.length).toBe(flow.acceptResult.transactions.cets.length)
    expect(parsed.fundingSignatures.witnessElements.length).toBe(1) // one offerer input
  })

  test('ddk accepts node-dlc round-tripped accept and sign bytes', () => {
    const accept = nodeDlc.DlcAccept.deserialize(bytes(flow.accept)).serialize()
    const sign = nodeDlc.DlcSign.deserialize(bytes(flow.sign)).serialize()
    expect(() => ddk.validateAccept(flow.offer, accept)).not.toThrow()
    expect(() => ddk.validateSign(flow.offer, accept, sign)).not.toThrow()
  })
})

describe('contract id derivation', () => {
  test('ddk, the reference XOR, and the DlcSign contract id all agree', () => {
    const ddkId = hex(ddk.computeContractId(flow.offer, flow.accept))

    const transactions = flow.acceptResult.transactions
    const fundTxId = txidOf(transactions.fund.rawBytes)
    const vout = fundVout(transactions.fund.rawBytes, transactions.fundingWitnessScript)
    const reference = referenceContractId(buf(fundTxId), vout, OFFER_TEMP_ID).toString('hex')

    const signContractId = nodeDlc.DlcSign.deserialize(bytes(flow.sign)).contractId.toString('hex')

    expect(ddkId).toBe(reference)
    expect(signContractId).toBe(ddkId)
  })
})

describe('payout table parity', () => {
  test('ddk contractInfoPayouts matches the node-dlc descriptor', () => {
    const scenario = lygosLoanScenario()
    const payouts = ddk.contractInfoPayouts(scenario.contractInfoBytes)
    expect(payouts.rows.length).toBe(scenario.outcomes.length)
    payouts.rows.forEach((row, i) => {
      expect(row.outcome).toBe(scenario.outcomes[i]!.outcome)
      expect(row.offerPayoutSats).toBe(scenario.outcomes[i]!.localPayout)
      expect(row.acceptPayoutSats).toBe(scenario.totalCollateral - scenario.outcomes[i]!.localPayout)
    })
  })
})

describe('oracle message compatibility', () => {
  const scenario = flow.scenario
  const attestation = scenario.oracle.attestEnum(scenario.eventId, 'up')

  test('the compat oracle satisfies node-dlc validation', () => {
    const announcement = (scenario.contractInfo.oracleInfo as any).announcement
    expect(() => announcement.validate()).not.toThrow()
    expect(() => attestation.validate(announcement)).not.toThrow()
  })

  test('attestation body bytes round-trip through node-dlc', () => {
    const body = tlvBody(attestation.serialize())
    const reparsed = nodeDlc.OracleAttestation.deserialize(attestation.serialize())
    expect(tlvBody(reparsed.serialize()).toString('hex')).toBe(body.toString('hex'))
  })

  test('ddk settles a CET from a node-dlc attestation', () => {
    const cet = ddk.signContractCet(flow.offer, flow.accept, flow.sign, acceptor.keys, ACCEPT_TEMP_ID, [
      { oracleIndex: 0, attestation: tlvBody(attestation.serialize()) },
    ])
    expect(cet.length).toBeGreaterThan(0)
    // Witness data does not change the txid, so the signed funding tx keeps
    // the txid the unsigned template had.
    expect(txidOf(flow.fundingTx)).toBe(txidOf(flow.acceptResult.transactions.fund.rawBytes))
  })

  test('ddk signs the refund transaction', () => {
    const refund = ddk.signContractRefund(flow.offer, flow.accept, flow.sign, acceptor.keys, ACCEPT_TEMP_ID)
    expect(refund.length).toBeGreaterThan(0)
  })

  test('an attestation for an outcome the contract lacks is NoMatchingOutcome', () => {
    const stray = scenario.oracle.attestEnum(scenario.eventId, 'sideways')
    try {
      ddk.signContractCet(flow.offer, flow.accept, flow.sign, acceptor.keys, ACCEPT_TEMP_ID, [
        { oracleIndex: 0, attestation: tlvBody(stray.serialize()) },
      ])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('NoMatchingOutcome')
    }
  })

  test('the legacy cfd attestation convention (sha256-first) is rejected everywhere', () => {
    // BAL's old cfd oracle signed taggedHash(tag, sha256(outcome)); ddk and
    // @node-dlc 1.2.1 both expect taggedHash(tag, raw outcome bytes). This
    // pins down the migration fault line: a legacy-tagged attestation must
    // fail loudly, in both stacks.
    const legacy = scenario.oracle.attestEnumLegacyCfd(scenario.eventId, 'up')
    const announcement = (scenario.contractInfo.oracleInfo as any).announcement
    expect(() => legacy.validate(announcement)).toThrow(/Invalid signature/)
    try {
      ddk.signContractCet(flow.offer, flow.accept, flow.sign, acceptor.keys, ACCEPT_TEMP_ID, [
        { oracleIndex: 0, attestation: tlvBody(legacy.serialize()) },
      ])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('InvalidAttestation')
    }
  })
})
