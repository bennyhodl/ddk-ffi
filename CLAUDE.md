# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a React Native library that provides Rust-powered DLC (Discreet Log Contract) functionality through UniFFI bindings. The project bridges Rust DLC implementation to React Native using `uniffi-bindgen-react-native`.

## Architecture

The project consists of two main components:

- **ddk-ffi/**: Rust crate containing DLC business logic with UniFFI interface definitions
- **ddk-rn/**: React Native library with generated TypeScript, C++, iOS, and Android bindings

The architecture follows this flow:

1. Rust code defines records, functions, methods, and errors in `ddk-ffi/src/lib.rs`,
   annotated with UniFFI proc-macros (`#[derive(uniffi::Record)]`,
   `#[derive(uniffi::Error)]`/`Enum`, `#[uniffi::export]`). The crate calls
   `uniffi::setup_scaffolding!()` — there is no `.udl` file (it was fully migrated
   to proc-macros; the Rust source is the single source of truth).
2. Bindings are generated from the compiled library (NOT from a UDL) for TypeScript
   (JSI), C++, iOS (Swift/Objective-C), and Android (Kotlin/JNI). Library-based
   generation is required so proc-macro definitions are visible.
3. React Native consumes the generated TypeScript API

## Build System & Commands

This project uses `just` as the primary build orchestrator. All build commands should be run from the project root.

### Core Build Commands

- `just uniffi`: Complete build pipeline (generates all bindings + builds iOS/Android)
- `just uniffi-jsi`: Build the crate and generate TypeScript + C++ JSI bindings from the compiled library
- `just uniffi-turbo`: Generate React Native TurboModule specifications
- `just build-ios`: Build iOS static libraries and create XCFramework
- `just build-android`: Build Android native libraries (JNI)

### Example App Commands

- `just example-ios`: Install iOS dependencies with new architecture enabled
- `just example-android`: Build Android example app
- `cd ddk-rn/example && npx react-native run-ios`: Run iOS example
- `cd ddk-rn/example && npx react-native run-android`: Run Android example

### React Native Library Commands (run from ddk-rn/)

- `pnpm test`: Run Jest tests
- `pnpm typecheck`: Run TypeScript type checking
- `pnpm lint`: Run ESLint
- `pnpm prepare`: Build library with react-native-builder-bob

### Rust Commands (run from ddk-ffi/)

- `cargo build`: Build Rust crate
- `cargo test`: Run Rust tests

## Development Workflow

1. **Modify Rust Code**: Edit `ddk-ffi/src/lib.rs`. Annotate new types with
   `#[derive(uniffi::Record)]` / `#[derive(uniffi::Enum)]` / `#[derive(uniffi::Error)]`,
   and exported functions/methods with `#[uniffi::export]`. No `.udl` to update.
2. **Generate Bindings**: Run `just uniffi` to regenerate all language bindings
3. **Test Changes**: Use example app or run tests

## Key Files & Locations

### Rust FFI Layer

- `ddk-ffi/src/lib.rs`: Core Rust implementation + UniFFI proc-macro annotations (single source of truth; no `.udl`)
- `ddk-ffi/Cargo.toml`: Rust project configuration

### React Native Layer

- `ddk-rn/src/`: Generated TypeScript bindings
- `ddk-rn/cpp/`: Generated C++ bindings for JSI
- `ddk-rn/ios/`: iOS native module and XCFramework
- `ddk-rn/android/`: Android native module and JNI libraries
- `ddk-rn/ubrn.config.yaml`: UniFFI React Native configuration

### Generated Files (do not edit manually)

- TypeScript bindings in `ddk-rn/src/`
- C++ bindings in `ddk-rn/cpp/`
- iOS frameworks in `ddk-rn/ios/*.xcframework`
- Android libraries in `ddk-rn/android/src/main/jniLibs/`

## Known Issues

### UniFFI / ubrn version lockstep

The `uniffi` crate (`ddk-ffi/Cargo.toml`), the `uniffi-bindgen-react-native` dependency
(`ddk-rn/package.json`), and the **globally installed** `uniffi-bindgen-react-native`
binary must all be the same release. The `just uniffi-*` recipes call the bare
`uniffi-bindgen-react-native` on `$PATH`, which resolves to the global pnpm install —
not `ddk-rn/node_modules`. A version skew shows up as TypeScript errors like
"Expected 2 arguments, but got 1" on every generated `.lower()` call.

ubrn pins an exact `uniffi_core` version (e.g. ubrn `0.31.0-3` requires `uniffi_core =0.31.0`),
so pin the Rust crate to that exact patch. Update the global binary with
`pnpm add -g uniffi-bindgen-react-native@<version>`.

> Note: as of uniffi 0.31, the old manual fix for `#include "/ddk_ffi.hpp"` is no longer
> needed — the generator emits the correct `#include "ddk_ffi.hpp"`.

### Dependencies

- Requires `uniffi-bindgen-react-native` globally installed (version must match `ddk-rn/package.json`)
- Uses pnpm as package manager (not npm/yarn)
- React Native new architecture enabled by default

## Distribution: ddk-rn ships PREBUILT binaries

Consumers must never compile Rust. `@bennyblader/ddk-rn` ships the iOS XCFramework
and the Android JNI archives inside the npm tarball; `npm install` unpacks them and
does nothing else. There is deliberately **no `postinstall` script**.

This matters because invoking the ubrn CLI is far more expensive than it looks:
`node_modules/uniffi-bindgen-react-native/bin/cli.cjs` is a shim that runs
`cargo run --manifest-path .../crates/ubrn_cli/Cargo.toml`, so *any* CLI call
compiles the bindgen itself from Rust source (~889MB target dir) before it does
any work. A `postinstall` that called it — which is what this package used to do —
cost consumers that build plus a full debug build of `ddk-ffi` for every iOS
target, needed a Rust toolchain, and silently produced no Android libraries at all
unless the consumer had the NDK.

Rules to preserve:

- **Never add a `postinstall`** to `ddk-rn/package.json`, and never call the ubrn
  CLI from any consumer-facing lifecycle script.
- The `files` array in `ddk-rn/package.json` is an allowlist that must keep
  `ios/DdkRn.xcframework` and `android/src/main/jniLibs`. It intentionally
  contains no `!**/*.a` / `!**/*.xcframework` / `!**/jniLibs` excludes — those
  are what forced the source-build model. The root `.gitignore` ignores these
  binaries, but it does not apply here: npm only consults ignore files inside the
  package directory, and `ddk-rn/` has none. Verify with `npm pack --dry-run`.
- The Rust source (`ddk-ffi/`) is **not** shipped in the package.
- Always build with `--release`; a debug static archive is ~320MB per slice
  against ~44MB release, and it ships to every consumer. `just build-ios` and
  `just build-android` apply the right flags; use them rather than calling ubrn
  directly.
- The two platforms link differently, and the difference is load-bearing:
  - **iOS** must link a *static* archive (a React Native requirement), so every
    object file ships whether referenced or not. `strip -S` is the only lever on
    its size — `just build-ios` applies it.
  - **Android** links a *shared* library (`android.useSharedLibrary: true`), so
    the linker drops unreferenced code and the `.so` is roughly a tenth of the
    equivalent archive. It must **not** be stripped — that breaks ubrn's
    turbo-module and native-bindings generation — so there is deliberately no
    strip step for Android, and `ddk-ffi` must declare no `[profile.release]`
    `strip` setting.
- `/.cargo/config.toml` passes `-Wl,-z,max-page-size=16384` to the Android
  targets. Android 15+ requires every `.so` in an APK to be 16KB-page aligned;
  `android/CMakeLists.txt` sets this only for the C++ library it builds, and
  `libddk_ffi.so` comes from cargo instead. Do not convert this to a `RUSTFLAGS`
  env var — that would also hit host build scripts, whose linker rejects the flag.
  Verify with the NDK's own readelf — every LOAD segment must show align `0x4000`:
  ```
  $NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-readelf -l \
    ddk-rn/android/src/main/jniLibs/arm64-v8a/libddk_ffi.so | grep LOAD
  ```
- **NDK 27.3.13750724 is pinned**, in `.github/workflows/publish.yml` and locally.
  It was `ANDROID_NDK_LATEST_HOME`, which tracks whatever the runner image ships
  (r29 as of this writing) and moves without warning — a release could be built by
  a toolchain nobody tested against. r27 is the runner's own default and the first
  NDK to default to 16KB alignment; r28/r29 raised minimum API levels. Install the
  same one locally with
  `sdkmanager --sdk_root="$HOME/Library/Android/sdk" --install "ndk;27.3.13750724"`
  so `just build-android` reproduces CI.
- ubrn regenerates `ddk-rn/android/build.gradle` on every `--and-generate`. It
  drops the `net.java.dev.jna:jna` dependency because JNA is gated on ubrn's
  `--native-bindings` flag, which defaults to false and which nothing here passes;
  the JSI path does not use JNA. Do not re-add it by hand.
- **The Android C++ build needs a pnpm patch on ubrn — upstream bug, fixed but
  unreleased.** The generated `ddk-rn/android/CMakeLists.txt` resolves the ubrn
  package with `require.resolve('uniffi-bindgen-react-native/package.json')`, but
  ubrn's own `package.json` has an `exports` map that never exposes
  `./package.json`, so that throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. CMake's
  `execute_process` ignores the failure, the include dir silently becomes
  `/cpp/includes`, and the build dies with `'UniffiCallInvoker.h' file not found`.

  Fixed here by `ddk-rn/patches/uniffi-bindgen-react-native@0.31.0-3.patch`,
  which adds that one export — identical to the upstream fix. It is wired up in
  `ddk-rn/pnpm-workspace.yaml` under `patchedDependencies` (pnpm 10 keeps it
  there rather than in `package.json`, so nothing leaks into the published
  package), and `pnpm install` re-applies it automatically. Don't hand-edit
  `CMakeLists.txt`: ubrn rewrites it on every `--and-generate`.

  Upstream is `jhugman/uniffi-bindgen-react-native#404`, fixed on `main` by
  commit `2b57645` ("Export package.json subpath (#407)", 2026-07-15) but **not
  in any published release** — `0.31.0-3` (2026-05-28) is still `latest`. We are
  tracking the release request in **#421**. Check with
  `npm view uniffi-bindgen-react-native dist-tags`; when a release carries the
  fix, bump the pin (all three places — see the version-lockstep note above) and
  delete the patch plus its `patchedDependencies` entry.

  **Known limitation:** a pnpm patch only applies to this repo. ddk-rn pins ubrn
  `0.31.0-3` in `dependencies` and ships `android/CMakeLists.txt` in its `files`
  allowlist, so a consumer building an Android app against the published package
  hits the original error. Accepted deliberately (2026-07-28) — there are no
  external Android consumers today, and it resolves itself when ubrn releases.
- **`just build-android <abi>` rewrites the committed `build.gradle`.** Passing a
  target list narrows `abiFilters` to just those ABIs and wipes `jniLibs/` for the
  rest. Harmless in CI (nothing is committed there), but locally it leaves a
  modified `build.gradle` that must never be committed — a single-ABI
  `build.gradle` ships an app that only runs on one architecture. After running it
  with an argument: `git checkout ddk-rn/android/build.gradle`.
- Generation runs prettier over `ddk-rn/src/`, which reformats hand-written files
  living there (e.g. `src/__tests__/contractBindings.test.js`). Committing the
  prettier-formatted version keeps that from churning on every build.
- `uniffi-bindgen-react-native` stays a runtime `dependency` — `android/CMakeLists.txt`
  and `DdkRn.podspec` both need its C++ headers — but nothing at install time
  invokes its binary.

Publishing needs two hosts, so `.github/workflows/publish.yml` splits the work:
`build-ddk-rn-ios` on `macos-latest` (only macOS has `xcodebuild -create-xcframework`),
`build-ddk-rn-android` on `ubuntu-latest` (needs the NDK), then `publish-ddk-rn`
assembles both artifacts and verifies the binaries are in the tarball before
publishing.

### Releasing

`just release <version>` (→ `scripts/prep-release.js`) is the only release path.
It sets the version in `ddk-ts/package.json`, `ddk-rn/package.json` and
`ddk-ffi/Cargo.toml`, commits, tags `v<version>` and pushes. Pushing the tag is
what publishes. There is deliberately no local publish path — no single host can
build every platform this repo ships — and `ddk-rn`'s `prepublishOnly` runs
`scripts/verify-package.js` to refuse a hand-run `npm publish` that would ship
without binaries.

Update `ddk-rn/CHANGELOG.md`'s `[Unreleased]` section **before** releasing:
`prep-release.js` refuses a dirty tree, so it cannot be part of the release
commit. That section is also the highest-signal input to the release notes.

The `github-release` job runs after both publishes and creates the GitHub release
via `scripts/release-notes.js`, which summarises the commit range with the
Anthropic API (needs an `ANTHROPIC_API_KEY` repo secret; override the model with
`RELEASE_NOTES_MODEL`). It degrades rather than fails — no key, an API error, or
an empty response falls back to a plain commit list, and then to
`gh release create --generate-notes`. Keep it that way: by the time this job runs
the npm publish is irreversible, so notes must never turn a successful release
red. Run it locally against any tag with
`node scripts/release-notes.js <version>`.

### ddk-ts

`ddk-ts` also compiles nothing on install: it ships prebuilt napi platform
packages via `optionalDependencies`, with a WASI build as the fallback for any
platform not in the published matrix.

## Testing

- Rust tests: `cargo test` (in ddk-ffi/)
- TypeScript tests: `pnpm test` (in ddk-rn/)
- Integration testing via example app

## Code Generation

All TypeScript, C++, iOS, and Android code is automatically generated from the Rust code and UDL definitions. Do not manually edit generated files as they will be overwritten on the next build.

## Changelog Management

When making changes or releases, update the appropriate changelog:

- **ddk-rn/CHANGELOG.md**: For React Native library changes
- **ddk-ts/CHANGELOG.md**: For TypeScript/Node.js library changes

### Changelog Entry Format

Keep entries concise - just the main idea of the change:

```markdown
## [VERSION] - DATE
- Brief description of change
- Another change description
```

### When to Update Changelog

- After creating a new release
- After implementing significant features
- After fixing important bugs

Example entry:
```markdown
## [0.1.5] - 2025-01-16
- Added new DLC validation functions
- Fixed memory leak in native bindings
- Improved error handling
```

## GitHub Issue Management

### Creating Issues

When asked to create a GitHub issue, use the `gh` CLI tool:

```bash
# Basic issue creation
gh issue create --title "Issue title" --body "Issue description"

# With labels
gh issue create --title "Issue title" --body "Issue description" --label "bug,enhancement"

# Assign to someone
gh issue create --title "Issue title" --body "Issue description" --assignee "@username"

# With milestone
gh issue create --title "Issue title" --body "Issue description" --milestone "v1.0"
```

### Issue Body Format

Use markdown for clear, structured issue descriptions:

```markdown
## Summary
Brief description of the issue

## Details
- Detailed point 1
- Detailed point 2

## Tasks
- [ ] Task 1
- [ ] Task 2

## Notes
Any additional context
```

### Listing and Viewing Issues

```bash
# List all open issues
gh issue list

# List issues with specific labels
gh issue list --label "bug"

# View a specific issue
gh issue view <issue-number>

# Search issues
gh issue list --search "keyword"
```

## GitHub Pull Request Management

### Creating Pull Requests

When asked to create a pull request, use the `gh` CLI tool:

```bash
# Create PR with title and body
gh pr create --title "PR title" --body "$(cat <<'EOF'
## Summary
Brief description of changes

## Changes
- Change 1
- Change 2

## Testing
- How to test these changes

## Related Issues
Closes #123
EOF
)"

# Create PR with specific base branch
gh pr create --base main --title "PR title" --body "PR description"

# Create PR and assign reviewers
gh pr create --title "PR title" --body "PR description" --reviewer @username

# Create PR with labels
gh pr create --title "PR title" --body "PR description" --label "enhancement,documentation"

# Create PR as draft
gh pr create --draft --title "WIP: PR title" --body "Work in progress"
```

### PR Body Template

```markdown
## Summary
Brief description of what this PR does

## Changes
- Specific change 1
- Specific change 2
- Specific change 3

## Testing
Describe how to test these changes

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] Changelog updated (if applicable)

## Related Issues
Closes #issue-number
```

### Managing Pull Requests

```bash
# List all open PRs
gh pr list

# View a specific PR
gh pr view <pr-number>

# Check PR status
gh pr status

# Checkout a PR locally
gh pr checkout <pr-number>

# Merge a PR
gh pr merge <pr-number> --merge  # or --squash, --rebase
```
