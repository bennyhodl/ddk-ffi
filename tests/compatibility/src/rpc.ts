import { RPC_PASS, RPC_URL, RPC_USER, RPC_WALLET } from './config.js'

/** Minimal bitcoind JSON-RPC client (fetch-based, no dependencies). */
export class BitcoindRpc {
  constructor(
    private readonly url: string = RPC_URL,
    private readonly user: string = RPC_USER,
    private readonly pass: string = RPC_PASS,
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const target = wallet ? `${this.url}/wallet/${wallet}` : this.url
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'ddk-compat', method, params }),
    })
    const body = (await res.json()) as { result: T; error: { code: number; message: string } | null }
    if (body.error) {
      throw new Error(`bitcoind ${method}: ${body.error.message} (code ${body.error.code})`)
    }
    return body.result
  }

  wallet<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.call<T>(method, params, RPC_WALLET)
  }

  async reachable(): Promise<boolean> {
    try {
      await this.call('getblockcount')
      return true
    } catch {
      return false
    }
  }

  /** Creates/loads the suite's wallet and mines it spendable funds if needed. */
  async prepareWallet(): Promise<void> {
    const wallets = await this.call<string[]>('listwallets')
    if (!wallets.includes(RPC_WALLET)) {
      try {
        await this.call('loadwallet', [RPC_WALLET])
      } catch {
        await this.call('createwallet', [RPC_WALLET])
      }
    }
    const balance = await this.wallet<number>('getbalance')
    if (balance < 10) {
      const addr = await this.wallet<string>('getnewaddress', ['', 'bech32'])
      // 110 blocks: enough mature coinbases even on a fresh chain.
      await this.call('generatetoaddress', [110, addr])
    }
  }

  /** Sends `btc` to `address`, mines one block, returns the funding tx hex and txid. */
  async fundAddress(address: string, btc = 2): Promise<{ txid: string; hex: string }> {
    const txid = await this.wallet<string>('sendtoaddress', [address, btc])
    await this.mine(1)
    const hex = await this.call<string>('getrawtransaction', [txid])
    return { txid, hex }
  }

  async mine(blocks = 1): Promise<void> {
    const addr = await this.wallet<string>('getnewaddress', ['', 'bech32'])
    await this.call('generatetoaddress', [blocks, addr])
  }

  async sendRawTransaction(hexTx: string): Promise<string> {
    return this.call<string>('sendrawtransaction', [hexTx])
  }

  /** Broadcasts, mines a block, and asserts the tx confirmed. Returns the txid. */
  async broadcastAndConfirm(hexTx: string): Promise<string> {
    const txid = await this.sendRawTransaction(hexTx)
    await this.mine(1)
    const info = await this.call<{ confirmations?: number }>('getrawtransaction', [txid, true])
    if (!info.confirmations || info.confirmations < 1) {
      throw new Error(`transaction ${txid} did not confirm`)
    }
    return txid
  }
}
