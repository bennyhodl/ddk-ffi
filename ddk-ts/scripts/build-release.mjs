#!/usr/bin/env node
/**
 * Build ddk-ts: generate the N-API bindings from ddk-ffi, compile them, and
 * assemble one publishable platform package per target.
 *
 * This replaces napi-rs's `napi build`. There is no Rust in this package —
 * `src/` is generated output from the compiled ddk-ffi cdylib.
 *
 *   src/          generated TypeScript (committed; CI re-generates and diffs it)
 *   dist/         compiled ESM + .d.ts — this is what the main package ships
 *   platform/<node-triple>/
 *     package.json                          one publishable package per target,
 *     libddk_ffi.dylib | .so | ddk_ffi.dll  the cdylib named after the CRATE
 *
 * At runtime the generated resolver calls @ubjs/node's resolveLibPath(), which
 * does require.resolve('@bennyblader/ddk-ts-<node-triple>/package.json') and
 * looks for the crate-named library beside it. scripts/publish-release.mjs
 * turns those directories into the main package's optionalDependencies.
 *
 * Usage:
 *   node scripts/build-release.mjs                     # every published target
 *   node scripts/build-release.mjs --target <triple>   # one cargo triple (repeatable)
 *   node scripts/build-release.mjs --local             # host target, linked into node_modules
 *   node scripts/build-release.mjs --local --debug     # ditto, debug profile (CI's gate)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..')
const FFI = join(REPO, 'ddk-ffi')

const PKG_BASE = '@bennyblader/ddk-ts-'
const CRATE = 'ddk_ffi'

// cargo triple -> { node triple, npm os/cpu, library filename }
// Node triples must match @ubjs/node's detectNodeTriple(), and the library name
// its libFileName(crateName, process.platform) — get either wrong and the
// failure is a runtime ResolveLibPathError, not a build error.
const TARGETS = {
  'aarch64-apple-darwin': { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64', lib: `lib${CRATE}.dylib` },
  'x86_64-apple-darwin': { node: 'darwin-x64', os: 'darwin', cpu: 'x64', lib: `lib${CRATE}.dylib` },
  'x86_64-unknown-linux-gnu': { node: 'linux-x64-gnu', os: 'linux', cpu: 'x64', lib: `lib${CRATE}.so` },
  'aarch64-unknown-linux-gnu': { node: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', lib: `lib${CRATE}.so` },
  'x86_64-pc-windows-msvc': { node: 'win32-x64-msvc', os: 'win32', cpu: 'x64', lib: `${CRATE}.dll` },
}

// What a release ships. Keep in sync with publish.yml's build-ddk-ts matrix:
// a target listed here but not built there publishes a main package whose
// optionalDependency never resolves.
const PUBLISHED = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const version = flag('version') ?? manifest.version
const debug = args.includes('--debug')
const local = args.includes('--local')
const profile = debug ? 'debug' : 'release'

let targets = args.reduce((acc, a, i) => (a === '--target' ? [...acc, args[i + 1]] : acc), [])
if (local) {
  const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('host:'))
    .slice(5)
    .trim()
  targets = [host]
}
if (targets.length === 0) targets = PUBLISHED

const unknown = targets.filter((t) => !TARGETS[t])
if (unknown.length) {
  console.error(`error: unmapped target(s): ${unknown.join(', ')}`)
  console.error(`known: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}

const run = (cmd, argv, cwd) => {
  console.log(`  $ ${cmd} ${argv.join(' ')}`)
  execFileSync(cmd, argv, { cwd, stdio: 'inherit' })
}

// 1. Build the cdylib for each target.
console.log(`\n[1/4] cargo build --${profile} (${targets.join(', ')})`)
for (const t of targets) {
  run('cargo', ['build', ...(debug ? [] : ['--release']), '--target', t], FFI)
}

// 2. Generate the TypeScript bindings from the first artifact. Library-mode
//    generation only needs one: the interface is identical across targets, and
//    the resolver is baked in from --lib-package-base rather than a path.
console.log('\n[2/4] generate napi bindings')
const source = targets[0]
const sourceLib = join(FFI, 'target', source, profile, TARGETS[source].lib)
rmSync(join(PKG, 'src'), { recursive: true, force: true })
run(
  'uniffi-bindgen-react-native',
  [
    'generate',
    'napi',
    'bindings',
    '--library',
    '--ts-dir',
    join(PKG, 'src'),
    '--lib-package-base',
    PKG_BASE,
    '--lib-node-triple',
    sourceLib,
  ],
  FFI, // must run from the crate dir; it shells out to `cargo metadata`
)

// 3. Patch ESM specifiers, then compile.
console.log('\n[3/4] fix ESM imports + tsc')
run('node', [join(HERE, 'fix-esm-imports.mjs'), join(PKG, 'src')], PKG)
rmSync(join(PKG, 'dist'), { recursive: true, force: true })
run('npx', ['tsc', '-p', 'tsconfig.build.json'], PKG)

// 4. Assemble one platform package per target.
console.log('\n[4/4] assemble platform packages')
for (const t of targets) {
  const { node: nodeTriple, os, cpu, lib } = TARGETS[t]
  const outDir = join(PKG, 'platform', nodeTriple)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  copyFileSync(join(FFI, 'target', t, profile, lib), join(outDir, lib))
  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: `${PKG_BASE}${nodeTriple}`,
        version,
        description: `ddk-ffi native library for ${nodeTriple}`,
        os: [os],
        cpu: [cpu],
        // resolveLibPath() does require.resolve('<pkg>/package.json'), so this
        // package must not hide ./package.json behind a restrictive "exports".
        main: lib,
        files: [lib],
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/bennyhodl/ddk-ffi.git' },
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`  ${PKG_BASE}${nodeTriple} -> platform/${nodeTriple}/${lib}`)

  // Local development and CI's test gate resolve the library through
  // node_modules, exactly as a consumer would. The main package deliberately
  // carries no optionalDependencies in the repo (publish-release.mjs injects
  // them), so without this symlink there is nothing for resolveLibPath to find.
  if (local) {
    const scope = join(PKG, 'node_modules', PKG_BASE.split('/')[0])
    const linked = join(scope, `${PKG_BASE.split('/')[1]}${nodeTriple}`)
    mkdirSync(scope, { recursive: true })
    rmSync(linked, { recursive: true, force: true })
    symlinkSync(outDir, linked, 'dir')
    console.log(`  linked   node_modules/${PKG_BASE}${nodeTriple} -> platform/${nodeTriple}`)
  }
}

console.log(`\nDone (${version}, ${profile}). Publish with: node scripts/publish-release.mjs`)
