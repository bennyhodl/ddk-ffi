/**
 * The deterministic ddk replay behind the compat vectors.
 *
 * Dependency-free on purpose: it takes the ddk module as a parameter, so the
 * exact same sequence runs against @bennyblader/ddk-ts (vector generation and
 * the vectors.spec guard in this package) and against @bennyblader/ddk-rn on
 * a device (ddk-rn/example/src/CompatFlow.ts mirrors runDdkReplay — keep the
 * two in sync).
 *
 * CET adaptor signatures are randomized (secp256k1-zkp), so accept/sign
 * messages are NOT byte-reproducible. The vectors therefore commit the whole
 * message transcript as an INPUT, and `expected` holds only what derives
 * deterministically from it: the funding PSBT, the signed funding txs, the
 * contract ids, the CET/refund settlements, and the splice funding input.
 * The replay additionally regenerates a fresh accept/sign to prove the
 * current build still produces valid messages (validated, and structurally
 * pinned by comparing the fresh accept's funding PSBT to the committed one).
 *
 * The flow: a dual-funded two-party contract (offer → accept → sign →
 * funding tx → CET + refund), then a splice of its 2-of-2 into a
 * single-funded successor contract, settled again.
 */

export interface CompatPartyVectors {
  descriptor: string
  payoutSpkHex: string
  changeSpkHex: string
  fundingPrevTxHex: string
  fundingVout: number
  fundingSerialId: string
  derivationIndex: number
}

export interface CompatVectors {
  meta: {
    generatedBy: string
    ddkTsVersion: string
    nodeDlcVersion: string
    note: string
  }
  offerer: CompatPartyVectors
  acceptor: CompatPartyVectors
  contract: {
    contractInfoHex: string
    totalCollateralSats: string
    offerCollateralSats: string
    offerTempIdHex: string
    acceptTempIdHex: string
    feeRatePerVb: string
    cetLocktime: number
    refundLocktime: number
    minTimeoutInterval: number
    maxTimeoutInterval: number
    contractFlags: number
    attestationHex: string
    attestedOutcome: string
  }
  splice: {
    contractInfoHex: string
    totalCollateralSats: string
    spliceSerialId: string
    offerTempIdHex: string
    acceptTempIdHex: string
    attestationHex: string
    attestedOutcome: string
  }
  /** The committed wire messages (adaptor signatures are randomized, so these
   * are inputs to the replay, not outputs of it). */
  transcript: {
    offerHex: string
    acceptHex: string
    signHex: string
    offer2Hex: string
    accept2Hex: string
    sign2Hex: string
  }
  /** Deterministic derivations from the transcript. */
  expected: Record<string, string>
}

export const toHexString = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

export const fromHexString = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function offererFundingInput(ddk: any, vectors: CompatVectors): Uint8Array {
  return ddk.fundingInput(
    fromHexString(vectors.offerer.fundingPrevTxHex),
    vectors.offerer.fundingVout,
    BigInt(vectors.offerer.fundingSerialId),
    0xffffffff,
    108,
    new Uint8Array(0),
  )
}

/** Builds contract 1's offer — fully deterministic. */
export function buildOffer(ddk: any, vectors: CompatVectors): Uint8Array {
  const { offerer, contract } = vectors
  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(offerer.descriptor)
  const offerTempId = fromHexString(contract.offerTempIdHex)
  return ddk.createOffer({
    chainHash: ddk.chainHashFromNetwork('regtest'),
    temporaryContractId: offerTempId,
    contractInfo: fromHexString(contract.contractInfoHex),
    offerCollateralSats: BigInt(contract.offerCollateralSats),
    party: {
      fundingPubkey: offererKeys.fundingPubkey(offerTempId),
      fundingInputs: [offererFundingInput(ddk, vectors)],
      payoutSpk: fromHexString(offerer.payoutSpkHex),
      payoutSerialId: 1n,
      changeSpk: fromHexString(offerer.changeSpkHex),
      changeSerialId: 2n,
    },
    fundOutputSerialId: 3n,
    feeRatePerVb: BigInt(contract.feeRatePerVb),
    cetLocktime: contract.cetLocktime,
    refundLocktime: contract.refundLocktime,
    contractFlags: contract.contractFlags,
  })
}

/** Accepts contract 1's offer (fresh adaptor signatures — not reproducible). */
export function buildAccept(ddk: any, vectors: CompatVectors, offer: Uint8Array): { accept: Uint8Array; fundingPsbt: Uint8Array } {
  const { acceptor, contract } = vectors
  const acceptorKeys = ddk.ContractKeyProvider.fromDescriptor(acceptor.descriptor)
  const acceptTempId = fromHexString(contract.acceptTempIdHex)
  const acceptorInput = ddk.fundingInput(
    fromHexString(acceptor.fundingPrevTxHex),
    acceptor.fundingVout,
    BigInt(acceptor.fundingSerialId),
    0xffffffff,
    108,
    new Uint8Array(0),
  )
  const result = ddk.acceptOffer(
    offer,
    {
      party: {
        fundingPubkey: acceptorKeys.fundingPubkey(acceptTempId),
        fundingInputs: [acceptorInput],
        payoutSpk: fromHexString(acceptor.payoutSpkHex),
        payoutSerialId: 4n,
        changeSpk: fromHexString(acceptor.changeSpkHex),
        changeSerialId: 5n,
      },
      minTimeoutInterval: contract.minTimeoutInterval,
      maxTimeoutInterval: contract.maxTimeoutInterval,
    },
    acceptorKeys,
    acceptTempId,
  )
  return { accept: result.accept, fundingPsbt: result.fundingPsbt }
}

/** Builds contract 2's (splice successor) offer — fully deterministic. */
export function buildSpliceOffer(ddk: any, vectors: CompatVectors, offer: Uint8Array, accept: Uint8Array): { spliceInput: Uint8Array; offer2: Uint8Array } {
  const { offerer, contract, splice } = vectors
  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(offerer.descriptor)
  const offer2TempId = fromHexString(splice.offerTempIdHex)
  const spliceInput = ddk.createDlcSpliceInput(offer, accept, ddk.Party.Offer, BigInt(splice.spliceSerialId), 220)
  const offer2 = ddk.createOffer({
    chainHash: ddk.chainHashFromNetwork('regtest'),
    temporaryContractId: offer2TempId,
    contractInfo: fromHexString(splice.contractInfoHex),
    offerCollateralSats: BigInt(splice.totalCollateralSats),
    party: {
      fundingPubkey: offererKeys.fundingPubkey(offer2TempId),
      fundingInputs: [spliceInput],
      payoutSpk: fromHexString(offerer.payoutSpkHex),
      payoutSerialId: 1n,
      changeSpk: fromHexString(offerer.changeSpkHex),
      changeSerialId: 2n,
    },
    fundOutputSerialId: 3n,
    feeRatePerVb: BigInt(contract.feeRatePerVb),
    cetLocktime: contract.cetLocktime,
    refundLocktime: contract.refundLocktime,
    contractFlags: contract.contractFlags,
  })
  return { spliceInput, offer2 }
}

/** Accepts contract 2 (single-funded; fresh adaptor signatures). */
export function buildSpliceAccept(ddk: any, vectors: CompatVectors, offer2: Uint8Array): { accept2: Uint8Array; fundingPsbt2: Uint8Array } {
  const { acceptor, contract, splice } = vectors
  const acceptorKeys = ddk.ContractKeyProvider.fromDescriptor(acceptor.descriptor)
  const accept2TempId = fromHexString(splice.acceptTempIdHex)
  const result = ddk.acceptOffer(
    offer2,
    {
      party: {
        fundingPubkey: acceptorKeys.fundingPubkey(accept2TempId),
        fundingInputs: [],
        payoutSpk: fromHexString(acceptor.payoutSpkHex),
        payoutSerialId: 4n,
        changeSpk: fromHexString(acceptor.changeSpkHex),
        changeSerialId: 5n,
      },
      minTimeoutInterval: contract.minTimeoutInterval,
      maxTimeoutInterval: contract.maxTimeoutInterval,
    },
    acceptorKeys,
    accept2TempId,
  )
  return { accept2: result.accept, fundingPsbt2: result.fundingPsbt }
}

/**
 * Replays the committed transcript and returns every deterministic artifact,
 * keyed like `expected`. Also regenerates a fresh accept/sign pair for both
 * contracts to prove the current build produces valid messages.
 */
export function runDdkReplay(ddk: any, vectors: CompatVectors): Record<string, string> {
  const { offerer, acceptor, contract, splice, transcript } = vectors
  const out: Record<string, string> = {}

  const offererKeys = ddk.ContractKeyProvider.fromDescriptor(offerer.descriptor)
  const acceptorKeys = ddk.ContractKeyProvider.fromDescriptor(acceptor.descriptor)
  const offerTempId = fromHexString(contract.offerTempIdHex)
  const acceptTempId = fromHexString(contract.acceptTempIdHex)

  // --- contract 1: the offer must reproduce byte-exactly ---
  out.offerHex = toHexString(buildOffer(ddk, vectors))

  const offer = fromHexString(transcript.offerHex)
  const accept = fromHexString(transcript.acceptHex)
  const sign = fromHexString(transcript.signHex)
  ddk.validateOffer(offer, contract.minTimeoutInterval, contract.maxTimeoutInterval)
  ddk.validateAccept(offer, accept)
  ddk.validateSign(offer, accept, sign)

  // Fresh accept/sign viability: new adaptor signatures every run, so no byte
  // comparison — but they must validate, and the fresh accept must imply the
  // exact same funding PSBT as the committed transcript.
  const fresh = buildAccept(ddk, vectors, offer)
  ddk.validateAccept(offer, fresh.accept)
  out.freshAcceptPsbtHex = toHexString(fresh.fundingPsbt)
  const freshSignedPsbt = ddk.signFundingPsbtWithDescriptor(offer, fresh.accept, fresh.fundingPsbt, offerer.descriptor, [
    { inputSerialId: BigInt(offerer.fundingSerialId), derivationIndex: offerer.derivationIndex },
  ])
  const freshSign = ddk.signAccept(offer, fresh.accept, offererKeys, offerTempId, freshSignedPsbt)
  ddk.validateSign(offer, fresh.accept, freshSign.sign)

  // --- deterministic derivations from the committed transcript ---
  out.fundingPsbtHex = toHexString(ddk.createFundingPsbt(offer, accept))
  const acceptorSignedPsbt = ddk.signFundingPsbtWithDescriptor(offer, accept, fromHexString(out.fundingPsbtHex), acceptor.descriptor, [
    { inputSerialId: BigInt(acceptor.fundingSerialId), derivationIndex: acceptor.derivationIndex },
  ])
  out.fundingTxHex = toHexString(ddk.finalizeSign(offer, accept, sign, acceptorSignedPsbt))
  out.contractIdHex = toHexString(ddk.computeContractId(offer, accept))
  out.cetHex = toHexString(
    ddk.signContractCet(offer, accept, sign, offererKeys, offerTempId, [
      { oracleIndex: 0, attestation: fromHexString(contract.attestationHex) },
    ]),
  )
  out.refundHex = toHexString(ddk.signContractRefund(offer, accept, sign, acceptorKeys, acceptTempId))

  // --- contract 2: splice successor ---
  const { spliceInput, offer2 } = buildSpliceOffer(ddk, vectors, offer, accept)
  out.spliceInputHex = toHexString(spliceInput)
  out.offer2Hex = toHexString(offer2)

  const offer2Committed = fromHexString(transcript.offer2Hex)
  const accept2 = fromHexString(transcript.accept2Hex)
  const sign2 = fromHexString(transcript.sign2Hex)
  ddk.validateOffer(offer2Committed, contract.minTimeoutInterval, contract.maxTimeoutInterval)
  ddk.validateAccept(offer2Committed, accept2)
  ddk.validateSign(offer2Committed, accept2, sign2)

  const fresh2 = buildSpliceAccept(ddk, vectors, offer2Committed)
  ddk.validateAccept(offer2Committed, fresh2.accept2)
  const freshSign2 = ddk.signAcceptSpliced(offer2Committed, fresh2.accept2, offererKeys, fromHexString(splice.offerTempIdHex), fresh2.fundingPsbt2, [
    { inputSerialId: BigInt(splice.spliceSerialId), priorTemporaryContractId: offerTempId },
  ])
  ddk.validateSign(offer2Committed, fresh2.accept2, freshSign2.sign)

  out.fundingPsbt2Hex = toHexString(ddk.createFundingPsbt(offer2Committed, accept2))
  out.fundingTx2Hex = toHexString(
    ddk.finalizeSignSpliced(offer2Committed, accept2, sign2, fromHexString(out.fundingPsbt2Hex), acceptorKeys, [
      { inputSerialId: BigInt(splice.spliceSerialId), priorTemporaryContractId: acceptTempId },
    ]),
  )
  out.contractId2Hex = toHexString(ddk.computeContractId(offer2Committed, accept2))
  out.cet2Hex = toHexString(
    ddk.signContractCet(offer2Committed, accept2, sign2, acceptorKeys, fromHexString(splice.acceptTempIdHex), [
      { oracleIndex: 0, attestation: fromHexString(splice.attestationHex) },
    ]),
  )

  return out
}
