# ====================
# React Native Bindings
# ====================

# Build the complete React Native bindings
uniffi:
  just uniffi-jsi
  just uniffi-turbo
  just build-ios
  just build-android
  @echo ""
  @echo "🎉 Uniffi build complete! 🎉"
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

# Build the iOS bindings
build-ios:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build ios \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --and-generate

# Build the Android bindings
build-android:
  cd {{justfile_directory()}}/ddk-rn && uniffi-bindgen-react-native build android \
    --config {{justfile_directory()}}/ddk-rn/ubrn.config.yaml --and-generate

# Build the example app with the React Native bindings
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