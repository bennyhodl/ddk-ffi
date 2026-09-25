import {
  init,
  version,
  convertMnemonicToSeed,
  createExtkeyFromSeed,
  getPubkeyFromExtkey,
  createFundTxLockingScript,
} from '@bennyblader/ddk'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const out = document.getElementById('result')!

try {
  await init()
  const seed = convertMnemonicToSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    undefined,
  )
  const pubkey = getPubkeyFromExtkey(createExtkeyFromSeed(seed, 'regtest'), 'regtest')
  out.textContent = JSON.stringify({
    ok: true,
    version: version(),
    fundingScript: hex(createFundTxLockingScript(pubkey, pubkey)),
    crossOriginIsolated: self.crossOriginIsolated,
  })
} catch (e) {
  out.textContent = JSON.stringify({ ok: false, error: String(e) })
}
