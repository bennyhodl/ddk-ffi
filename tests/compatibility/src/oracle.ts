import { createHash } from 'node:crypto'

import { schnorr, secp256k1 } from '@noble/curves/secp256k1'

import { nodeDlc } from './bal.js'
import { EVENT_MATURITY_EPOCH } from './config.js'

const Point = secp256k1.ProjectivePoint
const N = secp256k1.CURVE.n

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

/** BIP340-style tagged hash: sha256(sha256(tag) || sha256(tag) || msg...). */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Buffer {
  const tagHash = sha256(Buffer.from(tag, 'utf8'))
  return sha256(tagHash, tagHash, ...msgs)
}

const toBig = (b: Uint8Array): bigint => BigInt('0x' + Buffer.from(b).toString('hex'))
const toBytes32 = (x: bigint): Buffer => Buffer.from(x.toString(16).padStart(64, '0'), 'hex')

const hasEvenY = (p: InstanceType<typeof Point>): boolean => p.toAffine().y % 2n === 0n

/**
 * BIP340 Schnorr signature with a caller-supplied nonce — what a DLC oracle
 * does: the nonce (R value) is committed to in the announcement, and the
 * attestation must use exactly that nonce. Verified against @noble's schnorr
 * before returning, so a broken signature can never leak into a fixture.
 */
export function signWithNonce(msg32: Uint8Array, privkey: Uint8Array, nonce: Uint8Array): Buffer {
  let d = toBig(privkey) % N
  if (d === 0n) throw new Error('invalid oracle key')
  const P = Point.BASE.multiply(d)
  if (!hasEvenY(P)) d = N - d

  let k = toBig(nonce) % N
  if (k === 0n) throw new Error('invalid nonce')
  const R = Point.BASE.multiply(k)
  if (!hasEvenY(R)) k = N - k

  const rx = toBytes32(R.toAffine().x)
  const px = toBytes32(P.toAffine().x)
  const e = toBig(taggedHash('BIP0340/challenge', rx, px, msg32)) % N
  const s = (k + ((e * d) % N)) % N
  const sig = Buffer.concat([rx, toBytes32(s)])

  if (!schnorr.verify(sig, msg32, px)) {
    throw new Error('produced an invalid BIP340 signature')
  }
  return sig
}

/**
 * A deterministic test oracle. Signs enum attestations the way ddk / rust-dlc
 * (and the lygos production oracle) expect: the BIP340 message is
 * taggedHash('DLC/oracle/attestation/v0', <raw utf8 outcome bytes>) — NOT the
 * legacy cfd convention of hashing sha256(outcome) hex first.
 */
export class CompatOracle {
  private readonly priv: Buffer

  constructor(seed = 'ddk-bal-compat-oracle') {
    // Any fixed non-zero scalar works; derive one from the seed.
    this.priv = toBytes32(toBig(taggedHash('DDK-COMPAT/oracle-key', Buffer.from(seed, 'utf8'))) % N)
  }

  /** 32-byte x-only oracle public key. */
  get publicKey(): Buffer {
    return Buffer.from(schnorr.getPublicKey(this.priv))
  }

  /** Deterministic per-event nonce scalar (the announcement commits to R = kG). */
  private nonceScalar(eventId: string, index: number): Buffer {
    const idx = Buffer.alloc(4)
    idx.writeUInt32BE(index)
    return toBytes32(toBig(taggedHash('DDK-COMPAT/nonce', this.priv, Buffer.from(eventId, 'utf8'), idx)) % N)
  }

  /** The x-only R values announced for an event. */
  nonces(eventId: string, count = 1): Buffer[] {
    return Array.from({ length: count }, (_, i) =>
      Buffer.from(schnorr.getPublicKey(this.nonceScalar(eventId, i))),
    )
  }

  /** A signed node-dlc OracleAnnouncement for an enum event. */
  buildEnumAnnouncement(eventId: string, outcomes: string[], maturityEpoch = EVENT_MATURITY_EPOCH): any {
    const descriptor = new nodeDlc.EnumEventDescriptor()
    descriptor.outcomes = outcomes

    const event = new nodeDlc.OracleEvent()
    event.oracleNonces = this.nonces(eventId, 1)
    event.eventMaturityEpoch = maturityEpoch
    event.eventDescriptor = descriptor
    event.eventId = eventId

    const announcement = new nodeDlc.OracleAnnouncement()
    announcement.announcementSig = signWithNonce(
      taggedHash('DLC/oracle/announcement/v0', event.serialize()),
      this.priv,
      // The announcement signature nonce is not committed anywhere; reuse the
      // derivation with a distinct index so it stays deterministic.
      this.nonceScalar(`${eventId}/announcement`, 0),
    )
    announcement.oraclePublicKey = this.publicKey
    announcement.oracleEvent = event
    return announcement
  }

  /**
   * A node-dlc OracleAttestation signed the LEGACY cfd/BAL way — over
   * taggedHash('DLC/oracle/attestation/v0', sha256(outcome)) — used to prove
   * both stacks reject the pre-migration convention.
   */
  attestEnumLegacyCfd(eventId: string, outcome: string): any {
    const msg = taggedHash('DLC/oracle/attestation/v0', sha256(Buffer.from(outcome, 'utf8')))
    const attestation = new nodeDlc.OracleAttestation()
    attestation.eventId = eventId
    attestation.oraclePublicKey = this.publicKey
    attestation.signatures = [signWithNonce(msg, this.priv, this.nonceScalar(eventId, 0))]
    attestation.outcomes = [outcome]
    return attestation
  }

  /** A node-dlc OracleAttestation over a single enum outcome (ddk tagging). */
  attestEnum(eventId: string, outcome: string): any {
    const msg = taggedHash('DLC/oracle/attestation/v0', Buffer.from(outcome, 'utf8'))
    const attestation = new nodeDlc.OracleAttestation()
    attestation.eventId = eventId
    attestation.oraclePublicKey = this.publicKey
    attestation.signatures = [signWithNonce(msg, this.priv, this.nonceScalar(eventId, 0))]
    attestation.outcomes = [outcome]
    return attestation
  }
}
