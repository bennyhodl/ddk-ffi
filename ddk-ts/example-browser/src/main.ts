// In a real app this is all you write. The bundler resolves
// `@bennyblader/ddk-ts` to its `browser` entry, which loads the WASM binding.
// (Locally we alias it in vite.config.ts — see README.md.)
import { version } from '@bennyblader/ddk-ts'

const versionEl = document.getElementById('version') as HTMLSpanElement
const logEl = document.getElementById('log') as HTMLPreElement

const log = (msg: string) => {
  logEl.textContent += msg + '\n'
  console.log(msg)
}

try {
  const v = version()
  versionEl.textContent = v
  versionEl.className = 'ok'
  log(`✅ WASM loaded. ddk-ts version() -> ${v}`)
  log(`   crossOriginIsolated: ${globalThis.crossOriginIsolated}`)
} catch (err) {
  versionEl.textContent = 'failed'
  versionEl.className = 'err'
  log(`❌ ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
}
