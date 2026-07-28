# ====================
# Develop
# ====================

# Check all Rust crates (cargo test) and the TypeScript bindings (tsc)
check:
    cd {{justfile_directory()}}/ddk-ffi && cargo test --all-features
    cd {{justfile_directory()}}/ddk-ts && cargo test
    cd {{justfile_directory()}}/ddk-rn && pnpm typecheck

# Lint all Rust crates (rustfmt + clippy) and the React Native bindings (eslint)
lint:
    cd {{justfile_directory()}}/ddk-ffi && cargo fmt -- --check && cargo clippy --all-features -- -D warnings
    cd {{justfile_directory()}}/ddk-ts && cargo fmt -- --check && cargo clippy -- -D warnings
    cd {{justfile_directory()}}/ddk-rn && pnpm lint

# ====================
# Build bindings
# ====================

# Build all bindings: React Native (iOS) + TypeScript/Node.js
build:
    just uniffi-jsi
    just uniffi-turbo
    just build-ios
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm build
    @echo ""
    @echo "🎉 Bindings built — React Native (iOS) + TypeScript 🎉"
    @echo "🔥 Run 'just example-ios' to test the build"

# TS-bindings config (e.g. strictTypeChecking) is read from ddk-ffi/uniffi.toml,
# which ubrn auto-discovers next to the crate's Cargo.toml — the --config flag is
# intentionally NOT used (ubrn's TS pipeline ignores it). The --ts-dir / --cpp-dir
# mirror the `bindings:` section of ddk-rn/ubrn.config.yaml, which this low-level
# command can't read, so the dirs are passed explicitly.
#
# Generation is LIBRARY-based (not from the .udl): it extracts the interface from
# the compiled lib so it includes proc-macro exports (records, methods, errors)
# that no .udl declares. Extract from the CDYLIB (.dylib/.so), NOT the staticlib
# (.a): a static archive lets the linker garbage-collect "unreferenced" metadata
# (more aggressively on Linux than macOS), which drops record/object metadata and
# fails with "object <Name> not found". The cdylib keeps all exported symbols.
#
# Generate the JSI bindings
uniffi-jsi:
  cd {{justfile_directory()}}/ddk-ffi && cargo build && \
    LIB="$(ls {{justfile_directory()}}/ddk-ffi/target/debug/libddk_ffi.dylib {{justfile_directory()}}/ddk-ffi/target/debug/libddk_ffi.so 2>/dev/null | head -1)" && \
    uniffi-bindgen-react-native generate jsi bindings \
    --library \
    --ts-dir {{justfile_directory()}}/ddk-rn/src \
    --cpp-dir {{justfile_directory()}}/ddk-rn/cpp \
    "$LIB"

# Generate the TurboModule bindings
uniffi-turbo:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native generate jsi turbo-module ddk_ffi \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml \
    --native-bindings

# These artifacts SHIP INSIDE THE NPM PACKAGE (see the `files` array in
# ddk-rn/package.json), so their size is a download every consumer pays.
#
# `--release` applies to both platforms and must stay: a debug static archive is
# ~320MB per slice against ~44MB release, and omitting it is what produced the
# 915MB xcframework.
#
# Stripping applies to iOS ONLY. iOS must link a static archive (a React Native
# requirement), which keeps every object file whether referenced or not, so
# `strip -S` is the only lever on its size. Android instead links a shared
# library, where the linker already drops unreferenced code — and stripping it
# would break ubrn's codegen. See build-android below.
#
# Build the iOS XCFramework (release, stripped)
build-ios:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build ios \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --release --and-generate
  just strip-ios
  just binary-sizes

# Strip debug symbols from every slice of the built XCFramework (macOS only)
strip-ios:
  find {{justfile_directory()}}/ddk-rn/ios/DdkRn.xcframework -name '*.a' -exec strip -S {} \;

# Android deliberately has NO strip step. It links Rust as a shared library
# (`android.useSharedLibrary: true`), and ubrn breaks turbo-module and native
# bindings generation if that library is stripped. Linking already discards
# unreferenced code, so the .so is ~a tenth of the equivalent static archive
# without stripping anything.
#
# `targets` is a comma-separated ABI list (arm64-v8a,armeabi-v7a,x86,x86_64)
# overriding ubrn.config.yaml. Leave it empty for a release — the package needs
# all four. PR CI passes a single ABI to keep the build short; it is checking
# that the library still compiles and links, not producing a shippable artifact.
#
# WARNING: passing `targets` also rewrites `abiFilters` in the COMMITTED
# ddk-rn/android/build.gradle to just those ABIs, and wipes jniLibs/ for the
# others. That is fine in CI (nothing is committed there) but locally it leaves
# a modified build.gradle that must NOT be committed — a single-ABI build.gradle
# would ship an app that only runs on one architecture. Check `git status` after
# running this with an argument, and `git checkout ddk-rn/android/build.gradle`.
#
# Build the Android JNI libraries (not part of `just build`; needs the NDK)
build-android targets="":
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build android \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --release --and-generate \
    {{ if targets == "" { "" } else { "--targets " + targets } }}
  just binary-sizes

# Report the size of every binary destined for the npm package
binary-sizes:
  #!/usr/bin/env bash
  cd {{justfile_directory()}}/ddk-rn
  echo "── binaries shipped in the npm package ──"
  [ -d ios/DdkRn.xcframework ] && du -sh ios/DdkRn.xcframework && du -sh ios/DdkRn.xcframework/*/ || true
  [ -d android/src/main/jniLibs ] && du -sh android/src/main/jniLibs && du -sh android/src/main/jniLibs/*/ || true
  echo "────────────────────────────────────────"

# ====================
# Example app
# ====================

# Build the example app (iOS + Android)
example:
  cd {{justfile_directory()}}/ddk-rn/example && pnpm install
  just example-ios
  just example-android

# Build the iOS example app
example-ios:
  cd {{justfile_directory()}}/ddk-rn/example/ios && RCT_NEW_ARCH_ENABLED=1 pod install && cd {{justfile_directory()}}/ddk-rn/example

# Build the Android example app
example-android:
  cd {{justfile_directory()}}/ddk-rn/example/android && ./gradlew build

# ====================
# Maintenance
# ====================

# Clean all build artifacts and dependencies
clean:
  # Clean React Native bindings
  cd {{justfile_directory()}}/ddk-rn && rm -rf cpp/ddk_ffi.* cpp/ddk-rn.* cpp/UniffiCallInvoker.h src/ddk_ffi*.ts src/NativeDdkRn.ts ios/DdkRn.xcframework android/src/main/jniLibs lib ios/build android/build example/ios/build example/android/build example/android/app/build example/ios/Pods example/ios/Podfile.lock example/ios/DdkRnExample.xcworkspace src/index.tsx

  # Clean TypeScript/Node.js bindings
  cd {{justfile_directory()}}/ddk-ts && rm -rf node_modules dist target pnpm-lock.yaml
  cd {{justfile_directory()}}/ddk-ts/example && rm -rf node_modules dist

# ====================
# TypeScript (Node.js) Bindings
# ====================

# Build TypeScript bindings for current platform
ts-build:
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm build

# Build TypeScript bindings for all supported platforms (Darwin ARM64 and Linux x64)
ts-build-all:
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm build:darwin-arm64 && pnpm build:linux-x64

# Run TypeScript example
ts-example:
    cd {{justfile_directory()}}/ddk-ts && pnpm build
    cd {{justfile_directory()}}/ddk-ts/example && pnpm install && pnpm build && pnpm start

# Run TypeScript tests
ts-test:
    cd {{justfile_directory()}}/ddk-ts && pnpm test

# ====================
# Release
# ====================

# Publishing happens in CI, not here. Neither package can be built correctly on
# one machine any more: ddk-rn ships prebuilt binaries that need a macOS host for
# the XCFramework and a Linux host with the NDK for the JNI libraries, and ddk-ts
# ships per-platform napi builds. This recipe therefore only bumps versions and
# pushes a tag; .github/workflows/publish.yml does the rest.

# Bump ddk-ts, ddk-rn and ddk-ffi to <version>, commit, tag v<version> and push (CI publishes)
release version:
    node {{justfile_directory()}}/scripts/prep-release.js {{version}}
