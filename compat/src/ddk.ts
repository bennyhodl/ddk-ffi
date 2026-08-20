import * as ddk from '@bennyblader/ddk-ts'
import * as bitcoin from 'bitcoinjs-lib'
import bs58check from 'bs58check'

import type { BitcoindRpc } from './rpc.js'
import { bytes } from './util.js'

export { ddk }

export interface DdkFundedInput {
  /** Wire-encoded FundingInput bytes, ready for a party's fundingInputs. */
  fundingInput: Uint8Array
  inputSerialId: bigint
  /** Descriptor wildcard index that derives this input's key. */
  derivationIndex: number
  prevTxHex: string
  vout: number
}

/**
 * The ddk party: a BIP84 descriptor wallet plus the stateless ddk contract
 * API. This is the post-migration shape — no BAL, no @node-dlc; wire messages
 * in and out as bytes.
 */
export class DdkParty {
  readonly descriptor: string
  readonly keys: ddk.ContractKeyProviderInterface
  private readonly masterXprv: Uint8Array
  private nextAddressIndex = 0

  constructor(mnemonic: string) {
    const seed = ddk.convertMnemonicToSeed(mnemonic, undefined)
    this.masterXprv = ddk.createExtkeyFromSeed(seed, 'regtest')
    const tprv = bs58check.encode(bytes(this.masterXprv))
    this.descriptor = `wpkh(${tprv}/84h/1h/0h/0/*)`
    this.keys = ddk.ContractKeyProvider.fromDescriptor(this.descriptor)
  }

  /** The P2WPKH address at descriptor wildcard index `index`. */
  address(index: number): string {
    const child = ddk.createExtkeyFromParentPath(this.masterXprv, `m/84'/1'/0'/0/${index}`)
    const pubkey = ddk.getPubkeyFromExtkey(child, 'regtest')
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: bytes(pubkey),
      network: bitcoin.networks.regtest,
    })
    if (!address) throw new Error('failed to derive address')
    return address
  }

  /** The scriptPubKey (raw bytes) of the address at `index`. */
  scriptPubkey(index: number): Buffer {
    return bitcoin.address.toOutputScript(this.address(index), bitcoin.networks.regtest)
  }

  /** Funds a fresh wallet address on regtest and wraps the UTXO as a FundingInput. */
  async fundInput(rpc: BitcoindRpc, inputSerialId: bigint): Promise<DdkFundedInput> {
    const index = this.nextAddressIndex++
    const address = this.address(index)
    const { hex } = await rpc.fundAddress(address)
    const spk = this.scriptPubkey(index)
    const tx = bitcoin.Transaction.fromHex(hex)
    const vout = tx.outs.findIndex((o) => o.script.equals(spk))
    if (vout < 0) throw new Error(`funding output not found for ${address}`)
    return {
      fundingInput: ddk.fundingInput(Buffer.from(hex, 'hex'), vout, inputSerialId, 0xffffffff, 108, Buffer.alloc(0)),
      inputSerialId,
      derivationIndex: index,
      prevTxHex: hex,
      vout,
    }
  }

  /** Signs the party's own wallet inputs in a funding PSBT. */
  signFundingPsbt(
    offer: Uint8Array,
    accept: Uint8Array,
    fundingPsbt: Uint8Array,
    inputs: DdkFundedInput[],
  ): Uint8Array {
    return ddk.signFundingPsbtWithDescriptor(
      offer,
      accept,
      fundingPsbt,
      this.descriptor,
      inputs.map((i) => ({ inputSerialId: i.inputSerialId, derivationIndex: i.derivationIndex })),
    )
  }
}
