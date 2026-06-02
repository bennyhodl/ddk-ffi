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
# Generate the JSI bindings
uniffi-jsi:
  cd {{justfile_directory()}}/ddk-ffi && uniffi-bindgen-react-native generate jsi bindings \
    --crate ddk_ffi \
    --ts-dir {{justfile_directory()}}/ddk-rn/src \
    --cpp-dir {{justfile_directory()}}/ddk-rn/cpp \
    {{justfile_directory()}}/ddk-ffi/src/ddk_ffi.udl

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

# Release the React Native bindings
rn-release:
  cd {{justfile_directory()}}/ddk-rn && node scripts/release.js

# Create binary archives for the React Native bindings
rn-release-archives:
  cd {{justfile_directory()}}/ddk-rn && node scripts/create-binary-archives.js

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

# Release TypeScript package to npm
ts-release version:
    cd {{justfile_directory()}}/ddk-ts && node scripts/release.sh {{version}}

# ====================
# Unified Release
# ====================

# Unified release for both React Native and TypeScript packages
release version:
    node {{justfile_directory()}}/scripts/unified-release.js {{version}}