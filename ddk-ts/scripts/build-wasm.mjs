#!/usr/bin/env node
/**
 * Build the wasm binding: ddk-ffi -> wasm32-unknown-unknown -> ubrn wasm2.
 *
 * A different ubrn target from the N-API one in build-release.mjs. wasm2 does
 * not dlopen a native library through a host addon; the @ubjs/wasm player
 * instantiates ddk_ffi.wasm and calls its exports directly, so it runs in a
 * browser, and in Node on any platform. Same ddk-ffi source, same public API.
 *
 *   src-wasm/generated/   ubrn output: TypeScript (committed) + ddk_ffi.wasm (not)
 *   src-wasm/index.ts     hand-written entry: `init()` with a default .wasm URL
 *   dist-wasm/            compiled ESM + .d.ts + the .wasm — what the package ships
 *
 * Requires:
 *   - the wasm32-unknown-unknown rust target
 *   - a C compiler that can target wasm32. secp256k1-sys and secp256k1-zkp-sys
 *     compile vendored C (both ship a wasm sysroot for it); Apple's /usr/bin/cc
 *     has no wasm backend. macOS: `brew install llvm`. Linux: `apt install clang`.
 *     Override with WASM_CC / WASM_AR.
 *
 * Usage:
 *   node scripts/build-wasm.mjs           # release
 *   node scripts/build-wasm.mjs --debug   # debug profile
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const GENERATED = join(PKG, 'src-wasm', 'generated')
const DIST = join(PKG, 'dist-wasm')
const WASM = 'ddk_ffi.wasm'

const debug = process.argv.includes('--debug')

const run = (cmd, argv, opts = {}) => {
  console.log(`  $ ${cmd} ${argv.join(' ')}`)
  execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
}

// --- a wasm-capable C toolchain ---------------------------------------------
const canTargetWasm = (cc) => {
  try {
    return /wasm32/.test(execFileSync(cc, ['--print-targets'], { encoding: 'utf8' }))
  } catch {
    return false
  }
}
const CC = [process.env.WASM_CC, '/opt/homebrew/opt/llvm/bin/clang', '/usr/local/opt/llvm/bin/clang', '/usr/bin/clang']
  .filter(Boolean)
  .find((c) => existsSync(c) && canTargetWasm(c))
const AR = [
  process.env.WASM_AR,
  '/opt/homebrew/opt/llvm/bin/llvm-ar',
  '/usr/local/opt/llvm/bin/llvm-ar',
  '/usr/bin/llvm-ar',
]
  .filter(Boolean)
  .find((a) => existsSync(a))
if (!CC || !AR) {
  console.error(
    'error: no wasm32-capable C toolchain found.\n' +
      "  secp256k1-sys compiles vendored C, and Apple's /usr/bin/cc cannot target wasm32.\n" +
      '  macOS: brew install llvm    Linux: apt install clang llvm\n' +
      '  Or set WASM_CC / WASM_AR.',
  )
  process.exit(1)
}
console.log(`Using CC=${CC}\n      AR=${AR}`)

// --- 1. cargo build + generate + stage ---------------------------------------
// One ubrn command does all three, reading ubrn.config.yaml: builds ddk-ffi for
// wasm32-unknown-unknown, reads the bindings metadata out of that same .wasm (no
// second, native build), and stages the .wasm beside the TypeScript. ddk-ffi's
// getrandom `js` backend pulls in wasm-bindgen, so staging also runs ubrn's
// built-in wasm-bindgen over it and writes ddk_ffi_bg.js; that is why ddk-ffi
// pins wasm-bindgen to the version ubrn embeds.
console.log(`\n[1/3] ubrn build wasm2 (${debug ? 'debug' : 'release'})`)
for (const f of existsSync(GENERATED) ? readdirSync(GENERATED) : []) rmSync(join(GENERATED, f))
run(
  'uniffi-bindgen-react-native',
  ['build', 'wasm2', ...(debug ? [] : ['--release']), '--config', 'ubrn.config.yaml'],
  {
    cwd: PKG,
    env: { ...process.env, CC_wasm32_unknown_unknown: CC, AR_wasm32_unknown_unknown: AR },
  },
)

// --- 2. fix ESM specifiers, compile -----------------------------------------
console.log('\n[2/3] fix ESM imports + tsc')
run('node', [join(HERE, 'fix-esm-imports.mjs'), GENERATED], { cwd: PKG })
// ubrn 0.31.0-5 puts `// @ts-nocheck` on ddk_ffi.ts and ddk_ffi-ffi.ts but not on
// its wasm2 index.ts, which then fails tsc inside ubrn's own types: the
// generated `as const` definitions table is readonly and @ubjs/wasm's
// `registerSync` takes mutable `FfiTypeDesc[]`. Give it the same header.
const index = join(GENERATED, 'index.ts')
const indexSrc = readFileSync(index, 'utf8')
if (!indexSrc.includes('@ts-nocheck')) writeFileSync(index, `// @ts-nocheck\n${indexSrc}`)
rmSync(DIST, { recursive: true, force: true })
run('npx', ['tsc', '-p', 'tsconfig.wasm.json'], { cwd: PKG })

// --- 3. ship the .wasm ------------------------------------------------------
// tsc does not copy it. (ddk_ffi_bg.js needs no copy: allowJs compiles it.)
console.log('\n[3/3] copy ddk_ffi.wasm')
copyFileSync(join(GENERATED, WASM), join(DIST, 'generated', WASM))

const wasm = join(DIST, 'generated', WASM)
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
console.log(`\nDone. ${WASM}: ${mb(statSync(wasm).size)} (${mb(gzipSync(readFileSync(wasm)).length)} gzipped)`)
