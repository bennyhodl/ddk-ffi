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

# Build the iOS XCFramework
build-ios:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build ios \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --and-generate

# Build the Android JNI libraries (not part of `just build`; needs the NDK)
build-android:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build android \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --and-generate

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
# Release
# ====================

# Gate on a clean, up-to-date, CI-green commit, then bump versions, tag, and push
# the tag (triggers publish.yml, which builds native binaries and publishes both
# npm packages). Pass a bump flag or explicit version:
#   just release            # patch bump
#   just release --minor    # minor bump
#   just release 0.4.0      # explicit version
#   just release --dry      # validate the gates without mutating anything

# Bump versions, tag, and push to trigger the npm publish on CI
release *args:
    node {{justfile_directory()}}/scripts/prep-release.js {{args}}
