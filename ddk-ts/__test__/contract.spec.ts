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
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a50e90df7ce7ebd675ee2aa81d38c1e040470e27a9f99fb1a1f923b601464d3002f902a28bd4b9de6373966266daf4fdda538fc968bc1fe92cfcc53c1010bcce2a44b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374'
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

  return { offererKeys, acceptorKeys, offer, acceptResult, accept, fundingPsbt, signResult, fundingTx }
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
})
