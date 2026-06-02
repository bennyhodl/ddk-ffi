#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

// Parse ddk-ffi lib.rs for the exported UniFFI operations.
// Source of truth is the Rust proc-macros (there is no longer a .udl):
//   - free functions:  #[uniffi::export] pub fn <name>(
//   - record methods:  pub fn <name>(  inside a #[uniffi::export] impl block
function parseUniffiFunctions(libPath) {
  const content = fs.readFileSync(libPath, 'utf8')

  // Free functions: #[uniffi::export] immediately followed by a top-level `pub fn`.
  const free = [...content.matchAll(/#\[uniffi::export\]\s*\npub fn (\w+)\(/g)].map((m) => m[1])

  // Methods: `pub fn` indented inside an impl block. Every impl block in this
  // crate that defines methods is annotated #[uniffi::export], so any 4-space
  // indented `pub fn` is an exported method.
  const methods = [...content.matchAll(/\n {4}pub fn (\w+)\(/g)].map((m) => m[1])

  return [...free, ...methods]
}

// Parse ddk-ts lib.rs for the #[napi] functions
function parseNAPIFunctions(libPath) {
  const content = fs.readFileSync(libPath, 'utf8')
  return [...content.matchAll(/#\[napi\]\s*pub fn (\w+)/g)].map((m) => m[1])
}

function verifyParity() {
  const ffiLibPath = path.join(__dirname, '../../ddk-ffi/src/lib.rs')
  const tsLibPath = path.join(__dirname, '../src/lib.rs')

  console.log('🔍 Verifying NAPI-RS and UniFFI parity...\n')

  const uniffiFunctions = parseUniffiFunctions(ffiLibPath)
  console.log(`📋 Found ${uniffiFunctions.length} exported operations in ddk-ffi (functions + methods)`)

  const napiFunctions = parseNAPIFunctions(tsLibPath)
  console.log(`🦀 Found ${napiFunctions.length} #[napi] functions in ddk-ts\n`)

  const napiSet = new Set(napiFunctions)
  const uniffiSet = new Set(uniffiFunctions)

  const missingInNAPI = uniffiFunctions.filter((fn) => !napiSet.has(fn))
  const extraInNAPI = napiFunctions.filter((fn) => !uniffiSet.has(fn))

  console.log('📊 Parity Check Results:\n')

  if (missingInNAPI.length > 0) {
    console.error('❌ Operations exported by ddk-ffi but missing in ddk-ts NAPI:')
    missingInNAPI.forEach((fn) => console.error(`   - ${fn}`))
    console.log()
  }

  if (extraInNAPI.length > 0) {
    console.error('❌ NAPI functions in ddk-ts with no matching ddk-ffi export:')
    extraInNAPI.forEach((fn) => console.error(`   - ${fn}`))
    console.log()
  }

  if (missingInNAPI.length === 0 && extraInNAPI.length === 0) {
    console.log('✅ Perfect parity! ddk-ts NAPI matches ddk-ffi exports 1:1.')
  } else {
    console.log('⚠️  Parity issues found. Please review the discrepancies above.')
    process.exit(1)
  }

  console.log('\n📈 Summary:')
  console.log(`   ddk-ffi exports: ${uniffiFunctions.length}`)
  console.log(`   ddk-ts NAPI:     ${napiFunctions.length}`)
}

try {
  verifyParity()
} catch (error) {
  console.error('❌ Error during verification:', error.message)
  process.exit(1)
}
