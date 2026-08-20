import { createBalParty, getBalInput, nodeDlc, type BalParty } from './bal.js'
import { MAX_TIMEOUT_INTERVAL, MIN_TIMEOUT_INTERVAL } from './config.js'
import { ddk, DdkParty, type DdkFundedInput } from './ddk.js'
import { fundVout, makeDdkOffer, txidOf } from './flow.js'
import type { BitcoindRpc } from './rpc.js'
import type { EnumScenario } from './scenario.js'
import { bytes, hex, tempId } from './util.js'

export interface CrossContract {
  scenario: EnumScenario
  /** Wire bytes — the actual protocol transcript. */
  offer: Uint8Array
  accept: Uint8Array
  sign: Uint8Array
  /** node-dlc message objects on the BAL side of the wire. */
  balOffer: any
  balAccept: any
  balSign: any
  balTransactions: any
  /** ddk's independently rebuilt transaction set. */
  ddkTransactions: ReturnType<typeof ddk.dlcTransactionsFromMessages>
  fundTxId: string
  /** The ddk party and the temp id that derives its keys in this contract. */
  ddkParty: DdkParty
  ddkTempId: Buffer
  ddkIsOfferer: boolean
}

/** Asserts BAL's and ddk's transaction sets are byte-identical. */
function crossCheckTransactions(balTransactions: any, ddkTransactions: CrossContract['ddkTransactions']): void {
  const balFund = balTransactions.fundTx.serialize().toString('hex')
  const balRefund = balTransactions.refundTx.serialize().toString('hex')
  if (balFund !== hex(ddkTransactions.fund.rawBytes)) {
    throw new Error(`fund tx mismatch:\n BAL ${balFund}\n ddk ${hex(ddkTransactions.fund.rawBytes)}`)
  }
  if (balRefund !== hex(ddkTransactions.refund.rawBytes)) {
    throw new Error(`refund tx mismatch:\n BAL ${balRefund}\n ddk ${hex(ddkTransactions.refund.rawBytes)}`)
  }
  if (balTransactions.cets.length !== ddkTransactions.cets.length) {
    throw new Error(`CET count mismatch: BAL ${balTransactions.cets.length} vs ddk ${ddkTransactions.cets.length}`)
  }
  balTransactions.cets.forEach((cet: any, i: number) => {
    if (cet.serialize().toString('hex') !== hex(ddkTransactions.cets[i]!.rawBytes)) {
      throw new Error(`CET ${i} mismatch`)
    }
  })
  const ddkVout = fundVout(ddkTransactions.fund.rawBytes, ddkTransactions.fundingWitnessScript)
  if (balTransactions.fundTxVout !== ddkVout) {
    throw new Error(`fund vout mismatch: BAL ${balTransactions.fundTxVout} vs ddk ${ddkVout}`)
  }
}

let contractCounter = 0

let balAcceptTempIdBug = false
/** True once any BAL acceptDlcOffer produced a non-spec temporaryContractId. */
export function balAcceptTempIdBugPresent(): boolean {
  return balAcceptTempIdBug
}

let spliceWitnessShimApplied = false
/** True once shimSpliceSignForBal had to rewrite a DLC-input witness. */
export function spliceWitnessShimNeeded(): boolean {
  return spliceWitnessShimApplied
}

/**
 * KNOWN DIVERGENCE (splice funding signatures): for a DLC (splice) input, ddk
 * puts a single-element witness [signature] in the sign message's funding
 * signatures, while BAL's finalizeDlcSign indexes witnessElement[1] expecting
 * [signature, publicKey] and crashes on ddk's form (published
 * @atomicfinance/bitcoin-ddk-provider@4.3.6, dist/BitcoinDdkProvider.js:1029). ddk itself only reads the
 * first element, so the two-element form is accepted by both. This shim
 * appends the DLC input's localFundPubkey (the key the splice offerer signed
 * with) so BAL can finalize. Nothing signs over the sign message, so the
 * rewrite invalidates nothing. Drop it when BAL derives the pubkey from the
 * DlcInput instead (spliceWitnessShimNeeded() pins the divergence).
 * Upstream: AtomicFinance/bitcoin-abstraction-layer#216. Tracked here by #27.
 */
export function shimSpliceSignForBal(sign: Uint8Array, balOffer: any): Uint8Array {
  const balSign = nodeDlc.DlcSign.deserialize(bytes(sign))
  let changed = false
  balOffer.fundingInputs.forEach((input: any, i: number) => {
    if (!input.dlcInput) return
    const elements = balSign.fundingSignatures.witnessElements[i]
    if (elements && elements.length === 1) {
      const pubkeyElement = new nodeDlc.ScriptWitnessV0()
      pubkeyElement.witness = input.dlcInput.localFundPubkey
      pubkeyElement.length = pubkeyElement.witness.length
      elements.push(pubkeyElement)
      changed = true
    }
  })
  if (changed) spliceWitnessShimApplied = true
  return changed ? balSign.serialize() : sign
}

/**
 * Enter a contract with ddk as the offerer and BAL as the accepter, broadcast
 * the funding transaction, and confirm it. Set `singleFunded` for the lygos
 * backend pattern (offer collateral = total collateral, accepter adds no
 * inputs).
 */
export async function enterDdkOfferBalAccept(
  rpc: BitcoindRpc,
  ddkParty: DdkParty,
  balParty: BalParty,
  scenario: EnumScenario,
  opts: { offerCollateralSats: bigint; singleFunded?: boolean },
): Promise<CrossContract> {
  const ddkTempId = tempId(0x50 + contractCounter++)
  const ddkInput = await ddkParty.fundInput(rpc, 100n)

  const offer = makeDdkOffer({
    scenario,
    offerer: ddkParty,
    temporaryContractId: ddkTempId,
    offerCollateralSats: opts.offerCollateralSats,
    fundingInputs: [ddkInput.fundingInput],
    payoutSpk: ddkParty.scriptPubkey(1),
    changeSpk: ddkParty.scriptPubkey(2),
    payoutSerialId: 1n,
    changeSerialId: 2n,
    fundOutputSerialId: 3n,
  })

  // --- over the wire to BAL ---
  const balOffer = nodeDlc.DlcOffer.deserialize(bytes(offer))
  balOffer.validate()
  const balInputs = opts.singleFunded ? undefined : [await getBalInput(rpc, balParty)]
  const acceptResponse = await balParty.dlc.acceptDlcOffer(balOffer, balInputs)
  const balAccept = acceptResponse.dlcAccept
  const balTransactions = acceptResponse.dlcTransactions

  // KNOWN BAL BUG (BitcoinDdkProvider.acceptDlcOffer — in the published
  // @atomicfinance/bitcoin-ddk-provider@4.3.6, dist/BitcoinDdkProvider.js:1968):
  // it sets accept.temporaryContractId = sha256(offer.serialize()) instead of
  // echoing the offer's temporary contract id as the DLC spec requires. BAL
  // never notices (it derives everything from the offer side), but any
  // spec-conforming counterparty — ddk included — rejects the accept. The
  // orange-grove backend's hand-built accepts copy the id correctly, so
  // production traffic is unaffected. Patch it here so the rest of the flow
  // can be exercised; balAcceptTempIdBugPresent() lets a test pin the bug so
  // we notice when BAL fixes it and this patch can be dropped. Nothing signs
  // over this field, so patching does not invalidate any signature.
  // Upstream: AtomicFinance/bitcoin-abstraction-layer#215. Tracked here by #26.
  if (!balAccept.temporaryContractId.equals(balOffer.temporaryContractId)) {
    balAcceptTempIdBug = true
    balAccept.temporaryContractId = balOffer.temporaryContractId
  }
  const accept: Uint8Array = balAccept.serialize()

  // --- back to ddk ---
  ddk.validateAccept(offer, accept)
  const fundingPsbt = ddk.createFundingPsbt(offer, accept)
  const signedPsbt = ddkParty.signFundingPsbt(offer, accept, fundingPsbt, [ddkInput])
  const signResult = ddk.signAccept(offer, accept, ddkParty.keys, ddkTempId, signedPsbt)
  const sign = signResult.sign

  // --- BAL finalizes and the funding tx is broadcast ---
  const balSign = nodeDlc.DlcSign.deserialize(bytes(sign))
  const fundTx = await balParty.dlc.finalizeDlcSign(balOffer, balAccept, balSign, balTransactions)
  const fundTxId = await rpc.broadcastAndConfirm(fundTx.serialize().toString('hex'))

  const ddkTransactions = ddk.dlcTransactionsFromMessages(offer, accept)
  crossCheckTransactions(balTransactions, ddkTransactions)
  if (fundTxId !== txidOf(ddkTransactions.fund.rawBytes)) {
    throw new Error('broadcast fund txid differs from ddk fund txid')
  }

  return {
    scenario,
    offer,
    accept,
    sign,
    balOffer,
    balAccept,
    balSign,
    balTransactions,
    ddkTransactions,
    fundTxId,
    ddkParty,
    ddkTempId,
    ddkIsOfferer: true,
  }
}

/**
 * Enter a contract with BAL as the offerer and ddk as the accepter, broadcast
 * the funding transaction, and confirm it.
 */
export async function enterBalOfferDdkAccept(
  rpc: BitcoindRpc,
  balParty: BalParty,
  ddkParty: DdkParty,
  scenario: EnumScenario,
  opts: { offerCollateralSats: bigint },
): Promise<CrossContract> {
  const balInput = await getBalInput(rpc, balParty)
  const balOffer = await balParty.dlc.createDlcOffer(
    scenario.contractInfo,
    opts.offerCollateralSats,
    scenario.feeRatePerVb,
    scenario.cetLocktime,
    scenario.refundLocktime,
    [balInput],
  )
  const offer: Uint8Array = balOffer.serialize()

  // --- over the wire to ddk ---
  ddk.validateOffer(offer, MIN_TIMEOUT_INTERVAL, MAX_TIMEOUT_INTERVAL)
  const ddkTempId = tempId(0xa0 + contractCounter++)
  const ddkInput = await ddkParty.fundInput(rpc, 4_000n)
  const acceptResult = ddk.acceptOffer(
    offer,
    {
      party: {
        fundingPubkey: ddkParty.keys.fundingPubkey(ddkTempId),
        fundingInputs: [ddkInput.fundingInput],
        payoutSpk: ddkParty.scriptPubkey(1),
        payoutSerialId: 4_001n,
        changeSpk: ddkParty.scriptPubkey(2),
        changeSerialId: 4_002n,
      },
      minTimeoutInterval: MIN_TIMEOUT_INTERVAL,
      maxTimeoutInterval: MAX_TIMEOUT_INTERVAL,
    },
    ddkParty.keys,
    ddkTempId,
  )
  const accept = acceptResult.accept

  // --- BAL signs ---
  const balAccept = nodeDlc.DlcAccept.deserialize(bytes(accept))
  balAccept.validate()
  const signResponse = await balParty.dlc.signDlcAccept(balOffer, balAccept)
  const balSign = signResponse.dlcSign
  const balTransactions = signResponse.dlcTransactions
  const sign: Uint8Array = balSign.serialize()

  // --- ddk finalizes and broadcasts ---
  ddk.validateSign(offer, accept, sign)
  const acceptorSignedPsbt = ddkParty.signFundingPsbt(offer, accept, acceptResult.fundingPsbt, [ddkInput])
  const fundingTx = ddk.finalizeSign(offer, accept, sign, acceptorSignedPsbt)
  const fundTxId = await rpc.broadcastAndConfirm(hex(fundingTx))

  const ddkTransactions = ddk.dlcTransactionsFromMessages(offer, accept)
  crossCheckTransactions(balTransactions, ddkTransactions)

  return {
    scenario,
    offer,
    accept,
    sign,
    balOffer,
    balAccept,
    balSign,
    balTransactions,
    ddkTransactions,
    fundTxId,
    ddkParty,
    ddkTempId,
    ddkIsOfferer: false,
  }
}

/** BAL executes the CET for an attestation (over freshly deserialized messages). */
export async function balExecuteCet(
  rpc: BitcoindRpc,
  balParty: BalParty,
  contract: CrossContract,
  attestation: any,
): Promise<string> {
  const cet = await balParty.dlc.execute(
    nodeDlc.DlcOffer.deserialize(bytes(contract.offer)),
    nodeDlc.DlcAccept.deserialize(bytes(contract.accept)),
    nodeDlc.DlcSign.deserialize(bytes(contract.sign)),
    nodeDlc.DlcTransactions.deserialize(contract.balTransactions.serialize()),
    attestation,
    !contract.ddkIsOfferer, // BAL is the offerer when ddk is not
  )
  return rpc.broadcastAndConfirm(cet.serialize().toString('hex'))
}

/** The ddk party settles the CET from the wire transcript alone. */
export async function ddkSettleCet(
  rpc: BitcoindRpc,
  contract: CrossContract,
  attestationBody: Buffer,
): Promise<string> {
  const cet = ddk.signContractCet(
    contract.offer,
    contract.accept,
    contract.sign,
    contract.ddkParty.keys,
    contract.ddkTempId,
    [{ oracleIndex: 0, attestation: attestationBody }],
  )
  return rpc.broadcastAndConfirm(hex(cet))
}

/** BAL broadcasts the refund transaction. */
export async function balRefund(rpc: BitcoindRpc, balParty: BalParty, contract: CrossContract): Promise<string> {
  const refund = await balParty.dlc.refund(
    nodeDlc.DlcOffer.deserialize(bytes(contract.offer)),
    nodeDlc.DlcAccept.deserialize(bytes(contract.accept)),
    nodeDlc.DlcSign.deserialize(bytes(contract.sign)),
    nodeDlc.DlcTransactions.deserialize(contract.balTransactions.serialize()),
  )
  return rpc.broadcastAndConfirm(refund.serialize().toString('hex'))
}

/** The ddk party signs and broadcasts the refund transaction. */
export async function ddkRefund(rpc: BitcoindRpc, contract: CrossContract): Promise<string> {
  const refund = ddk.signContractRefund(
    contract.offer,
    contract.accept,
    contract.sign,
    contract.ddkParty.keys,
    contract.ddkTempId,
  )
  return rpc.broadcastAndConfirm(hex(refund))
}

export { createBalParty }
