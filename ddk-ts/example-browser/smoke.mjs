// Headless check of the built page: serve dist/ with `vite preview`, load it in
// Chrome, and read back the JSON main.ts writes. Exits non-zero unless the
// wasm binding produced the expected 2-of-2 funding script.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const EXPECTED_SCRIPT =
  '522103d902f35f560e0470c63313c7369168d9d7df2d49bf295fd9fb7cb109ccee04942103d902f35f560e0470c63313c7369168d9d7df2d49bf295fd9fb7cb109ccee049452ae'
const PORT = 4179

const chrome = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
  .filter(Boolean)
  .find(existsSync)
if (!chrome) {
  console.error('error: no Chrome found; set CHROME')
  process.exit(1)
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
try {
  let dom = ''
  for (let i = 0; i < 20 && !dom.includes('"ok"'); i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      dom = execFileSync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--virtual-time-budget=10000',
          '--dump-dom',
          `http://localhost:${PORT}/`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {}
  }
  const json = dom.match(/<pre id="result">(.*?)<\/pre>/s)?.[1]
  const result = json ? JSON.parse(json.replaceAll('&quot;', '"')) : { ok: false, error: 'no result in page' }
  console.log(result)
  if (!result.ok || result.fundingScript !== EXPECTED_SCRIPT) {
    console.error('browser smoke test FAILED')
    process.exitCode = 1
  } else {
    console.log('browser smoke test passed')
  }
} finally {
  server.kill()
}
