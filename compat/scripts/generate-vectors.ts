/**
 * Generates the compat vectors: a deterministic offline ddk replay whose every
 * wire message is cross-checked against @node-dlc (BAL's message codec) before
 * anything is written. Outputs:
 *
 *   - compat/vectors/compat-vectors.json          (this package's guard suite)
 *   - ddk-rn/example/src/compatVectors.ts         (replayed on-device by Maestro)
 *
 * Re-run (pnpm vectors) whenever the Rust core's byte output legitimately
 * changes; vectors.spec.ts failing is the signal.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as ddk from '@bennyblader/ddk-ts'

import { nodeDlc } from '../src/bal.js'
import { BAL_MNEMONIC, CET_LOCKTIME, DDK_MNEMONIC, FEE_RATE_PER_VB, MAX_TIMEOUT_INTERVAL, MIN_TIMEOUT_INTERVAL, REFUND_LOCKTIME, REPO_ROOT } from '../src/config.js'
import { DdkParty } from '../src/ddk.js'
import { fundVout, syntheticFundedInput, txidOf } from '../src/flow.js'
import {
  buildAccept,
  buildOffer,
  buildSpliceAccept,
  buildSpliceOffer,
  runDdkReplay,
  toHexString,
  type CompatVectors,
} from '../src/replay.js'
import { lygosLoanScenario, upDownScenario } from '../src/scenario.js'
import { buf, bytes, hex, referenceContractId, tempId, tlvBody } from '../src/util.js'

const offerer = new DdkParty(DDK_MNEMONIC)
const acceptor = new DdkParty(BAL_MNEMONIC)

const offererInput = syntheticFundedInput(offerer, 0, 2_000_000, 100n)
const acceptorInput = syntheticFundedInput(acceptor, 0, 2_000_000, 200n)

const scenario1 = lygosLoanScenario('compat-vectors-loan')
const scenario2 = upDownScenario('compat-vectors-splice', 600_000n)
const attestation1 = scenario1.oracle.attestEnum(scenario1.eventId, 'repaid')
const attestation2 = scenario2.oracle.attestEnum(scenario2.eventId, 'up')

const vectors: CompatVectors = {
  meta: {
    generatedBy: 'compat/scripts/generate-vectors.ts',
    ddkTsVersion: ddk.version(),
    nodeDlcVersion: '1.2.1',
    note: 'GENERATED — regenerate with `pnpm vectors` in compat/. Every message was round-tripped and validated against @node-dlc at generation time.',
  },
  offerer: {
    descriptor: offerer.descriptor,
    payoutSpkHex: offerer.scriptPubkey(1).toString('hex'),
    changeSpkHex: offerer.scriptPubkey(2).toString('hex'),
    fundingPrevTxHex: offererInput.prevTxHex,
    fundingVout: offererInput.vout,
    fundingSerialId: '100',
    derivationIndex: 0,
  },
  acceptor: {
    descriptor: acceptor.descriptor,
    payoutSpkHex: acceptor.scriptPubkey(1).toString('hex'),
    changeSpkHex: acceptor.scriptPubkey(2).toString('hex'),
    fundingPrevTxHex: acceptorInput.prevTxHex,
    fundingVout: acceptorInput.vout,
    fundingSerialId: '200',
    derivationIndex: 0,
  },
  contract: {
    contractInfoHex: scenario1.contractInfoBytes.toString('hex'),
    totalCollateralSats: scenario1.totalCollateral.toString(),
    offerCollateralSats: '600000',
    offerTempIdHex: tempId(0x5c).toString('hex'),
    acceptTempIdHex: tempId(0xa1).toString('hex'),
    feeRatePerVb: FEE_RATE_PER_VB.toString(),
    cetLocktime: CET_LOCKTIME,
    refundLocktime: REFUND_LOCKTIME,
    minTimeoutInterval: MIN_TIMEOUT_INTERVAL,
    maxTimeoutInterval: MAX_TIMEOUT_INTERVAL,
    contractFlags: 0,
    attestationHex: tlvBody(attestation1.serialize()).toString('hex'),
    attestedOutcome: 'repaid',
  },
  splice: {
    contractInfoHex: scenario2.contractInfoBytes.toString('hex'),
    totalCollateralSats: scenario2.totalCollateral.toString(),
    spliceSerialId: '7',
    offerTempIdHex: tempId(0xd1).toString('hex'),
    acceptTempIdHex: tempId(0xd2).toString('hex'),
    attestationHex: tlvBody(attestation2.serialize()).toString('hex'),
    attestedOutcome: 'up',
  },
  transcript: { offerHex: '', acceptHex: '', signHex: '', offer2Hex: '', accept2Hex: '', sign2Hex: '' },
  expected: {},
}

// --- generate the message transcript (adaptor signatures are randomized, so
// these bytes exist only in this file once committed) ---
{
  const offer = buildOffer(ddk, vectors)
  const { accept, fundingPsbt } = buildAccept(ddk, vectors, offer)
  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(offerer.descriptor)
  const signedPsbt = ddk.signFundingPsbtWithDescriptor(offer, accept, fundingPsbt, offerer.descriptor, [
    { inputSerialId: 100n, derivationIndex: 0 },
  ])
  const sign = ddk.signAccept(offer, accept, offererKeys, tempId(0x5c), signedPsbt).sign

  const { offer2 } = buildSpliceOffer(ddk, vectors, offer, accept)
  const { accept2, fundingPsbt2 } = buildSpliceAccept(ddk, vectors, offer2)
  const sign2 = ddk.signAcceptSpliced(offer2, accept2, offererKeys, tempId(0xd1), fundingPsbt2, [
    { inputSerialId: 7n, priorTemporaryContractId: tempId(0x5c) },
  ]).sign

  vectors.transcript = {
    offerHex: toHexString(offer),
    acceptHex: toHexString(accept),
    signHex: toHexString(sign),
    offer2Hex: toHexString(offer2),
    accept2Hex: toHexString(accept2),
    sign2Hex: toHexString(sign2),
  }
}

// Derive the expected artifacts, then re-run to prove they are deterministic.
vectors.expected = runDdkReplay(ddk, vectors)
{
  const second = runDdkReplay(ddk, vectors)
  for (const [key, value] of Object.entries(vectors.expected)) {
    if (second[key] !== value) {
      throw new Error(`expected artifact ${key} is not deterministic across replays`)
    }
  }
}

// --- cross-check every wire artifact against @node-dlc before writing ---
function assertEqual(label: string, a: string, b: string) {
  if (a !== b) throw new Error(`${label} mismatch:\n  ${a}\n  ${b}`)
}

for (const [message, cls, validate] of [
  ['offerHex', nodeDlc.DlcOffer, true],
  ['acceptHex', nodeDlc.DlcAccept, true],
  ['signHex', nodeDlc.DlcSign, false],
  ['offer2Hex', nodeDlc.DlcOffer, true],
  ['accept2Hex', nodeDlc.DlcAccept, true],
  ['sign2Hex', nodeDlc.DlcSign, false],
] as const) {
  const committed = vectors.transcript[message]
  const parsed = cls.deserialize(buf(committed))
  if (validate) parsed.validate()
  assertEqual(`${message} node-dlc round-trip`, parsed.serialize().toString('hex'), committed)
}
assertEqual('replayed offer vs transcript', vectors.expected.offerHex!, vectors.transcript.offerHex)
assertEqual('replayed offer2 vs transcript', vectors.expected.offer2Hex!, vectors.transcript.offer2Hex)
assertEqual('replayed psbt vs fresh accept psbt', vectors.expected.fundingPsbtHex!, vectors.expected.freshAcceptPsbtHex!)

const announcement1 = (scenario1.contractInfo as any).oracleInfo.announcement
attestation1.validate(announcement1)
const announcement2 = (scenario2.contractInfo as any).oracleInfo.announcement
attestation2.validate(announcement2)

{
  // Contract id agrees with the reference XOR derivation.
  const transactions = ddk.dlcTransactionsFromMessages(buf(vectors.transcript.offerHex), buf(vectors.transcript.acceptHex))
  const reference = referenceContractId(
    buf(txidOf(transactions.fund.rawBytes)),
    fundVout(transactions.fund.rawBytes, transactions.fundingWitnessScript),
    buf(vectors.contract.offerTempIdHex),
  ).toString('hex')
  assertEqual('contractIdHex reference', vectors.expected.contractIdHex!, reference)
  // The DlcSign carries the same id.
  const parsedSign = nodeDlc.DlcSign.deserialize(buf(vectors.transcript.signHex))
  assertEqual('DlcSign.contractId', parsedSign.contractId.toString('hex'), vectors.expected.contractIdHex!)
}

// --- write outputs ---
const vectorsDir = resolve(REPO_ROOT, 'compat', 'vectors')
mkdirSync(vectorsDir, { recursive: true })
const json = JSON.stringify(vectors, null, 2)
writeFileSync(resolve(vectorsDir, 'compat-vectors.json'), json + '\n')

const rnModule = `/**
 * GENERATED by compat/scripts/generate-vectors.ts — do not edit by hand.
 * Regenerate with \`pnpm vectors\` in compat/ after a Rust core change.
 *
 * A deterministic DLC transcript (dual-funded contract + splice successor)
 * whose every message was validated against @node-dlc ${vectors.meta.nodeDlcVersion} (the BAL message
 * codec) at generation time with @bennyblader/ddk-ts ${vectors.meta.ddkTsVersion}. CompatFlow.ts
 * replays it through the ddk-rn bindings and byte-compares each artifact.
 */
export default ${json} as const;
`
writeFileSync(resolve(REPO_ROOT, 'ddk-rn', 'example', 'src', 'compatVectors.ts'), rnModule)

// The replay itself is dependency-free and parameterized by the ddk module,
// so the on-device flow runs the exact same code: copy it verbatim.
const replaySource = readFileSync(resolve(REPO_ROOT, 'compat', 'src', 'replay.ts'), 'utf8')
writeFileSync(
  resolve(REPO_ROOT, 'ddk-rn', 'example', 'src', 'compatReplay.ts'),
  `// GENERATED — verbatim copy of compat/src/replay.ts, written by\n// compat/scripts/generate-vectors.ts (\`pnpm vectors\`). Do not edit here.\n${replaySource}`,
)

console.log(`vectors written (${Object.keys(vectors.expected).length} expected artifacts)`)
console.log(`  ddk-ts ${vectors.meta.ddkTsVersion}, node-dlc ${vectors.meta.nodeDlcVersion}`)
console.log(`  ${resolve(vectorsDir, 'compat-vectors.json')}`)
console.log(`  ${resolve(REPO_ROOT, 'ddk-rn', 'example', 'src', 'compatVectors.ts')}`)
