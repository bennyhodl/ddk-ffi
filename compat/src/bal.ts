/* eslint-disable @typescript-eslint/no-explicit-any */
import balDdkProviderPkg from '@atomicfinance/bitcoin-ddk-provider'
import * as jsWalletPkg from '@atomicfinance/bitcoin-js-wallet-provider'
import * as rpcProviderPkg from '@atomicfinance/bitcoin-rpc-provider'
import * as clientPkg from '@atomicfinance/client'
import * as balTypesPkg from '@atomicfinance/types'
import * as nodeDlcPkg from '@node-dlc/messaging'
import * as nodeDlcBitcoinPkg from '@node-dlc/bitcoin'
import * as balDdkTsPkg from 'bal-ddk-ts'
import * as bitcoinNetworkPkg from 'bitcoin-network'

import { RPC_URL, RPC_PASS, RPC_USER, RPC_WALLET } from './config.js'
import type { BitcoindRpc } from './rpc.js'

// The BAL party is the LATEST PUBLISHED release from npm, paired with the
// ddk-ts release production ships as its engine:
//   @atomicfinance/* 4.3.6  +  @bennyblader/ddk-ts 0.3.42
// (the same pairing lygos-app / orange-grove run). The 0.3.42 engine is
// installed under the `bal-ddk-ts` alias so it can coexist with the local
// ddk-ts the ddk party tests, and carries a pnpm patch removing its mislabeled
// `"type": "module"` (its dist is CJS — the exact patch orange-grove ships).
// @node-dlc resolves to the single 1.2.1 instance BAL pins, so class identity
// stays consistent between this test code and BAL internals.
const pick = (pkg: any, name: string) => pkg[name] ?? pkg.default?.[name] ?? pkg.default

export const nodeDlc: any = nodeDlcPkg
export const nodeDlcBitcoin: any = nodeDlcBitcoinPkg
export const balDdkTs: any = balDdkTsPkg
export const balTypes: any = balTypesPkg
export const bitcoinNetworks: any = pick(bitcoinNetworkPkg, 'BitcoinNetworks')

const Client: any = pick(clientPkg, 'Client')
const BitcoinRpcProvider: any = pick(rpcProviderPkg, 'BitcoinRpcProvider')
const BitcoinJsWalletProvider: any = pick(jsWalletPkg, 'BitcoinJsWalletProvider')
const BitcoinDdkProvider: any = balDdkProviderPkg

export const regtestNetwork: any = bitcoinNetworks.bitcoin_regtest

export interface BalParty {
  /** The @atomicfinance/client Client with rpc + js-wallet + ddk providers. */
  client: any
  dlc: any
}

/**
 * A BAL party exactly as production wires it (lygos-app / orange-grove):
 * BitcoinRpcProvider + BitcoinJsWalletProvider + BitcoinDdkProvider backed by
 * the published @bennyblader/ddk-ts 0.3.42.
 */
export function createBalParty(mnemonic: string): BalParty {
  const rpcProvider = new BitcoinRpcProvider({
    // The wallet-scoped URL keeps wallet RPCs unambiguous if more wallets load.
    uri: `${RPC_URL}/wallet/${RPC_WALLET}`,
    username: RPC_USER,
    password: RPC_PASS,
    network: regtestNetwork,
  })
  // Same fee mock as BAL's own integration tests: deterministic fee math.
  rpcProvider.getFeePerByte = async () => 3

  const client = new Client()
  client.addProvider(rpcProvider)
  client.addProvider(
    new BitcoinJsWalletProvider({
      network: regtestNetwork,
      mnemonic,
      baseDerivationPath: `m/84'/${regtestNetwork.coinType}'/0'`,
      addressType: balTypes.bitcoin.AddressType.BECH32,
    }),
  )
  client.addProvider(new BitcoinDdkProvider(regtestNetwork, balDdkTs))

  return { client, dlc: client.dlc }
}

/**
 * Port of BAL's tests/integration/common.ts getInput(): funds one of the
 * party's wallet addresses straight from the node wallet and returns a
 * fully-populated Input for fixedInputs.
 */
export async function getBalInput(rpc: BitcoindRpc, party: BalParty): Promise<any> {
  const { address, derivationPath } = await party.client.wallet.getUnusedAddress()
  const { txid, hex } = await rpc.fundAddress(address)
  const decoded = await rpc.call<any>('decoderawtransaction', [hex])
  const vout = decoded.vout.find(
    (v: any) => v.scriptPubKey.address === address || (v.scriptPubKey.addresses ?? []).includes(address),
  )
  if (!vout) throw new Error(`funding output for ${address} not found in ${txid}`)

  const { Input } = balTypes as any
  return new Input(
    txid,
    vout.n,
    address,
    vout.value,
    Math.round(vout.value * 1e8),
    derivationPath,
    108, // maxWitnessLength (P2WPKH)
    '', // redeemScript
    undefined, // inputSerialId
    vout.scriptPubKey.hex,
    undefined, // label
    undefined, // confirmations
    undefined, // spendable
    undefined, // solvable
    undefined, // safe
    undefined, // dlcInput
  )
}
