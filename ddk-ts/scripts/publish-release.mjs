#!/usr/bin/env node
/**
 * Publish @bennyblader/ddk-ts and its platform packages, in the only order that
 * works: platform packages FIRST, then the main package.
 *
 * npm resolves optionalDependencies at install time, so a main package pointing
 * at an unpublished platform version installs with no native library and fails
 * on the first call — with no install-time error.
 *
 * The optionalDependencies are injected here rather than committed. Committing
 * them would make every `pnpm install` on this repo try to fetch a platform
 * package for a version that does not exist yet (the release commit precedes
 * the publish), and `--frozen-lockfile` would fail on it. Locally the library is
 * resolved through the symlink `build-release.mjs --local` leaves in
 * node_modules, which is the same resolution path a consumer takes.
 *
 * Usage:
 *   node scripts/publish-release.mjs             # publish
 *   node scripts/publish-release.mjs --dry-run   # print what would happen
 *
 * The dist-tag comes from NPM_CONFIG_TAG in the environment (publish.yml sets
 * it to `next` for prereleases). Do not pass --tag: it would apply to the main
 * package only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const dryRun = process.argv.includes('--dry-run')

const manifestPath = join(PKG, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const { version } = manifest

const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

if (!existsSync(join(PKG, 'dist', 'index.js'))) fail('dist/index.js is missing — run scripts/build-release.mjs first')

const platformRoot = join(PKG, 'platform')
if (!existsSync(platformRoot)) fail('platform/ is missing — run scripts/build-release.mjs first')

const platforms = readdirSync(platformRoot).sort()
if (platforms.length === 0) fail('platform/ is empty')

const optionalDependencies = {}
for (const triple of platforms) {
  const dir = join(platformRoot, triple)
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (p.version !== version) fail(`${p.name} is ${p.version}, main package is ${version}`)
  const lib = p.files[0]
  if (!existsSync(join(dir, lib))) fail(`${p.name} declares ${lib} but the file is not there`)
  optionalDependencies[p.name] = version
}

console.log(`Publishing ${manifest.name}@${version} (dist-tag: ${process.env.NPM_CONFIG_TAG ?? 'latest'})`)
for (const [name, v] of Object.entries(optionalDependencies)) console.log(`  optional: ${name}@${v}`)

manifest.optionalDependencies = optionalDependencies
if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const publish = (cwd) => {
  console.log(`\n$ npm publish --access public   (${cwd})`)
  if (!dryRun) execFileSync('npm', ['publish', '--access', 'public'], { cwd, stdio: 'inherit' })
}

for (const triple of platforms) publish(join(platformRoot, triple))
publish(PKG)

console.log(dryRun ? '\nDry run — nothing published.' : `\nPublished ${version}.`)
