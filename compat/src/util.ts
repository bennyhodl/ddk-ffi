/** Zero-copy view of a Uint8Array (e.g. a strictByteArrays return) as a Buffer. */
export const bytes = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength)

export const buf = (hex: string): Buffer => Buffer.from(hex, 'hex')

export const hex = (u: Uint8Array): string => bytes(u).toString('hex')

/** 32-byte temporary contract id filled with a marker byte. */
export const tempId = (marker: number): Buffer => Buffer.alloc(32, marker)

/**
 * Strips a node-dlc TLV envelope (bigsize type + bigsize length) and returns
 * the message body. ddk exchanges standalone messages like OracleAttestation
 * as the bare lightning-Writeable body; node-dlc's serialize() adds the
 * envelope. The body layouts are identical (asserted by the message suite).
 */
export function tlvBody(serialized: Buffer): Buffer {
  let offset = 0
  const readBigSize = (): bigint => {
    const first = serialized[offset]!
    if (first < 0xfd) {
      offset += 1
      return BigInt(first)
    }
    if (first === 0xfd) {
      const v = serialized.readUInt16BE(offset + 1)
      offset += 3
      return BigInt(v)
    }
    if (first === 0xfe) {
      const v = serialized.readUInt32BE(offset + 1)
      offset += 5
      return BigInt(v)
    }
    const v = serialized.readBigUInt64BE(offset + 1)
    offset += 9
    return v
  }
  readBigSize() // type
  const length = readBigSize()
  const body = serialized.subarray(offset, offset + Number(length))
  if (body.length !== Number(length)) throw new Error('truncated TLV')
  return body
}

/**
 * rust-dlc contract id derivation: fund txid (reversed byte order) XOR the
 * temporary contract id, with the fund output index folded into the last two
 * bytes. Reference implementation kept here independently of both libraries so
 * the test does not assume either one is right.
 */
export function referenceContractId(fundTxIdDisplayOrder: Buffer, fundOutputIndex: number, temporaryContractId: Buffer): Buffer {
  if (fundTxIdDisplayOrder.length !== 32 || temporaryContractId.length !== 32) {
    throw new Error('contract id inputs must be 32 bytes')
  }
  // rust-dlc XORs txid.as_ref()[31 - i] (internal order reversed), which is
  // the txid in display order — i.e. the bytes of the hex string you see.
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    out[i] = fundTxIdDisplayOrder[i]! ^ temporaryContractId[i]!
  }
  out[30] ^= (fundOutputIndex >> 8) & 0xff
  out[31] ^= fundOutputIndex & 0xff
  return out
}
