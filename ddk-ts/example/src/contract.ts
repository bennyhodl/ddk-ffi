/**
 * Stateless contract API in Node — parity with @bennyblader/ddk-rn.
 *
 * Walks a complete two-party DLC end to end, with no oracle service and no
 * network: key derivation, offer, accept, funding-PSBT signing, the sign
 * message, the finalized funding transaction, and both settlement paths (the
 * CET an oracle attestation selects, and the refund). Run with `pnpm contract`.
 *
 * Nothing is persisted anywhere in here. Every transaction is rebuilt from the
 * three wire messages at the moment it is needed — which is the whole point of
 * the stateless API.
 */
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  fundingInput,
  createOffer,
  validateOffer,
  acceptOffer,
  validateAccept,
  createFundingPsbt,
  signFundingPsbtWithDescriptor,
  signAccept,
  validateSign,
  finalizeSign,
  signContractCet,
  signContractRefund,
  computeContractId,
  contractInfoPayouts,
} from '@bennyblader/ddk-ts'

// Fixtures, all DEMO ONLY. Regenerate the hex ones with
// `cargo test print_example_fixtures -- --ignored --nocapture` in ddk-ffi/.
//
// The offerer holds a private wpkh descriptor, which drives BOTH its wallet
// (signing the funding input) and, via fromDescriptor, its DLC contract keys.
// The acceptor only needs DLC keys — it contributes no inputs here.
const OFFERER_DESCRIPTOR =
  'wpkh(tprv8ZgxMBicQKsPdeeuBw7yrpnwFVYj1ehvmPPtkwwnRdSAyCre8qxoyWWuaWLsfNUXNraEoucZQJzLzdj3KNZFJd9Tdv7rm97ikN9yYxQLfMz/84h/1h/0h/0/*)'
const ACCEPTOR_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
// A two-outcome "up"/"down" enum contract with 100 000 sats total collateral,
// carrying the announcement of the oracle that attests below.
const CONTRACT_INFO_HEX =
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a5e7bcb1a4d0af5cd7bcc1b9aaabc2ee7463752c4db3d34d28817e27f459da722f4b1c649cec355f3f7bb5d7d3c67605f03ebc4b2b1d42c1aedaa7f186b3077fd944b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374'
// That oracle attesting to "up", which pays the offerer the whole 100 000.
const ATTESTATION_UP_HEX =
  '0c64646b2d6666692d7465737444b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a92500019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67e0b00db2f09efc08cda1554ae4f910a6fb5365c240e24d7be3514eed6825ce230001027570'
// A funding UTXO's transaction (200 000 sats to the descriptor's index-0
// P2WPKH) and that P2WPKH script.
const PREV_TX_HEX =
  '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff01400d0300000000001600143a4279e9c96f8305f3bc0566f9d8be101c189a8300000000'
const P2WPKH_SPK_HEX = '00143a4279e9c96f8305f3bc0566f9d8be101c189a83'
const FUNDING_SERIAL = 100n

// Byte values cross the binding as Uint8Array (strictByteArrays), so reach for
// Buffer only when a Buffer method is wanted. Wrapping is zero-copy.
const hex = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')

console.log('=== Stateless Contract API (Node) ===\n')

// 1) Derive DLC funding keys (secret keys stay in Rust and never cross the
//    boundary — only the public key comes back).
const offererKeys = ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR)
const acceptorKeys = ContractKeyProvider.fromMnemonic(ACCEPTOR_MNEMONIC, undefined, 'regtest')
const offerTempId = Buffer.alloc(32, 0x5c)
const acceptTempId = Buffer.alloc(32, 0xa1)
const spk = Buffer.from(P2WPKH_SPK_HEX, 'hex')
console.log(`Offerer funding pubkey: ${hex(offererKeys.fundingPubkey(offerTempId))}`)

// 2) Build and validate an offer (single-funded: offerer contributes all collateral).
const funding = fundingInput(Buffer.from(PREV_TX_HEX, 'hex'), 0, FUNDING_SERIAL, 0xffffffff, 108, Buffer.alloc(0))
const offer = createOffer({
  chainHash: chainHashFromNetwork('regtest'),
  temporaryContractId: offerTempId,
  contractInfo: Buffer.from(CONTRACT_INFO_HEX, 'hex'),
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
console.log(`✅ createOffer  -> OfferDlc (${offer.length} bytes)`)
validateOffer(offer, 100, 100_000)
console.log('✅ validateOffer passed')

// 3) Accept (acceptor contributes nothing) and validate it.
const acceptResult = acceptOffer(
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
console.log(`✅ acceptOffer  -> AcceptDlc (${acceptResult.accept.length} bytes)`)
validateAccept(offer, acceptResult.accept)
console.log('✅ validateAccept passed')

// 4) Fund. The PSBT is rebuilt from the two messages, the offerer signs its own
//    input with its descriptor, and the sign message carries its half of the
//    contract. The acceptor (no inputs here) finalizes.
const accept = acceptResult.accept
const fundingPsbt = createFundingPsbt(offer, accept)
const signedPsbt = signFundingPsbtWithDescriptor(offer, accept, fundingPsbt, OFFERER_DESCRIPTOR, [
  { inputSerialId: FUNDING_SERIAL, derivationIndex: 0 },
])
console.log(`✅ signFundingPsbtWithDescriptor -> signed PSBT (${signedPsbt.length} bytes)`)

const signResult = signAccept(offer, accept, offererKeys, offerTempId, signedPsbt)
console.log(`✅ signAccept   -> SignDlc (${signResult.sign.length} bytes)`)
validateSign(offer, accept, signResult.sign)
console.log('✅ validateSign passed')

const fundingTx = finalizeSign(offer, accept, signResult.sign, fundingPsbt)
console.log(`✅ finalizeSign -> signed funding transaction (${fundingTx.length} bytes)`)

// 5) Inspect: contract id + the payout table for display.
console.log(`\nContract id: ${hex(computeContractId(offer, accept))}`)
const payouts = contractInfoPayouts(Buffer.from(CONTRACT_INFO_HEX, 'hex'))
console.log(`Payout table (${payouts.isEnum ? 'enum' : 'numeric'}, total ${payouts.totalCollateralSats} sats):`)
for (const row of payouts.rows) {
  const label = row.outcome ?? `${row.rangeStart}-${row.rangeEnd}`
  console.log(`  ${label.padEnd(6)} offerer ${row.offerPayoutSats} / acceptor ${row.acceptPayoutSats}`)
}

// 6) Settle, both ways. Each party settles on its own — the counterparty's half
//    of the 2-of-2 was committed in the messages it already sent — so the
//    offerer takes the CET here and the acceptor the refund, purely to show
//    that either side can. Neither transaction is broadcast: CETs carry the
//    offer's cetLocktime and the refund its refundLocktime, and deciding which
//    path to take is the caller's policy.
console.log('')
const cet = signContractCet(offer, accept, signResult.sign, offererKeys, offerTempId, [
  { oracleIndex: 0, attestation: Buffer.from(ATTESTATION_UP_HEX, 'hex') },
])
console.log(`✅ signContractCet    -> CET for the attested "up" (${cet.length} bytes), signed by the offerer`)

const refund = signContractRefund(offer, accept, signResult.sign, acceptorKeys, acceptTempId)
console.log(`✅ signContractRefund -> refund transaction (${refund.length} bytes), signed by the acceptor`)

console.log('\n✅ Stateless contract API works in Node — offer to settlement.')
