import { describe, test, expect } from 'vitest'
import * as ddk from '../dist/index.js'

// ---------------------------------------------------------------------------
// Fixtures (generated from the ddk-ffi Rust tests)
// ---------------------------------------------------------------------------

// A wpkh descriptor with a testnet xprv; its index-0 P2WPKH script and a 200k
// funding UTXO paying to it. The descriptor drives BOTH the offerer's wallet
// (funding-input signing) and, via fromDescriptor, its DLC contract keys.
const OFFERER_DESCRIPTOR =
  'wpkh(tprv8ZgxMBicQKsPdeeuBw7yrpnwFVYj1ehvmPPtkwwnRdSAyCre8qxoyWWuaWLsfNUXNraEoucZQJzLzdj3KNZFJd9Tdv7rm97ikN9yYxQLfMz/84h/1h/0h/0/*)'
const PREV_TX_HEX =
  '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff01400d0300000000001600143a4279e9c96f8305f3bc0566f9d8be101c189a8300000000'
const OFFERER_SPK_HEX = '00143a4279e9c96f8305f3bc0566f9d8be101c189a83'
// A two-outcome ("up"/"down") enum contract with a signed oracle announcement
// and 100 000 sats total collateral.
const CONTRACT_INFO_HEX =
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a5e7bcb1a4d0af5cd7bcc1b9aaabc2ee7463752c4db3d34d28817e27f459da722f4b1c649cec355f3f7bb5d7d3c67605f03ebc4b2b1d42c1aedaa7f186b3077fd944b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374'
// The same contract at 60 000 sats — what is left after splicing 40 000 out of
// the contract above, so it can be the payout table of the spliced successor.
const CONTRACT_INFO_60K_HEX =
  '00000000000000ea600002027570000000000000ea6004646f776e000000000000000000fdd824a5e7bcb1a4d0af5cd7bcc1b9aaabc2ee7463752c4db3d34d28817e27f459da722f4b1c649cec355f3f7bb5d7d3c67605f03ebc4b2b1d42c1aedaa7f186b3077fd944b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374'
// Attestations from the same oracle, over each of the two outcomes. Only the
// announced nonce and the oracle key are checked, so these validate against the
// announcement embedded in CONTRACT_INFO_HEX.
const ATTESTATION_UP_HEX =
  '0c64646b2d6666692d7465737444b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a92500019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67e0b00db2f09efc08cda1554ae4f910a6fb5365c240e24d7be3514eed6825ce230001027570'
const ATTESTATION_DOWN_HEX =
  '0c64646b2d6666692d7465737444b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a92500019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67a6fe48c77115c6c3ed971cd327567a114541738526fa2b0e387a95a994127440000104646f776e'
// Correctly signed by the same oracle with the same nonce, but "sideways" is not
// an outcome this contract has — the NoMatchingOutcome path, as distinct from a
// forged attestation.
const ATTESTATION_SIDEWAYS_HEX =
  '0c64646b2d6666692d7465737444b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a92500019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed674ec7f0ab18bd1f7359df539c7c3a29a82e98be56444f495243b38e720d70cd4a0001087369646577617973'
const ACCEPTOR_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const buf = (hex: string) => Buffer.from(hex, 'hex')
const tempId = (marker: number) => Buffer.alloc(32, marker)
const FUNDING_SERIAL = 100n

// Builds and signs a complete single-funded contract, returning every artifact.
function runFullFlow() {
  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
  const acceptorKeys = ddk.ContractKeyProvider.fromMnemonic(ACCEPTOR_MNEMONIC, undefined, 'regtest')
  const offerTempId = tempId(0x5c)
  const acceptTempId = tempId(0xa1)
  const spk = buf(OFFERER_SPK_HEX)

  const funding = ddk.fundingInput(buf(PREV_TX_HEX), 0, FUNDING_SERIAL, 0xffffffff, 108, Buffer.alloc(0))

  const offer = ddk.createOffer({
    chainHash: ddk.chainHashFromNetwork('regtest'),
    temporaryContractId: offerTempId,
    contractInfo: buf(CONTRACT_INFO_HEX),
    offerCollateralSats: 100_000n,
    party: {
      fundingPubkey: offererKeys.fundingPubkey(offerTempId),
      fundingInputs: [funding],
      payoutSpk: spk,
      payoutSerialId: 1n,
      changeSpk: spk,
      changeSerialId: 2n,
    },
    fundOutputSerialId: 3n,
    feeRatePerVb: 2n,
    cetLocktime: 500,
    refundLocktime: 1_000,
    contractFlags: 0,
  })

  const acceptResult = ddk.acceptOffer(
    offer,
    {
      party: {
        fundingPubkey: acceptorKeys.fundingPubkey(acceptTempId),
        fundingInputs: [],
        payoutSpk: spk,
        payoutSerialId: 4n,
        changeSpk: spk,
        changeSerialId: 5n,
      },
      minTimeoutInterval: 100,
      maxTimeoutInterval: 100_000,
    },
    acceptorKeys,
    acceptTempId,
  )
  const accept = acceptResult.accept

  const fundingPsbt = ddk.createFundingPsbt(offer, accept)
  const signedPsbt = ddk.signFundingPsbtWithDescriptor(offer, accept, fundingPsbt, OFFERER_DESCRIPTOR, [
    { inputSerialId: FUNDING_SERIAL, derivationIndex: 0 },
  ])
  const signResult = ddk.signAccept(offer, accept, offererKeys, offerTempId, signedPsbt)
  const fundingTx = ddk.finalizeSign(offer, accept, signResult.sign, fundingPsbt)

  return {
    offererKeys,
    acceptorKeys,
    offerTempId,
    acceptTempId,
    offer,
    acceptResult,
    accept,
    fundingPsbt,
    signResult,
    fundingTx,
  }
}

// ---------------------------------------------------------------------------

describe('binding surface', () => {
  test('exports the whole stateless contract API', () => {
    const fns = [
      'chainHashFromNetwork',
      'fundingInput',
      'dlcInputMaxWitnessLen',
      'createOffer',
      'validateOffer',
      'validateAccept',
      'validateSign',
      'computeContractId',
      'contractInfoPayouts',
      'acceptOffer',
      'createFundingPsbt',
      'dlcTransactionsFromMessages',
      'signFundingPsbtWithDescriptor',
      'signAccept',
      'signAcceptSpliced',
      'finalizeSign',
      'finalizeSignSpliced',
      'signContractCet',
      'signContractRefund',
      'createDlcSpliceInput',
    ]
    for (const name of fns) {
      expect(typeof (ddk as Record<string, unknown>)[name], name).toBe('function')
    }
    expect(typeof ddk.ContractKeyProvider).toBe('function') // the class constructor
    expect(ddk.Party.Offer).toBeDefined()
    expect(ddk.Party.Accept).toBeDefined()
  })
})

describe('ContractKeyProvider', () => {
  test('all constructors agree and funding keys are deterministic', () => {
    const seed = ddk.convertMnemonicToSeed(MNEMONIC, undefined)
    const fromMnemonic = ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'bitcoin')
    const fromSeed = ddk.ContractKeyProvider.fromSeed(seed, 'bitcoin')
    const xprv = ddk.createExtkeyFromSeed(seed, 'bitcoin')
    const fromXprv = ddk.ContractKeyProvider.fromXprv(xprv)

    const id = tempId(0x11)
    const expected = fromMnemonic.fundingPubkey(id)
    expect(expected.length).toBe(33)
    expect([0x02, 0x03]).toContain(expected[0])
    expect(fromSeed.fundingPubkey(id).equals(expected)).toBe(true)
    expect(fromXprv.fundingPubkey(id).equals(expected)).toBe(true)
    // Deterministic, and different ids yield different keys.
    expect(fromMnemonic.fundingPubkey(id).equals(expected)).toBe(true)
    expect(fromMnemonic.fundingPubkey(tempId(0x22)).equals(expected)).toBe(false)
  })

  test('fromDescriptor derives from the descriptor xprv', () => {
    const provider = ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
    expect(provider.fundingPubkey(tempId(0x01)).length).toBe(33)
  })

  test('rejects a wrong-length temporary id', () => {
    const provider = ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest')
    try {
      provider.fundingPubkey(Buffer.alloc(31))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('InvalidLength')
    }
  })

  test('rejects an unknown network', () => {
    try {
      ddk.ContractKeyProvider.fromSeed(Buffer.alloc(64), 'mainnet-typo')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('InvalidNetwork')
    }
  })
})

describe('offer-building helpers', () => {
  test('chainHashFromNetwork returns 32 bytes', () => {
    for (const network of ['bitcoin', 'testnet', 'signet', 'regtest']) {
      expect(ddk.chainHashFromNetwork(network).length).toBe(32)
    }
  })

  test('dlcInputMaxWitnessLen is 220', () => {
    expect(ddk.dlcInputMaxWitnessLen()).toBe(220)
  })

  test('fundingInput encodes a FundingInput', () => {
    const input = ddk.fundingInput(buf(PREV_TX_HEX), 0, FUNDING_SERIAL, 0xffffffff, 108, Buffer.alloc(0))
    expect(Buffer.isBuffer(input)).toBe(true)
    expect(input.length).toBeGreaterThan(0)
  })
})

describe('full single-funded lifecycle', () => {
  const flow = runFullFlow()

  test('createOffer -> validateOffer', () => {
    expect(flow.offer.length).toBeGreaterThan(0)
    expect(() => ddk.validateOffer(flow.offer, 100, 100_000)).not.toThrow()
  })

  test('acceptOffer -> AcceptResult with transactions + psbt', () => {
    expect(flow.accept.length).toBeGreaterThan(0)
    expect(flow.acceptResult.fundingPsbt.length).toBeGreaterThan(0)
    expect(flow.acceptResult.transactions.cets.length).toBe(2) // two enum outcomes
    expect(() => ddk.validateAccept(flow.offer, flow.accept)).not.toThrow()
  })

  test('signAccept -> validateSign', () => {
    expect(flow.signResult.sign.length).toBeGreaterThan(0)
    expect(() => ddk.validateSign(flow.offer, flow.accept, flow.signResult.sign)).not.toThrow()
  })

  test('finalizeSign -> a signed funding transaction', () => {
    expect(Buffer.isBuffer(flow.fundingTx)).toBe(true)
    expect(flow.fundingTx.length).toBeGreaterThan(0)
    // Signing added witnesses, so the final transaction is larger than the
    // unsigned one acceptOffer rebuilt.
    expect(flow.fundingTx.length).toBeGreaterThan(flow.acceptResult.transactions.fund.rawBytes.length)
  })

  // The whole point of the stateless API: nothing is stored, so every artifact
  // has to come back byte-identical from the messages alone.
  test('createFundingPsbt rebuilds the PSBT acceptOffer returned', () => {
    expect(ddk.createFundingPsbt(flow.offer, flow.accept).equals(flow.acceptResult.fundingPsbt)).toBe(true)
  })

  test('dlcTransactionsFromMessages rebuilds what acceptOffer returned', () => {
    const rebuilt = ddk.dlcTransactionsFromMessages(flow.offer, flow.accept)
    expect(rebuilt.fund.rawBytes.equals(flow.acceptResult.transactions.fund.rawBytes)).toBe(true)
    expect(rebuilt.refund.rawBytes.equals(flow.acceptResult.transactions.refund.rawBytes)).toBe(true)
    expect(rebuilt.cets.length).toBe(flow.acceptResult.transactions.cets.length)
    rebuilt.cets.forEach((cet, i) => {
      expect(cet.rawBytes.equals(flow.acceptResult.transactions.cets[i]!.rawBytes)).toBe(true)
    })
  })
})

describe('validation rejects tampered / mismatched messages', () => {
  const flow = runFullFlow()

  test('validateOffer throws on malformed bytes with a code', () => {
    try {
      ddk.validateOffer(buf('deadbeef'), 100, 100_000)
      throw new Error('should have thrown')
    } catch (e) {
      expect(typeof (e as { code?: string }).code).toBe('string')
    }
  })

  test('validateSign rejects a non-sign message', () => {
    expect(() => ddk.validateSign(flow.offer, flow.accept, flow.accept)).toThrow()
  })

  test('validateAccept rejects bytes that are not an accept for this offer', () => {
    expect(() => ddk.validateAccept(flow.offer, buf('deadbeef'))).toThrow()
    expect(() => ddk.validateAccept(flow.offer, flow.offer)).toThrow()
  })

  // What a caller may rely on being stable, and what it may not.
  //
  // With every serial id and temporary id fixed, the OFFER is byte-identical
  // across runs. The ACCEPT is deliberately not compared: its CET adaptor
  // signatures are randomized, so two accepts of the same offer differ byte for
  // byte while describing the same contract. An AcceptDlc is therefore not a
  // content hash of the contract — but everything rebuilt from a given pair of
  // messages is, which is what makes storing only the messages sufficient.
  test('the offer is deterministic, and rebuilt artifacts are stable across accepts', () => {
    const again = runFullFlow()
    expect(again.offer.equals(flow.offer)).toBe(true)

    expect(ddk.computeContractId(flow.offer, again.accept).equals(ddk.computeContractId(flow.offer, flow.accept))).toBe(
      true,
    )
    const fromOther = ddk.dlcTransactionsFromMessages(flow.offer, again.accept)
    expect(fromOther.fund.rawBytes.equals(flow.acceptResult.transactions.fund.rawBytes)).toBe(true)
    expect(fromOther.refund.rawBytes.equals(flow.acceptResult.transactions.refund.rawBytes)).toBe(true)
  })

  test('validateOffer rejects an oracle timeout outside the accepted window', () => {
    // The fixture event matures at 750 against a refund locktime of 1000, a gap
    // of 250 — outside a 1..100 window.
    expect(() => ddk.validateOffer(flow.offer, 1, 100)).toThrow()
  })

  test('undecodable message bytes surface as Serialization', () => {
    try {
      ddk.computeContractId(buf('deadbeef'), flow.accept)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('Serialization')
    }
  })
})

describe('inspection', () => {
  const flow = runFullFlow()

  test('computeContractId is 32 bytes and stable', () => {
    const id = ddk.computeContractId(flow.offer, flow.accept)
    expect(id.length).toBe(32)
    expect(id.equals(ddk.computeContractId(flow.offer, flow.accept))).toBe(true)
  })

  test('dlcTransactionsFromMessages rebuilds the transactions', () => {
    const txs = ddk.dlcTransactionsFromMessages(flow.offer, flow.accept)
    expect(txs.cets.length).toBe(2)
    expect(Buffer.isBuffer(txs.fund.rawBytes)).toBe(true)
  })

  test('contractInfoPayouts derives the enum payout table', () => {
    const payouts = ddk.contractInfoPayouts(buf(CONTRACT_INFO_HEX))
    expect(payouts.isEnum).toBe(true)
    expect(payouts.totalCollateralSats).toBe(100_000n)
    expect(payouts.rows.length).toBe(2)
    const up = payouts.rows.find((r) => r.outcome === 'up')!
    expect(up.offerPayoutSats).toBe(100_000n)
    expect(up.acceptPayoutSats).toBe(0n)
    const down = payouts.rows.find((r) => r.outcome === 'down')!
    expect(down.offerPayoutSats).toBe(0n)
    expect(down.acceptPayoutSats).toBe(100_000n)
  })
})

describe('settlement', () => {
  const flow = runFullFlow()
  const up = [{ oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) }]

  test('signContractCet signs the CET for the attested outcome', () => {
    const cet = ddk.signContractCet(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      flow.offererKeys,
      flow.offerTempId,
      up,
    )
    expect(Buffer.isBuffer(cet)).toBe(true)
    expect(cet.length).toBeGreaterThan(0)
    // The other outcome resolves to a different CET.
    const down = ddk.signContractCet(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      flow.offererKeys,
      flow.offerTempId,
      [{ oracleIndex: 0, attestation: buf(ATTESTATION_DOWN_HEX) }],
    )
    expect(down.equals(cet)).toBe(false)
  })

  test('either party can settle on its own', () => {
    const byAcceptor = ddk.signContractCet(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      flow.acceptorKeys,
      flow.acceptTempId,
      up,
    )
    expect(byAcceptor.length).toBeGreaterThan(0)
  })

  test('an outcome the contract does not have throws NoMatchingOutcome', () => {
    try {
      ddk.signContractCet(flow.offer, flow.accept, flow.signResult.sign, flow.offererKeys, flow.offerTempId, [
        { oracleIndex: 0, attestation: buf(ATTESTATION_SIDEWAYS_HEX) },
      ])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('NoMatchingOutcome')
    }
  })

  test('an out-of-range oracle index throws InvalidAttestation', () => {
    try {
      ddk.signContractCet(flow.offer, flow.accept, flow.signResult.sign, flow.offererKeys, flow.offerTempId, [
        { oracleIndex: 5, attestation: buf(ATTESTATION_UP_HEX) },
      ])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('InvalidAttestation')
    }
  })

  test('signContractRefund signs the refund for either party', () => {
    const byOfferer = ddk.signContractRefund(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      flow.offererKeys,
      flow.offerTempId,
    )
    const byAcceptor = ddk.signContractRefund(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      flow.acceptorKeys,
      flow.acceptTempId,
    )
    expect(byOfferer.length).toBeGreaterThan(0)
    expect(byAcceptor.equals(byOfferer)).toBe(true)
  })

  test('a provider that is neither party throws Key', () => {
    const stranger = ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest')
    try {
      ddk.signContractRefund(flow.offer, flow.accept, flow.signResult.sign, stranger, flow.offerTempId)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('Key')
    }
  })
})

describe('splicing', () => {
  const flow = runFullFlow()

  test('createDlcSpliceInput builds a splice FundingInput from a contract', () => {
    const spliceInput = ddk.createDlcSpliceInput(
      flow.offer,
      flow.accept,
      ddk.Party.Offer,
      900n,
      ddk.dlcInputMaxWitnessLen(),
    )
    expect(Buffer.isBuffer(spliceInput)).toBe(true)
    expect(spliceInput.length).toBeGreaterThan(0)
  })

  test('rejects a max witness length <= 108', () => {
    expect(() => ddk.createDlcSpliceInput(flow.offer, flow.accept, ddk.Party.Offer, 900n, 108)).toThrow()
  })

  // A splice-out rollover: contract B is funded entirely by spending contract
  // A's 2-of-2 output, taking 40 000 sats out on the way (100 000 -> 60 000).
  // This is the only path that exercises signAcceptSpliced / finalizeSignSpliced,
  // and the only one where each party must re-derive a PRIOR contract's funding
  // key — note the two splice-key refs carry DIFFERENT prior temporary ids,
  // because each party derives its own half of A's 2-of-2.
  const SPLICE_SERIAL = 900n
  const offerTempIdB = tempId(0xbb)
  const acceptTempIdB = tempId(0xbc)

  function runSpliceOut() {
    const spliceInput = ddk.createDlcSpliceInput(
      flow.offer,
      flow.accept,
      ddk.Party.Offer,
      SPLICE_SERIAL,
      ddk.dlcInputMaxWitnessLen(),
    )
    const spk = buf(OFFERER_SPK_HEX)

    const offerB = ddk.createOffer({
      chainHash: ddk.chainHashFromNetwork('regtest'),
      temporaryContractId: offerTempIdB,
      contractInfo: buf(CONTRACT_INFO_60K_HEX),
      offerCollateralSats: 60_000n,
      party: {
        fundingPubkey: flow.offererKeys.fundingPubkey(offerTempIdB),
        fundingInputs: [spliceInput],
        payoutSpk: spk,
        payoutSerialId: 1n,
        changeSpk: spk,
        changeSerialId: 2n,
      },
      fundOutputSerialId: 3n,
      feeRatePerVb: 2n,
      cetLocktime: 500,
      refundLocktime: 1_000,
      contractFlags: 0,
    })

    const acceptB = ddk.acceptOffer(
      offerB,
      {
        party: {
          fundingPubkey: flow.acceptorKeys.fundingPubkey(acceptTempIdB),
          fundingInputs: [],
          payoutSpk: spk,
          payoutSerialId: 4n,
          changeSpk: spk,
          changeSerialId: 5n,
        },
        minTimeoutInterval: 100,
        maxTimeoutInterval: 100_000,
      },
      flow.acceptorKeys,
      acceptTempIdB,
    ).accept

    // The offerer signs its half of A's 2-of-2 (there are no wallet inputs to
    // sign, so the PSBT goes across untouched)...
    const psbt = ddk.createFundingPsbt(offerB, acceptB)
    const signB = ddk.signAcceptSpliced(offerB, acceptB, flow.offererKeys, offerTempIdB, psbt, [
      { inputSerialId: SPLICE_SERIAL, priorTemporaryContractId: flow.offerTempId },
    ]).sign

    // ...and the acceptor completes it.
    const fundingTx = ddk.finalizeSignSpliced(offerB, acceptB, signB, psbt, flow.acceptorKeys, [
      { inputSerialId: SPLICE_SERIAL, priorTemporaryContractId: flow.acceptTempId },
    ])
    return { offerB, acceptB, signB, fundingTx }
  }

  const splice = runSpliceOut()

  test('signAcceptSpliced -> finalizeSignSpliced completes a spliced contract', () => {
    expect(Buffer.isBuffer(splice.fundingTx)).toBe(true)
    expect(() => ddk.validateSign(splice.offerB, splice.acceptB, splice.signB)).not.toThrow()
    // Witnesses were added for the prior 2-of-2, so the signed transaction is
    // larger than the unsigned one rebuilt from the messages.
    const unsigned = ddk.dlcTransactionsFromMessages(splice.offerB, splice.acceptB)
    expect(splice.fundingTx.length).toBeGreaterThan(unsigned.fund.rawBytes.length)
    // Single input: the prior contract's funding output is the only thing spent.
    expect(unsigned.fund.inputs.length).toBe(1)
  })

  // Proves the splice-key refs are load-bearing rather than incidental: the
  // acceptor deriving from the OFFERER's prior temporary id produces the wrong
  // half of contract A's 2-of-2, so the witness cannot be completed.
  test('each party must use its own prior temporary contract id', () => {
    const psbt = ddk.createFundingPsbt(splice.offerB, splice.acceptB)
    expect(() =>
      ddk.finalizeSignSpliced(splice.offerB, splice.acceptB, splice.signB, psbt, flow.acceptorKeys, [
        { inputSerialId: SPLICE_SERIAL, priorTemporaryContractId: flow.offerTempId },
      ]),
    ).toThrow()
  })

  test('the spliced contract carries the reduced collateral', () => {
    const payouts = ddk.contractInfoPayouts(buf(CONTRACT_INFO_60K_HEX))
    expect(payouts.totalCollateralSats).toBe(60_000n)
    // 40 000 of the prior contract's 100 000 was spliced out.
    expect(ddk.contractInfoPayouts(buf(CONTRACT_INFO_HEX)).totalCollateralSats - payouts.totalCollateralSats).toBe(
      40_000n,
    )
  })

  test('the spliced contract settles like any other', () => {
    const cet = ddk.signContractCet(splice.offerB, splice.acceptB, splice.signB, flow.offererKeys, offerTempIdB, [
      { oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) },
    ])
    expect(cet.length).toBeGreaterThan(0)
    const refund = ddk.signContractRefund(splice.offerB, splice.acceptB, splice.signB, flow.acceptorKeys, acceptTempIdB)
    expect(refund.length).toBeGreaterThan(0)
    expect(refund.equals(cet)).toBe(false)
  })
})
