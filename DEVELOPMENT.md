# Development Practices

This document outlines the key development practices and workflow for the ddk-ffi library.

## Core Principles

### 1. Pure Wrapper Architecture

- **This library should be PURELY a wrapper of rust-dlc**
- **AVOID copying logic** from rust-dlc into this codebase
- All DLC functionality must delegate to the rust-dlc crate
- Only implement type conversions and UniFFI interface bindings
- When rust-dlc updates, this library should continue working without code changes (only recompilation)

### 2. No Code Duplication

- Do not reimplement any DLC logic that exists in rust-dlc
- If functionality is missing from rust-dlc, contribute it upstream rather than implementing it here
- Keep conversion functions minimal and focused only on type transformation

## Required Workflow for Changes

### Before Every Commit/Tag

When making changes to `ddk-ffi/src/lib.rs`, you MUST:

1. **Generate bindings**: Run `just uniffi` to regenerate all language bindings
2. **Test build**: Verify the generated bindings compile correctly
3. **Commit together**: Include both Rust changes AND generated bindings in the same commit
   ```bash
   git add .  # Add all changes to the current directory
   git commit -m "feat: description of changes"
   ```

> There is no `.udl` file — the interface is defined by UniFFI proc-macros in
> `lib.rs`, which is the single source of truth. The `#include "/ddk_ffi.hpp"`
> fix that used to be required here is also gone; uniffi 0.31 emits the correct
> include.

### Release Process

Releases are published by CI, never from a developer machine. No single host can
build everything the repo ships: `ddk-rn`'s XCFramework needs macOS, its JNI
libraries need a Linux host with the Android NDK, and `ddk-ts` builds a separate
napi binary per platform.

With a clean working tree:

```bash
just release 0.2.0
```

That runs `scripts/prep-release.js`, which sets the version in
`ddk-ts/package.json`, `ddk-rn/package.json` and `ddk-ffi/Cargo.toml`, commits,
tags `v0.2.0`, and pushes the branch and the tag.

Pushing the tag triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. `verify-version` fails the run unless the tag matches both `package.json` versions
2. `build-ddk-rn-ios` builds the XCFramework on `macos-latest`
3. `build-ddk-rn-android` builds the JNI libraries on `ubuntu-latest` with a pinned NDK
4. `build-ddk-ts` builds each napi platform binary
5. The publish jobs assemble the artifacts, verify the binaries are in the tarball, and `npm publish`

There is nothing to upload by hand — no binary archives, no GitHub release assets.
The npm tarball carries the prebuilt binaries, which is what makes consumer
installs free of any Rust toolchain.

This will automatically:

- Prompt for version bump in package.json
- Build the library with react-native-builder-bob
- Create git tag and GitHub release
- Publish to npm registry
- Generate conventional changelog

#### Manual Release (If needed)

Alternatively, you can do it manually:

5. **Update Version Numbers**: Update version in both package manifests

   ```bash
   # Update Rust crate version
   vim ddk-ffi/Cargo.toml  # Change version = "0.1.1" to "0.1.2"

   # Update React Native package version
   vim ddk-rn/package.json  # Change "version": "0.1.1" to "0.1.2"
   ```

6. **Regenerate bindings**: Run `just uniffi` to update version in generated bindings

   ```bash
   just uniffi
   sed -i '' 's|#include "/ddk_ffi.hpp"|#include "ddk_ffi.hpp"|' ddk-rn/cpp/bennyblader-ddk-rn.cpp
   ```

7. **Build and test package**: Verify the npm package builds correctly

   ```bash
   cd ddk-rn
   pnpm prepare  # Build with react-native-builder-bob
   npm pack --dry-run  # Preview what will be published
   ```

8. **Commit version changes**: Include version bumps in the release commit

   ```bash
   git add .
   git commit -m "chore: bump version to v<version>"
   ```

9. **Create and push tag**: Create git tag and push to GitHub

   ```bash
   git tag -a v<version> -m "Release v<version>: <description>"
   git push origin master
   git push origin --tags
   ```

10. **Publish to npm**: Publish the package

    ```bash
    cd ddk-rn
    npm publish
    ```

11. **Create GitHub Release**: Use GitHub CLI to create a release
    ```bash
    gh release create v<version> --generate-notes --title "Release v<version>: <title>"
    ```

### Complete Development Cycle (Automated)

```bash
# 1. Make changes to Rust code
vim ddk-ffi/src/lib.rs

# 2. Test changes
cd ddk-ffi && cargo test

# 3. Generate bindings
just uniffi

# 4. Commit feature changes together with the regenerated bindings
git add .
git commit -m "feat: description of changes"

# 5. Release — bumps all three versions, commits, tags and pushes
just release 0.1.2
```

### What `just release` does automatically:

- Refuses to run unless the working tree is clean
- Sets the version in `ddk-ts/package.json`, `ddk-rn/package.json` and `ddk-ffi/Cargo.toml`
- Creates the git commit and the `v<version>` tag
- Pushes the branch and the tag

Everything after that is CI's job: building the native binaries on the hosts that
can build them, verifying the tarball, and publishing to npm.

### Why This Matters

- Generated bindings must stay in sync with Rust code
- Consumers of the library need both Rust logic and bindings to work together
- Prevents broken builds when someone pulls only partial changes

## Development Workflow

1. **Make Rust changes** in `ddk-ffi/src/lib.rs`
2. **Run tests**: `cargo test` to verify Rust functionality
3. **Generate bindings**: `just uniffi` to update all language bindings
4. **Test bindings**: Verify iOS/Android/TypeScript bindings compile
5. **Commit everything**: Include Rust + generated bindings in single commit

## Code Standards

### Wrapper Functions

```rust
// GOOD: Pure wrapper that delegates to rust-dlc
pub fn create_dlc_transactions(/* params */) -> Result<DlcTransactions, DLCError> {
    // Convert UniFFI types to rust-dlc types
    let rust_params = convert_params(params)?;

    // Call rust-dlc function
    let result = dlc::create_dlc_transactions(&rust_params)?;

    // Convert result back to UniFFI types
    Ok(convert_result(result))
}

// BAD: Reimplementing DLC logic
pub fn create_dlc_transactions(/* params */) -> Result<DlcTransactions, DLCError> {
    // Don't do this - reimplementing DLC transaction creation logic
    let mut tx = Transaction::new();
    // ... hundreds of lines of DLC logic copied from rust-dlc
}
```

### Error Handling

- Convert rust-dlc errors to UniFFI errors using `From` traits
- Don't create new error conditions that rust-dlc doesn't have
- Preserve error semantics from the underlying library

### Testing

- Test wrapper functions by comparing results with direct rust-dlc calls
- Verify type conversions work correctly with realistic data
- Test error handling paths

## Architecture Validation

Ask these questions for every change:

1. **Am I copying logic from rust-dlc?** → If yes, find a way to call rust-dlc instead
2. **Will this break when rust-dlc updates?** → If yes, make it more generic
3. **Could this be contributed to rust-dlc instead?** → Consider upstream contribution
4. **Am I generating bindings after Rust changes?** → Always required

## NPM Publishing Setup

### First Time Setup

Before you can publish to npm, you need:

1. **npm account**: Create account at https://www.npmjs.com/
2. **Access to @bennyblader scope**: Ensure you have publish permissions
3. **Authentication**: Run `npm login` in the `ddk-rn/` directory
4. **Verify access**: Test with `npm whoami` and `npm access ls-packages @bennyblader`

### Publishing Requirements

- Package builds successfully with `pnpm prepare`
- All tests pass with `pnpm test`
- Version in `package.json` is higher than published version
- Git working tree is clean

## Memory

- **CRITICAL**: Always run `just uniffi` before committing changes to `.rs` files, and commit the regenerated bindings alongside them
- **PRINCIPLE**: This is a pure wrapper - delegate to rust-dlc, never reimplement
- **RELEASES**: Use `just release <version>` to tag and push; CI publishes both packages. Never `npm publish` by hand — only CI can build every platform's binaries
