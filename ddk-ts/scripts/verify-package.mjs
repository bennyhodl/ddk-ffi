#!/usr/bin/env node
/**
 * Refuse to publish a ddk-ts tarball that cannot load a native library.
 *
 * The main package ships only compiled JavaScript; the cdylib arrives through
 * an optionalDependency named after the consumer's platform. A tarball with no
 * optionalDependencies installs cleanly and then throws ResolveLibPathError on
 * the first call — a failure that surfaces in someone else's app, not here.
 *
 * Publishing is meant to happen through scripts/publish-release.mjs (driven by
 * .github/workflows/publish.yml), which injects those optionalDependencies from
 * the platform packages it just built. This is the backstop for a hand-run
 * `npm publish`, the one path no workflow can gate; it hangs off prepublishOnly
 * because that hook fires however publish was invoked.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const problems = []

if (!existsSync(join(PKG, 'dist', 'index.js'))) problems.push('dist/index.js is missing (nothing was built)')
if (!existsSync(join(PKG, 'dist', 'index.d.ts'))) problems.push('dist/index.d.ts is missing (no types)')

const optional = manifest.optionalDependencies ?? {}
const names = Object.keys(optional)
if (names.length === 0) {
  problems.push('no optionalDependencies — the package would install with no native library')
}
for (const [name, version] of Object.entries(optional)) {
  if (version !== manifest.version) {
    problems.push(`${name} is pinned to ${version}, but this package is ${manifest.version}`)
  }
}

if (problems.length > 0) {
  console.error(`\n❌ Refusing to publish ${manifest.name}:\n`)
  for (const problem of problems) console.error(`   - ${problem}`)
  console.error('\nRelease with: node scripts/publish-release.mjs (see ddk-ts/DEVELOPMENT.md)\n')
  process.exit(1)
}

console.log(`✅ ${manifest.name}@${manifest.version} — dist/ present, ${names.length} platform package(s) referenced`)
