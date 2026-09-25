import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RPC_PASS, RPC_URL, RPC_USER, SPAWNED_NODE } from './config.js'
import { BitcoindRpc } from './rpc.js'

let child: ChildProcess | undefined
let datadir: string | undefined

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Spawns a throwaway regtest bitcoind unless DDK_COMPAT_RPC_URL points at an
 * existing node (in which case that node is used and left untouched).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const rpc = new BitcoindRpc()

  if (await rpc.reachable()) {
    await rpc.prepareWallet()
    return async () => {}
  }

  if (!SPAWNED_NODE) {
    throw new Error(`no bitcoind reachable at ${RPC_URL} (DDK_COMPAT_RPC_URL is set, so nothing was spawned)`)
  }

  const port = new URL(RPC_URL).port || '18543'
  datadir = mkdtempSync(join(tmpdir(), 'ddk-compat-regtest-'))
  let spawnFailed = false
  child = spawn(
    'bitcoind',
    [
      '-regtest',
      `-datadir=${datadir}`,
      `-rpcport=${port}`,
      `-port=${Number(port) + 1}`,
      `-rpcuser=${RPC_USER}`,
      `-rpcpassword=${RPC_PASS}`,
      '-fallbackfee=0.00001',
      '-txindex',
      '-listen=0',
    ],
    { stdio: 'ignore' },
  )
  child.on('error', () => {
    spawnFailed = true
  })

  try {
    await waitFor(() => Promise.resolve(spawnFailed), 1_000, 'spawn check').catch(() => {})
    if (spawnFailed) throw new Error('bitcoind not found')
    await waitFor(() => rpc.reachable(), 30_000, `bitcoind RPC at ${RPC_URL}`)
    await rpc.prepareWallet()
  } catch (err) {
    // The message and vector suites are fully offline; only warn here so they
    // can run on machines without Bitcoin Core. The lifecycle and splice
    // suites will fail with a clear connection error instead.
    console.warn(
      `[ddk-bal-compat] no regtest node available (${(err as Error).message}); ` +
        'offline suites will run, lifecycle/splice suites need bitcoind or DDK_COMPAT_RPC_URL',
    )
  }

  return async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 500))
    }
    if (datadir) rmSync(datadir, { recursive: true, force: true })
  }
}
