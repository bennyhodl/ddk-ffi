#!/usr/bin/env node
/**
 * ubrn emits extensionless relative imports (`from './ddk_ffi'`). Node's ESM
 * loader requires explicit extensions, so the compiled package fails at runtime
 * with ERR_MODULE_NOT_FOUND unless they are rewritten to `./ddk_ffi.js`.
 *
 * Run this over the generated directory after every `generate napi bindings`
 * and before `tsc`. It is idempotent, and it is not optional.
 *
 * Usage: node scripts/fix-esm-imports.mjs <generated-dir>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: fix-esm-imports.mjs <generated-dir>')
  process.exit(1)
}

// Only relative specifiers, and only ones that don't already carry an extension.
const RE = /(\bfrom\s+|\bimport\s*\()(['"])(\.\.?\/[^'"]*?)(['"])/g

// A specifier already has an extension if its final segment contains a dot.
// Asset imports (`./foo.wasm`) must be left alone — appending .js to those
// breaks them silently.
const hasExtension = (spec) => spec.split('/').pop().includes('.')

let patched = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const path = join(dir, file)
  const src = readFileSync(path, 'utf8')
  const out = src.replace(RE, (m, kw, q1, spec, q2) => (hasExtension(spec) ? m : `${kw}${q1}${spec}.js${q2}`))
  if (out !== src) {
    writeFileSync(path, out)
    patched++
    console.log(`  patched ${file}`)
  }
}
console.log(patched ? `fixed ESM imports in ${patched} file(s)` : 'nothing to fix')
