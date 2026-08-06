# DDK-TS Development

`ddk-ts` contains **no Rust and no hand-written bindings**. It is generated from
the compiled `ddk-ffi` cdylib by `uniffi-bindgen-react-native`'s N-API target,
which is the same bindgen (and the same crate) behind `@bennyblader/ddk-rn`.
`src/` is generated output; it is committed, and CI fails if it does not match
the crate.

## Quick Start

```bash
pnpm install
pnpm generate      # cargo build → generate → tsc → link the host platform package
pnpm test          # vitest, against dist/
```

`pnpm generate:debug` does the same with a debug cdylib. It is what the CI gate
runs, and it is much faster; the release profile only matters for what ships.

## Development Workflow

1. **Change `ddk-ffi/src/*.rs`** — the single source of truth, annotated with
   `#[uniffi::export]` / `#[derive(uniffi::Record)]`.
2. **`pnpm generate`** — regenerates `src/` from the newly built library.
3. **`pnpm test`**.
4. **Commit `src/`** along with the Rust change. A `ddk-ffi` change without its
   regenerated bindings fails CI's "committed bindings match the crate" step.

There is no step where a function is added by hand, and therefore no way for
this package's surface to drift from ddk-ffi's. That is the whole reason the
napi-rs layer (and its two parity-checking scripts) is gone.

## How generation works

```sh
cd ddk-ffi
cargo build --release
uniffi-bindgen-react-native generate napi bindings \
  --library \
  --ts-dir ../ddk-ts/src \
  --lib-package-base '@bennyblader/ddk-ts-' \
  --lib-node-triple \
  "$PWD/target/release/libddk_ffi.dylib"
```

`scripts/build-release.mjs` runs exactly this, then patches the ESM specifiers,
compiles with `tsconfig.build.json`, and assembles the platform packages. Three
things about it are easy to get wrong:

- **It must run from the crate directory.** It shells out to `cargo metadata`
  and otherwise fails with `manifest path Cargo.toml does not exist` — the same
  constraint as the `uniffi-jsi` recipe.
- **Generation is library-based, from the cdylib.** That is what makes
  proc-macro definitions (records, methods, errors) visible; a `.a` lets the
  linker drop the metadata.
- **`--lib-package-base` bakes in the resolver.** The generated code calls
  `resolveLibPath({ npmPackageBase: '@bennyblader/ddk-ts-', tripleStyle: 'node' })`,
  which does `require.resolve('@bennyblader/ddk-ts-darwin-arm64/package.json')`
  at runtime. No absolute paths are baked in.

The bindings *config* — `strictByteArrays`, `logLevel` — is not passed here. Ubrn
auto-discovers `ddk-ffi/uniffi.toml` and deliberately ignores `--config`, so that
file governs the Node bindings and the React Native bindings together. Changing
it is a cross-package decision.

## What the runtime needs

`@ubjs/node`'s `resolveLibPath()` fails at the first call, not at build time, if
this layout is wrong:

```
@bennyblader/ddk-ts/                 main package (ESM)
  dist/index.js, ddk_ffi.js, ddk_ffi-ffi.js  + .d.ts
  package.json   optionalDependencies -> every platform package

@bennyblader/ddk-ts-darwin-arm64/    one per target
  package.json                       must stay resolvable as '<pkg>/package.json'
  libddk_ffi.dylib                   named after the CRATE, at the package root
```

- **The library is named after the crate, not the npm package**:
  `libddk_ffi.dylib` / `libddk_ffi.so` / `ddk_ffi.dll`.
- **The platform `package.json` must be resolvable** — a restrictive `exports`
  block that hides `./package.json` breaks resolution.
- **Node triples, not cargo triples**: `darwin-arm64`, `linux-x64-gnu`,
  `win32-x64-msvc`. These match the platform-package names ddk-ts published
  under napi-rs, so consumers' lockfiles keep resolving the same names.

Locally, `pnpm generate` symlinks `platform/<triple>` into
`node_modules/@bennyblader/ddk-ts-<triple>`, so tests and the example resolve the
library through the same path a consumer does.

## Two constraints worth knowing up front

**ESM-only.** The resolver uses `import.meta.url`, so a CJS build breaks it. This
forecloses a dual CJS/ESM build.

**ubrn emits extensionless relative imports** (`from './ddk_ffi'`), which Node's
ESM loader rejects — the compiled package fails at runtime with
`ERR_MODULE_NOT_FOUND` until they are rewritten. `scripts/fix-esm-imports.mjs`
does that, after every generation and before `tsc`. It is not optional.

Also note `version()` returns the **Rust crate** version, not the npm version, so
keeping those in lockstep is still `just release`'s job.

## Releasing

```bash
just release 1.0.0        # from the repo root
```

That bumps `ddk-ts/package.json`, `ddk-rn/package.json`, `ddk-ffi/Cargo.toml` and
its lockfile, commits, tags and pushes. Pushing the tag is what publishes.

CI builds one cdylib per platform on its own runner, then runs
`scripts/publish-release.mjs`, which:

1. checks every `platform/*/package.json` is at the release version and carries
   its library,
2. injects the `optionalDependencies` into the main manifest,
3. publishes **the platform packages first**, then the main package.

The order is load-bearing: npm resolves `optionalDependencies` at install time,
so a main package pointing at an unpublished platform version installs cleanly
and then throws on the first call.

Those `optionalDependencies` are deliberately **not committed**. The release
commit precedes the publish, so a committed pin would make every
`pnpm install --frozen-lockfile` in this repo try to fetch a version that does
not exist yet.

Prereleases go to the `next` dist-tag, via `NPM_CONFIG_TAG` in the environment —
it has to be the env var rather than `--tag`, because `publish-release.mjs`
publishes each platform package with a bare `npm publish`.
