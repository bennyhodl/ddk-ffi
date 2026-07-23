/**
 * Stateless contract API in Node — parity with @bennyblader/ddk-rn.
 *
 * A backend typically derives keys and validates / inspects stored messages
 * (on-device signing lives in the mobile app), so this demo covers key
 * derivation, offer creation + validation, accept + validation, the contract
 * id, and the payout table. Run with `pnpm contract`.
 */
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  fundingInput,
  createOffer,
  validateOffer,
  acceptOffer,
  validateAccept,
  computeContractId,
  contractInfoPayouts,
} from '@bennyblader/ddk-ts'

// Two BIP39 test-vector mnemonics (DEMO ONLY) and a sample oracle ContractInfo
// (a two-outcome "up"/"down" enum with 100 000 sats total collateral).
const OFFERER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ACCEPTOR_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const CONTRACT_INFO_HEX =
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a50e90df7ce7ebd675ee2aa81d38c1e040470e27a9f99fb1a1f923b601464d3002f902a28bd4b9de6373966266daf4fdda538fc968bc1fe92cfcc53c1010bcce2a44b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374'
// A funding UTXO's transaction (200 000 sats to a P2WPKH) and that P2WPKH script.
const PREV_TX_HEX =
  '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff01400d0300000000001600140c88317ba0fe36a770ba73cd050334c7f37092b900000000'
const P2WPKH_SPK_HEX = '00140c88317ba0fe36a770ba73cd050334c7f37092b9'

console.log('=== Stateless Contract API (Node) ===\n')

// 1) Derive DLC funding keys from mnemonics (secret keys stay in Rust).
const offererKeys = ContractKeyProvider.fromMnemonic(OFFERER_MNEMONIC, undefined, 'regtest')
const acceptorKeys = ContractKeyProvider.fromMnemonic(ACCEPTOR_MNEMONIC, undefined, 'regtest')
const offerTempId = Buffer.alloc(32, 0x5c)
const acceptTempId = Buffer.alloc(32, 0xa1)
const spk = Buffer.from(P2WPKH_SPK_HEX, 'hex')
console.log(`Offerer funding pubkey: ${offererKeys.fundingPubkey(offerTempId).toString('hex')}`)

// 2) Build and validate an offer (single-funded: offerer contributes all collateral).
const funding = fundingInput(Buffer.from(PREV_TX_HEX, 'hex'), 0, 100n, 0xffffffff, 108, Buffer.alloc(0))
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

// 4) Inspect: contract id + the payout table for display.
console.log(`\nContract id: ${computeContractId(offer, acceptResult.accept).toString('hex')}`)
const payouts = contractInfoPayouts(Buffer.from(CONTRACT_INFO_HEX, 'hex'))
console.log(`Payout table (${payouts.isEnum ? 'enum' : 'numeric'}, total ${payouts.totalCollateralSats} sats):`)
for (const row of payouts.rows) {
  const label = row.outcome ?? `${row.rangeStart}-${row.rangeEnd}`
  console.log(`  ${label.padEnd(6)} offerer ${row.offerPayoutSats} / acceptor ${row.acceptPayoutSats}`)
}
console.log('\n✅ Stateless contract API works in Node.')
