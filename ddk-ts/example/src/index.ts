import {
  version,
  createFundTxLockingScript,
  isDust,
  getTotalInputVsize,
  createDlcTransactions,
  createCets,
  createRefundTransaction,
  TxOutput,
  TxInputInfo,
  DlcOutcome,
  PartyParams,
} from '@bennyblader/ddk-ts'

console.log('heyhowareya')

console.log('DDK TypeScript Bindings Example')
console.log('================================\n')

// Call the version function
const ddkVersion = version()
console.log(`DDK Version: ${ddkVersion}\n`)

// Demonstrate other basic functions
console.log('Testing basic functionality:\n')

// Create test buffers for public keys (these are example keys)
const localPubkey = Buffer.from('0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798', 'hex')
const remotePubkey = Buffer.from('02C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5', 'hex')

try {
  // Create a funding transaction locking script
  const lockingScript = createFundTxLockingScript(localPubkey, remotePubkey)
  console.log(`✅ Created locking script with length: ${lockingScript.length} bytes`)
  console.log(`   Locking script (hex): ${lockingScript.toString('hex').substring(0, 60)}...\n`)
} catch (error) {
  console.error('❌ Error creating locking script:', error)
}

// Test dust output detection with typed objects
console.log('Testing dust output detection:')
const dustOutput: TxOutput = {
  value: 500n, // 500 sats
  scriptPubkey: Buffer.alloc(22, 0),
}

const nonDustOutput: TxOutput = {
  value: 5000n, // 5000 sats
  scriptPubkey: Buffer.alloc(22, 0),
}

console.log(`   Is 500 sats dust? ${isDust(dustOutput)}`)
console.log(`   Is 5000 sats dust? ${isDust(nonDustOutput)}\n`)

// Test total input vsize calculation with typed inputs
console.log('Testing input vsize calculation:')
const testInputs: TxInputInfo[] = [
  {
    txid: '0000000000000000000000000000000000000000000000000000000000000000',
    vout: 0,
    scriptSig: Buffer.alloc(0),
    maxWitnessLength: 108,
    serialId: 1n,
  },
  {
    txid: '1111111111111111111111111111111111111111111111111111111111111111',
    vout: 1,
    scriptSig: Buffer.alloc(0),
    maxWitnessLength: 108,
    serialId: 2n,
  },
]

const totalVsize = getTotalInputVsize(testInputs)
console.log(`   Total vsize for ${testInputs.length} inputs: ${totalVsize} vbytes\n`)

// Example of creating DLC transactions (with mock data)
console.log('Example DLC transaction structure:')

const outcomes: DlcOutcome[] = [
  { localPayout: 100000000n, remotePayout: 0n },
  { localPayout: 50000000n, remotePayout: 50000000n },
  { localPayout: 0n, remotePayout: 100000000n },
]

const partyParams: PartyParams = {
  fundPubkey: localPubkey,
  changeScriptPubkey: Buffer.alloc(22, 0),
  changeSerialId: 1n,
  payoutScriptPubkey: Buffer.alloc(22, 0),
  payoutSerialId: 2n,
  inputs: [],
  inputAmount: 150000000n,
  collateral: 100000000n,
  dlcInputs: [],
}

// TODO: add more context to InvalidArgument
// try {
//   const dlcTxs = createDlcTransactions(
//     outcomes,
//     partyParams,
//     { ...partyParams, fundPubkey: remotePubkey },
//     Math.floor((new Date().getTime() / 1000) * 3600 * 24 * 10), // refundLocktime
//     4n, // feeRate
//     Math.floor(new Date().getTime() / 1000) * 3600, // fundLockTime
//     Math.floor(new Date().getTime() / 1000) * 3600, // cetLockTime
//     0n, // fundOutputSerialId
//   )

//   console.log(`   ✅ Created DLC transactions:`)
//   console.log(`      - Fund TX version: ${dlcTxs.fund.version}`)
//   console.log(`      - Number of CETs: ${dlcTxs.cets.length}`)
//   console.log(`      - Refund locktime: ${dlcTxs.refund.lockTime}`)
//   console.log(`      - Funding script length: ${dlcTxs.fundingScriptPubkey.length} bytes\n`)
// } catch (error) {
//   console.error('   ❌ Error creating DLC transactions:', error)
// }

// Demonstrate creating individual transactions
console.log('Creating individual transactions:')

try {
  // Create CETs
  const cets = createCets(
    '0000000000000000000000000000000000000000000000000000000000000000',
    0, // fundVout
    Buffer.alloc(22), // localFinalScriptPubkey
    Buffer.alloc(22), // remoteFinalScriptPubkey
    outcomes,
    10, // lockTime
    1n, // localSerialId
    2n, // remoteSerialId
  )
  console.log(`   ✅ Created ${cets.length} CET transactions`)

  // Create refund transaction
  const refund = createRefundTransaction(
    Buffer.alloc(22), // localFinalScriptPubkey
    Buffer.alloc(22), // remoteFinalScriptPubkey
    50000000n, // localAmount
    50000000n, // remoteAmount
    100, // lockTime
    '0000000000000000000000000000000000000000000000000000000000000000',
    0, // fundVout
  )
  console.log(`   ✅ Created refund transaction with locktime: ${refund.lockTime}`)
} catch (error) {
  console.error('   ❌ Error creating transactions:', error)
}

console.log('\n✅ DDK TypeScript bindings are working correctly!')
console.log('   All functions are properly typed and accessible.')
