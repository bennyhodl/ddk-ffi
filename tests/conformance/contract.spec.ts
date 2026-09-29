import { beforeAll, describe, test, expect } from 'vitest'
import * as ddk from '@bennyblader/ddk'

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
// The acceptor's clock. The fixture announcement matures at 750, so this must
// be before it: validateOffer/acceptOffer refuse an already-matured event.
const NOW_UNIX = 100n
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
// The bindings are generated with strictByteArrays, so a `Vec<u8>` return is a
// Uint8Array, not a Buffer. Arguments need no conversion (a Buffer IS a
// Uint8Array); this only re-wraps a return value to reach Buffer's own methods,
// and it is zero-copy.
const bytes = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)
const tempId = (marker: number) => Buffer.alloc(32, marker)
const FUNDING_SERIAL = 100n

// Builds and signs a complete single-funded contract, returning every artifact.
async function runFullFlow(options?: {
  fundingPubkey?: Uint8Array
  signers?: ddk.ContractSignerProvider
  wallet?: ddk.FundingWallet
  offerTempId?: Uint8Array
}) {
  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
  const acceptorKeys = ddk.ContractKeyProvider.fromMnemonic(ACCEPTOR_MNEMONIC, undefined, 'regtest')
  const offerTempId = options?.offerTempId ?? tempId(0x5c)
  const spk = buf(OFFERER_SPK_HEX)

  const funding = ddk.fundingInput(buf(PREV_TX_HEX), 0, FUNDING_SERIAL, 0xffffffff, 108, Buffer.alloc(0))

  const offer = ddk.createOffer({
    chainHash: ddk.chainHashFromNetwork('regtest'),
    temporaryContractId: offerTempId,
    contractInfo: buf(CONTRACT_INFO_HEX),
    offerCollateralSats: 100_000n,
    party: {
      fundingPubkey: options?.fundingPubkey ?? offererKeys.fundingPubkey(offerTempId),
      fundingInputs: [funding],
      payoutSpk: spk,
      payoutSerialId: 1n,
      changeSpk: spk,
      changeSerialId: 2n,
    },
    fundOutputSerialId: 3n,
    feeRatePerVb: 2n,
    // Must equal the maturity epoch of the announcement in CONTRACT_INFO_HEX:
    // acceptOffer pins the CET locktime to the closest maturity date.
    cetLocktime: 750,
    refundLocktime: 1_000,
    contractFlags: 0,
  })

  const acceptResult = ddk.acceptOffer(
    offer,
    {
      party: {
        // The acceptor derives its key from the offer's temporary id.
        fundingPubkey: acceptorKeys.fundingPubkey(ddk.offerTemporaryContractId(offer)),
        fundingInputs: [],
        payoutSpk: spk,
        payoutSerialId: 4n,
        changeSpk: spk,
        changeSerialId: 5n,
      },
      minTimeoutInterval: 100,
      maxTimeoutInterval: 100_000,
      nowUnix: NOW_UNIX,
    },
    new ddk.Signers(acceptorKeys),
  )
  const accept = acceptResult.accept

  // The offerer's signers: its contract keys and the wallet over its
  // descriptor, which signs its one funding input inside signAccept.
  const offererSigners = new ddk.Signers(options?.signers ?? offererKeys).withWallet(
    options?.wallet ?? new ddk.DescriptorWallet(OFFERER_DESCRIPTOR),
  )
  const signResult = await ddk.signAccept(offer, accept, offererSigners)
  const fundingTx = await ddk.finalizeSign(offer, accept, signResult.sign, new ddk.Signers(acceptorKeys))

  return {
    offererKeys,
    acceptorKeys,
    offerTempId,
    offer,
    acceptResult,
    accept,
    signResult,
    fundingTx,
  }
}

// ---------------------------------------------------------------------------

describe('binding surface', () => {
  test('exports the whole stateless contract API', async () => {
    const fns = [
      'chainHashFromNetwork',
      'fundingInput',
      'dlcInputMaxWitnessLen',
      'createOffer',
      'validateOffer',
      'validateAccept',
      'validateSign',
      'computeContractId',
      'offerTemporaryContractId',
      'contractInfoPayouts',
      'acceptOffer',
      'createFundingPsbt',
      'dlcTransactionsFromMessages',
      'signAccept',
      'finalizeSign',
      'contractCetTransaction',
      'contractRefundTransaction',
      'createDlcSpliceInput',
      'splicedContractIds',
      'prepareAcceptOffer',
      'completeAcceptOffer',
      'prepareSignAccept',
      'completeSignAccept',
      'finalizeSignWithSignatures',
      'prepareFinalizeSign',
    ]
    for (const name of fns) {
      expect(typeof (ddk as Record<string, unknown>)[name], name).toBe('function')
    }
    expect(typeof ddk.ContractKeyProvider).toBe('function') // the class constructor
    expect(typeof ddk.DescriptorWallet).toBe('function')
    expect(typeof ddk.Signers).toBe('function')
    expect(ddk.Party.Offer).toBeDefined()
    expect(ddk.Party.Accept).toBeDefined()
  })
})

describe('ContractKeyProvider', () => {
  test('all constructors agree and funding keys are deterministic', async () => {
    const seed = ddk.convertMnemonicToSeed(MNEMONIC, undefined)
    const fromMnemonic = ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'bitcoin')
    const fromSeed = ddk.ContractKeyProvider.fromSeed(seed, 'bitcoin')
    const xprv = ddk.createExtkeyFromSeed(seed, 'bitcoin')
    const fromXprv = ddk.ContractKeyProvider.fromXprv(xprv)

    const id = tempId(0x11)
    const expected = fromMnemonic.fundingPubkey(id)
    expect(expected.length).toBe(33)
    expect([0x02, 0x03]).toContain(expected[0])
    expect(bytes(fromSeed.fundingPubkey(id)).equals(expected)).toBe(true)
    expect(bytes(fromXprv.fundingPubkey(id)).equals(expected)).toBe(true)
    // Deterministic, and different ids yield different keys.
    expect(bytes(fromMnemonic.fundingPubkey(id)).equals(expected)).toBe(true)
    expect(bytes(fromMnemonic.fundingPubkey(tempId(0x22))).equals(expected)).toBe(false)
  })

  test('fromDescriptor derives from the descriptor xprv', async () => {
    const provider = ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
    expect(provider.fundingPubkey(tempId(0x01)).length).toBe(33)
  })

  test('rejects a wrong-length temporary id', async () => {
    const provider = ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest')
    try {
      provider.fundingPubkey(Buffer.alloc(31))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('InvalidLength')
    }
  })

  test('rejects an unknown network', async () => {
    try {
      ddk.ContractKeyProvider.fromSeed(Buffer.alloc(64), 'mainnet-typo')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('InvalidNetwork')
    }
  })
})

describe('offer-building helpers', () => {
  test('chainHashFromNetwork returns 32 bytes', async () => {
    for (const network of ['bitcoin', 'testnet', 'signet', 'regtest']) {
      expect(ddk.chainHashFromNetwork(network).length).toBe(32)
    }
  })

  test('dlcInputMaxWitnessLen is 220', async () => {
    expect(ddk.dlcInputMaxWitnessLen()).toBe(220)
  })

  test('fundingInput encodes a FundingInput', async () => {
    const input = ddk.fundingInput(buf(PREV_TX_HEX), 0, FUNDING_SERIAL, 0xffffffff, 108, Buffer.alloc(0))
    expect(input instanceof Uint8Array).toBe(true)
    expect(input.length).toBeGreaterThan(0)
  })
})

describe('full single-funded lifecycle', () => {
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  beforeAll(async () => {
    flow = await runFullFlow()
  })

  test('createOffer -> validateOffer', async () => {
    expect(flow.offer.length).toBeGreaterThan(0)
    expect(() => ddk.validateOffer(flow.offer, 100, 100_000, NOW_UNIX)).not.toThrow()
  })

  test('acceptOffer -> AcceptResult with transactions + psbt', async () => {
    expect(flow.accept.length).toBeGreaterThan(0)
    expect(flow.acceptResult.fundingPsbt.length).toBeGreaterThan(0)
    expect(flow.acceptResult.transactions.cets.length).toBe(2) // two enum outcomes
    expect(() => ddk.validateAccept(flow.offer, flow.accept)).not.toThrow()
  })

  test('signAccept -> validateSign', async () => {
    expect(flow.signResult.sign.length).toBeGreaterThan(0)
    expect(() => ddk.validateSign(flow.offer, flow.accept, flow.signResult.sign)).not.toThrow()
  })

  test('finalizeSign -> a signed funding transaction', async () => {
    expect(flow.fundingTx instanceof Uint8Array).toBe(true)
    expect(flow.fundingTx.length).toBeGreaterThan(0)
    // Signing added witnesses, so the final transaction is larger than the
    // unsigned one acceptOffer rebuilt.
    expect(flow.fundingTx.length).toBeGreaterThan(flow.acceptResult.transactions.fund.rawBytes.length)
  })

  // The whole point of the stateless API: nothing is stored, so every artifact
  // has to come back byte-identical from the messages alone.
  test('createFundingPsbt rebuilds the PSBT acceptOffer returned', async () => {
    expect(bytes(ddk.createFundingPsbt(flow.offer, flow.accept)).equals(flow.acceptResult.fundingPsbt)).toBe(true)
  })

  test('dlcTransactionsFromMessages rebuilds what acceptOffer returned', async () => {
    const rebuilt = ddk.dlcTransactionsFromMessages(flow.offer, flow.accept)
    expect(bytes(rebuilt.fund.rawBytes).equals(flow.acceptResult.transactions.fund.rawBytes)).toBe(true)
    expect(bytes(rebuilt.refund.rawBytes).equals(flow.acceptResult.transactions.refund.rawBytes)).toBe(true)
    expect(rebuilt.cets.length).toBe(flow.acceptResult.transactions.cets.length)
    rebuilt.cets.forEach((cet, i) => {
      expect(bytes(cet.rawBytes).equals(flow.acceptResult.transactions.cets[i]!.rawBytes)).toBe(true)
    })
  })
})

describe('validation rejects tampered / mismatched messages', () => {
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  beforeAll(async () => {
    flow = await runFullFlow()
  })

  test('validateOffer throws on malformed bytes with a code', async () => {
    try {
      ddk.validateOffer(buf('deadbeef'), 100, 100_000, NOW_UNIX)
      throw new Error('should have thrown')
    } catch (e) {
      expect(typeof (e as { tag?: string }).tag).toBe('string')
    }
  })

  test('validateSign rejects a non-sign message', async () => {
    expect(() => ddk.validateSign(flow.offer, flow.accept, flow.accept)).toThrow()
  })

  test('validateAccept rejects bytes that are not an accept for this offer', async () => {
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
  test('the offer is deterministic, and rebuilt artifacts are stable across accepts', async () => {
    const again = await runFullFlow()
    expect(bytes(again.offer).equals(flow.offer)).toBe(true)

    expect(
      bytes(ddk.computeContractId(flow.offer, again.accept)).equals(ddk.computeContractId(flow.offer, flow.accept)),
    ).toBe(true)
    const fromOther = ddk.dlcTransactionsFromMessages(flow.offer, again.accept)
    expect(bytes(fromOther.fund.rawBytes).equals(flow.acceptResult.transactions.fund.rawBytes)).toBe(true)
    expect(bytes(fromOther.refund.rawBytes).equals(flow.acceptResult.transactions.refund.rawBytes)).toBe(true)
  })

  test('validateOffer rejects an oracle timeout outside the accepted window', async () => {
    // The fixture event matures at 750 against a refund locktime of 1000, a gap
    // of 250 — outside a 1..100 window.
    expect(() => ddk.validateOffer(flow.offer, 1, 100, NOW_UNIX)).toThrow()
  })

  test('validateOffer rejects an offer whose oracle event has already matured', async () => {
    // The fixture event matures at 750; a clock at or past it is refused.
    expect(() => ddk.validateOffer(flow.offer, 100, 100_000, 750n)).toThrow()
    expect(() => ddk.validateOffer(flow.offer, 100, 100_000, 749n)).not.toThrow()
  })

  test('undecodable message bytes surface as Serialization', async () => {
    try {
      ddk.computeContractId(buf('deadbeef'), flow.accept)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('Serialization')
    }
  })
})

describe('inspection', () => {
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  beforeAll(async () => {
    flow = await runFullFlow()
  })

  test('computeContractId is 32 bytes and stable', async () => {
    const id = ddk.computeContractId(flow.offer, flow.accept)
    expect(id.length).toBe(32)
    expect(bytes(id).equals(ddk.computeContractId(flow.offer, flow.accept))).toBe(true)
  })

  test('dlcTransactionsFromMessages rebuilds the transactions', async () => {
    const txs = ddk.dlcTransactionsFromMessages(flow.offer, flow.accept)
    expect(txs.cets.length).toBe(2)
    expect(txs.fund.rawBytes instanceof Uint8Array).toBe(true)
  })

  test('contractInfoPayouts derives the enum payout table', async () => {
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
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  beforeAll(async () => {
    flow = await runFullFlow()
  })
  const up = [{ oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) }]

  test('contractCetTransaction builds the CET for the attested outcome from the messages alone', async () => {
    const cet = ddk.contractCetTransaction(flow.offer, flow.accept, flow.signResult.sign, up)
    expect(cet instanceof Uint8Array).toBe(true)
    // Both halves of the 2-of-2 are present: the signed CET is larger than the
    // unsigned one rebuilt from the messages.
    const unsigned = ddk.dlcTransactionsFromSignedMessages(flow.offer, flow.accept, flow.signResult.sign)
    expect(cet.length).toBeGreaterThan(unsigned.cets[0]!.rawBytes.length)
    // The other outcome resolves to a different CET.
    const down = ddk.contractCetTransaction(flow.offer, flow.accept, flow.signResult.sign, [
      { oracleIndex: 0, attestation: buf(ATTESTATION_DOWN_HEX) },
    ])
    expect(bytes(down).equals(cet)).toBe(false)
  })

  test('an outcome the contract does not have throws NoMatchingOutcome', async () => {
    try {
      ddk.contractCetTransaction(flow.offer, flow.accept, flow.signResult.sign, [
        { oracleIndex: 0, attestation: buf(ATTESTATION_SIDEWAYS_HEX) },
      ])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('NoMatchingOutcome')
    }
  })

  test('an out-of-range oracle index throws InvalidAttestation', async () => {
    try {
      ddk.contractCetTransaction(flow.offer, flow.accept, flow.signResult.sign, [
        { oracleIndex: 5, attestation: buf(ATTESTATION_UP_HEX) },
      ])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('InvalidAttestation')
    }
  })

  test('contractRefundTransaction builds the refund from the two refund signatures', async () => {
    const refund = ddk.contractRefundTransaction(flow.offer, flow.accept, flow.signResult.sign)
    const unsigned = ddk.dlcTransactionsFromSignedMessages(flow.offer, flow.accept, flow.signResult.sign)
    expect(refund.length).toBeGreaterThan(unsigned.refund.rawBytes.length)
  })

  test('a message whose signatures belong to another contract is rejected', async () => {
    // The same flow under another temporary id: a different contract, with
    // different keys on both sides, whose messages are individually well formed.
    const other = await runFullFlow({ offerTempId: tempId(0x77) })
    expect(bytes(other.signResult.sign).equals(flow.signResult.sign)).toBe(false)
    expect(() => ddk.contractRefundTransaction(flow.offer, flow.accept, other.signResult.sign)).toThrow()
    expect(() => ddk.contractCetTransaction(flow.offer, other.accept, flow.signResult.sign, up)).toThrow()
  })
})

describe('splicing', () => {
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  let contractIdA: Uint8Array
  beforeAll(async () => {
    flow = await runFullFlow()
    contractIdA = ddk.computeContractId(flow.offer, flow.accept)
  })

  test('createDlcSpliceInput builds a splice FundingInput from a contract', async () => {
    const spliceInput = ddk.createDlcSpliceInput(flow.offer, flow.accept, flow.signResult.sign, ddk.Party.Offer, 900n)
    expect(spliceInput instanceof Uint8Array).toBe(true)
    expect(spliceInput.length).toBeGreaterThan(0)
  })

  // A splice-out rollover: contract B is funded entirely by spending contract
  // A's 2-of-2 output, taking 40 000 sats out on the way (100 000 -> 60 000).
  // This is the only path where each party must re-derive a PRIOR contract's
  // funding key. The offer's DLC input carries A's contract id and funding
  // transaction, from which A's temporary id, and so each party's key, derive.
  const SPLICE_SERIAL = 900n
  const offerTempIdB = tempId(0xbb)

  async function runSpliceOut() {
    const spliceInput = ddk.createDlcSpliceInput(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      ddk.Party.Offer,
      SPLICE_SERIAL,
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
      // Must equal the maturity epoch of the announcement in CONTRACT_INFO_HEX:
      // acceptOffer pins the CET locktime to the closest maturity date.
      cetLocktime: 750,
      refundLocktime: 1_000,
      contractFlags: 0,
    })

    const acceptB = ddk.acceptOffer(
      offerB,
      {
        party: {
          fundingPubkey: flow.acceptorKeys.fundingPubkey(offerTempIdB),
          fundingInputs: [],
          payoutSpk: spk,
          payoutSerialId: 4n,
          changeSpk: spk,
          changeSerialId: 5n,
        },
        minTimeoutInterval: 100,
        maxTimeoutInterval: 100_000,
        nowUnix: NOW_UNIX,
      },
      new ddk.Signers(flow.acceptorKeys),
    ).accept

    // The offerer signs its half of A's 2-of-2 (there are no wallet inputs,
    // so neither party needs a wallet)...
    const signB = (await ddk.signAccept(offerB, acceptB, new ddk.Signers(flow.offererKeys))).sign

    // ...and the acceptor, which learns which of its contracts is spliced from
    // the offer alone, completes it.
    const fundingTx = await ddk.finalizeSign(offerB, acceptB, signB, new ddk.Signers(flow.acceptorKeys))
    return { offerB, acceptB, signB, fundingTx }
  }

  let splice: Awaited<ReturnType<typeof runSpliceOut>>
  beforeAll(async () => {
    splice = await runSpliceOut()
  })

  test('prepareFinalizeSign lists the acceptor half of the spliced contract once the sign verifies', async () => {
    const request = ddk.prepareFinalizeSign(splice.offerB, splice.acceptB, splice.signB)
    expect(request.dlcInputs.length).toBe(1)
    expect(bytes(request.dlcInputs[0]!.key.contractId)).toEqual(bytes(ddk.computeContractId(flow.offer, flow.accept)))
    // A's temporary id is recovered from the splice input, not supplied.
    expect(bytes(request.dlcInputs[0]!.key.temporaryContractId)).toEqual(flow.offerTempId)
    expect(bytes(request.dlcInputs[0]!.key.fundingPubkey)).toEqual(
      bytes(flow.acceptorKeys.fundingPubkey(flow.offerTempId)),
    )
    expect(request.fundingPsbt.length).toBeGreaterThan(0)
    // Nothing to sign for a contract that splices nothing.
    expect(ddk.prepareFinalizeSign(flow.offer, flow.accept, flow.signResult.sign).dlcInputs).toEqual([])
    // Another contract's sign message is rejected before any request is built.
    expect(() => ddk.prepareFinalizeSign(splice.offerB, splice.acceptB, flow.signResult.sign)).toThrow()
  })

  test('splicedContractIds names the spliced contract', async () => {
    const ids = ddk.splicedContractIds(splice.offerB)
    expect(ids.length).toBe(1)
    expect(bytes(ids[0]!).equals(contractIdA)).toBe(true)
    expect(ddk.splicedContractIds(flow.offer).length).toBe(0)
  })

  test('signAccept -> finalizeSign completes a spliced contract', async () => {
    expect(splice.fundingTx instanceof Uint8Array).toBe(true)
    expect(() => ddk.validateSign(splice.offerB, splice.acceptB, splice.signB)).not.toThrow()
    // Witnesses were added for the prior 2-of-2, so the signed transaction is
    // larger than the unsigned one rebuilt from the messages.
    const unsigned = ddk.dlcTransactionsFromMessages(splice.offerB, splice.acceptB)
    expect(splice.fundingTx.length).toBeGreaterThan(unsigned.fund.rawBytes.length)
    // Single input: the prior contract's funding output is the only thing spent.
    expect(unsigned.fund.inputs.length).toBe(1)
  })

  test('providers built from the seeds sign the splice with nothing registered', async () => {
    // Fresh instances, as after a restart: no fundingPubkey call, no restore.
    const freshOfferer = new ddk.Signers(ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR))
    const signed = await ddk.signAccept(splice.offerB, splice.acceptB, freshOfferer)
    expect(() => ddk.validateSign(splice.offerB, splice.acceptB, signed.sign)).not.toThrow()
    const freshAcceptor = new ddk.Signers(ddk.ContractKeyProvider.fromMnemonic(ACCEPTOR_MNEMONIC, undefined, 'regtest'))
    expect(bytes(await ddk.finalizeSign(splice.offerB, splice.acceptB, splice.signB, freshAcceptor))).toEqual(
      bytes(splice.fundingTx),
    )
  })

  test('a provider from another seed cannot sign the splice', async () => {
    const stranger = new ddk.Signers(ddk.ContractKeyProvider.fromMnemonic(MNEMONIC, undefined, 'regtest'))
    try {
      await ddk.finalizeSign(splice.offerB, splice.acceptB, splice.signB, stranger)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('Key')
    }
  })

  test('the spliced contract carries the reduced collateral', async () => {
    const payouts = ddk.contractInfoPayouts(buf(CONTRACT_INFO_60K_HEX))
    expect(payouts.totalCollateralSats).toBe(60_000n)
    // 40 000 of the prior contract's 100 000 was spliced out.
    expect(ddk.contractInfoPayouts(buf(CONTRACT_INFO_HEX)).totalCollateralSats - payouts.totalCollateralSats).toBe(
      40_000n,
    )
  })

  test('the spliced contract settles like any other', async () => {
    const cet = ddk.contractCetTransaction(splice.offerB, splice.acceptB, splice.signB, [
      { oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) },
    ])
    expect(cet.length).toBeGreaterThan(0)
    const refund = ddk.contractRefundTransaction(splice.offerB, splice.acceptB, splice.signB)
    expect(refund.length).toBeGreaterThan(0)
    expect(bytes(refund).equals(cet)).toBe(false)
  })
})

// External signing is proven end to end in Rust (external.rs), where a test
// signer can hold raw keys. Here: that its records cross the binding intact.
describe('external signing', () => {
  let flow: Awaited<ReturnType<typeof runFullFlow>>
  let acceptParams: ddk.AcceptOfferParams
  beforeAll(async () => {
    flow = await runFullFlow()
    acceptParams = {
      party: {
        fundingPubkey: flow.acceptorKeys.fundingPubkey(flow.offerTempId),
        fundingInputs: [],
        payoutSpk: buf(OFFERER_SPK_HEX),
        payoutSerialId: 4n,
        changeSpk: buf(OFFERER_SPK_HEX),
        changeSerialId: 5n,
      },
      minTimeoutInterval: 100,
      maxTimeoutInterval: 100_000,
      nowUnix: NOW_UNIX,
    }
  })

  test('prepareAcceptOffer names the key, the refund and one PSBT per CET', async () => {
    const request = ddk.prepareAcceptOffer(flow.offer, acceptParams).request
    expect(bytes(request.key.fundingPubkey).equals(acceptParams.party.fundingPubkey)).toBe(true)
    expect(bytes(request.key.temporaryContractId)).toEqual(flow.offerTempId)
    expect(bytes(request.key.contractId)).toEqual(bytes(ddk.computeContractId(flow.offer, flow.accept)))
    expect(request.refundPsbt.length).toBeGreaterThan(0)
    expect(request.cets.length).toBe(2)
    for (const cet of request.cets) {
      expect(cet.psbt.length).toBeGreaterThan(0)
      expect(cet.adaptorPoint.length).toBe(33)
    }
    expect(request.splice.dlcInputs).toEqual([])
  })

  test('prepareSignAccept is for the offering party', async () => {
    const request = ddk.prepareSignAccept(flow.offer, flow.accept).request
    expect(bytes(request.key.fundingPubkey).equals(flow.offererKeys.fundingPubkey(flow.offerTempId))).toBe(true)
  })

  test('a malformed signature is rejected before anything is built', async () => {
    try {
      ddk.completeAcceptOffer(ddk.prepareAcceptOffer(flow.offer, acceptParams).context, {
        refundSignature: Buffer.alloc(10),
        cetAdaptorSignatures: [],
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('Serialization')
    }
  })
})

describe('consumer contract signer provider', () => {
  test('a legacy BIP84 contract rolls into a DDK contract with added collateral', async () => {
    const master = ddk.createExtkeyFromSeed(ddk.convertMnemonicToSeed(MNEMONIC, undefined), 'regtest')
    const child = ddk.createExtkeyFromParentPath(master, "m/84'/1'/0'/0/7")
    const legacy = ddk.PrivateKeySigner.fromSecretKey(child.slice(46))
    const legacyPubkey = legacy.publicKey()
    const current = ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
    const requests: ddk.ContractKeyRequest[] = []
    let ecdsaCalls = 0
    let adaptorCalls = 0
    // Both provider and signer are ordinary JS implementations. The app owns
    // legacy detection and delegates new keys to the built-in provider.
    const provider: ddk.ContractSignerProvider = {
      getSigner(key) {
        requests.push(key)
        const signer = bytes(key.fundingPubkey).equals(bytes(legacyPubkey)) ? legacy : current.getSigner(key)
        return {
          signEcdsa(hash) {
            ecdsaCalls++
            return signer.signEcdsa(hash)
          },
          signAdaptor(hash, point) {
            adaptorCalls++
            return signer.signAdaptor(hash, point)
          },
        }
      },
    }
    const previous = await runFullFlow({ fundingPubkey: legacyPubkey, signers: provider })
    const previousId = ddk.computeContractId(previous.offer, previous.accept)
    const spliceInput = ddk.createDlcSpliceInput(
      previous.offer,
      previous.accept,
      previous.signResult.sign,
      ddk.Party.Offer,
      900n,
    )
    const extraInput = ddk.fundingInput(
      buf(PREV_TX_HEX.slice(0, -8) + '01000000'),
      0,
      50n,
      0xffffffff,
      108,
      new Uint8Array(),
    )
    const spk = buf(OFFERER_SPK_HEX)
    const contractInfo = buf(CONTRACT_INFO_HEX.replaceAll('00000000000186a0', '0000000000027100'))
    expect(ddk.contractInfoPayouts(contractInfo).totalCollateralSats).toBe(160_000n)
    const offer = ddk.createOffer({
      chainHash: ddk.chainHashFromNetwork('regtest'),
      temporaryContractId: tempId(0xb1),
      contractInfo,
      offerCollateralSats: 160_000n,
      party: {
        fundingPubkey: current.fundingPubkey(tempId(0xb1)),
        fundingInputs: [spliceInput, extraInput],
        payoutSpk: spk,
        payoutSerialId: 1n,
        changeSpk: spk,
        changeSerialId: 2n,
      },
      fundOutputSerialId: 3n,
      feeRatePerVb: 2n,
      cetLocktime: 750,
      refundLocktime: 1_000,
      contractFlags: 0,
    })
    const accepted = ddk.acceptOffer(
      offer,
      {
        party: {
          fundingPubkey: previous.acceptorKeys.fundingPubkey(tempId(0xb1)),
          fundingInputs: [],
          payoutSpk: spk,
          payoutSerialId: 4n,
          changeSpk: spk,
          changeSerialId: 5n,
        },
        minTimeoutInterval: 100,
        maxTimeoutInterval: 100_000,
        nowUnix: NOW_UNIX,
      },
      new ddk.Signers(previous.acceptorKeys),
    )
    const prepared = ddk.prepareSignAccept(offer, accepted.accept)
    expect(prepared.request.splice.dlcInputs.length).toBe(1)
    expect(prepared.request.splice.dlcInputs[0]!.inputIndex).toBe(1)
    expect(bytes(prepared.request.splice.dlcInputs[0]!.key.fundingPubkey)).toEqual(bytes(legacyPubkey))
    expect(bytes(prepared.request.splice.dlcInputs[0]!.key.contractId)).toEqual(bytes(previousId))
    const signed = await ddk.signAccept(
      offer,
      accepted.accept,
      new ddk.Signers(provider).withWallet(new ddk.DescriptorWallet(OFFERER_DESCRIPTOR)),
    )
    const transaction = await ddk.finalizeSign(offer, accepted.accept, signed.sign, new ddk.Signers(previous.acceptorKeys))
    expect(signed.transactions.fund.inputs.length).toBe(2)
    expect(transaction.length).toBeGreaterThan(signed.transactions.fund.rawBytes.length)
    expect(
      requests.some(
        (key) =>
          key.contractId &&
          bytes(key.contractId).equals(bytes(previousId)) &&
          bytes(key.fundingPubkey).equals(bytes(legacyPubkey)),
      ),
    ).toBe(true)
    expect(ecdsaCalls).toBe(3) // two refunds and the old contract's splice input
    expect(adaptorCalls).toBe(4) // two outcomes for each contract
    // Both the legacy contract and its successor settle from their messages.
    const oldCet = ddk.contractCetTransaction(previous.offer, previous.accept, previous.signResult.sign, [
      { oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) },
    ])
    const newCet = ddk.contractCetTransaction(offer, accepted.accept, signed.sign, [
      { oracleIndex: 0, attestation: buf(ATTESTATION_UP_HEX) },
    ])
    expect(bytes(oldCet)).not.toEqual(bytes(newCet))
  })

  test('callback exceptions and wrong-key signatures reject the operation', async () => {
    const flow = await runFullFlow()
    const wallet = new ddk.DescriptorWallet(OFFERER_DESCRIPTOR)
    await expect(
      ddk.signAccept(
        flow.offer,
        flow.accept,
        new ddk.Signers({
          getSigner() {
            throw new Error('wallet locked')
          },
        }).withWallet(wallet),
      ),
    ).rejects.toThrow()
    const wrong = ddk.PrivateKeySigner.fromSecretKey(new Uint8Array(32).fill(7))
    await expect(
      ddk.signAccept(
        flow.offer,
        flow.accept,
        new ddk.Signers({
          getSigner() {
            return wrong
          },
        }).withWallet(wallet),
      ),
    ).rejects.toThrow()
  })
})

describe('Signers', () => {
  test('a wallet implemented in JavaScript signs the funding inputs', async () => {
    const descriptorWallet = new ddk.DescriptorWallet(OFFERER_DESCRIPTOR)
    let calls = 0
    // The callback receives the funding PSBT once, at signAccept, and what it
    // returns is verified the same way as the built-in wallet's output.
    const wallet: ddk.FundingWallet = {
      signFundingPsbt(psbt) {
        calls++
        return descriptorWallet.signFundingPsbt(psbt)
      },
    }
    const flow = await runFullFlow({ wallet })
    expect(calls).toBe(1)
    // Wallet signatures are deterministic (RFC 6979) and the acceptor funds
    // nothing, so the funding transaction is byte-identical either way.
    expect(bytes(flow.fundingTx)).toEqual(bytes((await runFullFlow()).fundingTx))
  })

  test('a wallet that leaves an input unsigned is rejected', async () => {
    const flow = await runFullFlow()
    try {
      await ddk.signAccept(
        flow.offer,
        flow.accept,
        new ddk.Signers(flow.offererKeys).withWallet({ signFundingPsbt: (psbt) => psbt }),
      )
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('MissingFinalizedInput')
    }
  })

  test('a party with funding inputs needs a wallet; one without does not', async () => {
    const flow = await runFullFlow()
    try {
      await ddk.signAccept(flow.offer, flow.accept, new ddk.Signers(flow.offererKeys))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { tag?: string }).tag).toBe('Wallet')
    }
    // The acceptor contributes no inputs: finalizeSign never asks for a wallet.
    let calls = 0
    const neverAsked: ddk.FundingWallet = {
      signFundingPsbt(psbt) {
        calls++
        return psbt
      },
    }
    await ddk.finalizeSign(
      flow.offer,
      flow.accept,
      flow.signResult.sign,
      new ddk.Signers(flow.acceptorKeys).withWallet(neverAsked),
    )
    expect(calls).toBe(0)
  })

  test('DescriptorWallet rejects watch-only and non-wpkh descriptors', async () => {
    const pubkey = bytes(ddk.ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR).fundingPubkey(tempId(1))).toString('hex')
    for (const descriptor of [`wpkh(${pubkey})`, OFFERER_DESCRIPTOR.replace('wpkh(', 'tr(')]) {
      try {
        new ddk.DescriptorWallet(descriptor)
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as { tag?: string }).tag, descriptor).toBe('Descriptor')
      }
    }
  })
})
