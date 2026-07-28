# @bennyblader/ddk-rn

React Native bindings for the DLC Dev Kit (DDK) - UniFFI-based native bindings for React Native applications.

## Installation

```bash
npm install @bennyblader/ddk-rn
# or
pnpm add @bennyblader/ddk-rn
```

That's the whole install. The package ships prebuilt native binaries — the iOS
XCFramework and the Android JNI libraries — so nothing is compiled on your
machine and no Rust toolchain, Android NDK, or extra download is required.
`pod install` and Gradle pick the binaries up from `node_modules` directly.

Prebuilt platform coverage:

| Platform | Architectures |
|----------|---------------|
| iOS      | `arm64` device, `arm64` simulator |
| Android  | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` |

The Intel Mac simulator (`x86_64`) is not included.

## Quick Start

```typescript
import { version, createFundTxLockingScript } from '@bennyblader/ddk-rn';

console.log(`DDK Version: ${version()}`);
```

For complete API documentation, see the [main README](../README.md#api-reference).

## Development

### Prerequisites

- Node.js >= 14
- Rust >= 1.70
- pnpm
- UniFFI React Native: `npm install -g uniffi-bindgen-react-native`
- iOS: Xcode 14+, CocoaPods
- Android: Android Studio, NDK

### Building from Source

```bash
# Install dependencies
pnpm install

# Generate all bindings and build native libraries
just uniffi

# Note: After building, manually fix the include path in cpp/bennyblader-ddk-rn.cpp
# Change: #include "/ddk_ffi.hpp"
# To: #include "ddk_ffi.hpp"
```

### Just Commands

```bash
# Complete build (generates bindings + builds iOS/Android)
just uniffi

# Generate JSI bindings only
just uniffi-jsi

# Generate TurboModule specifications
just uniffi-turbo

# Build iOS libraries
just build-ios

# Build Android libraries
just build-android

# Setup example app
just example

# iOS example setup
just example-ios

# Android example build
just example-android

# Clean all generated files
just clean

# Release new version
just release

# Create release archives
just release-archives
```

### Project Structure

```
ddk-rn/
├── src/                # Generated TypeScript bindings
│   ├── index.tsx       # Main entry point (generated)
│   └── ddk_ffi*.ts     # Type definitions (generated)
├── cpp/                # Generated C++ JSI bindings
│   ├── ddk_ffi.hpp     # C++ header (generated)
│   ├── ddk_ffi.cpp     # C++ implementation (generated)
│   └── *.cpp/.h        # TurboModule files (generated)
├── ios/                # iOS native module
│   ├── DdkRn.xcframework/ # iOS framework (generated)
│   └── *.swift/.m      # iOS bridge code
├── android/            # Android native module
│   └── src/main/
│       ├── java/       # Kotlin/Java bridge code
│       └── jniLibs/    # Native libraries (generated)
├── example/            # Example React Native app
├── scripts/            # Build and release scripts
└── ubrn.config.yaml    # UniFFI React Native configuration
```

### Platform Support

| Platform      | Architecture | Status       |
| ------------- | ------------ | ------------ |
| iOS           | ARM64        | ✅ Supported |
| iOS Simulator | x64/ARM64    | ✅ Supported |
| Android       | ARM64-v8a    | ✅ Supported |
| Android       | ARMv7        | ✅ Supported |
| Android       | x86_64       | ✅ Supported |

### Building the Example App

#### iOS

```bash
# Install iOS dependencies with new architecture
just example-ios

# Run the app
cd example
npx react-native run-ios
```

#### Android

```bash
# Build Android app
just example-android

# Run the app
cd example
npx react-native run-android
```

### Release Process

To release a new version:

```bash
just release
```

This will:

1. Build all native bindings
2. Run tests
3. Update version
4. Create release commit and tag
5. Push to GitHub
6. Publish to npm

### API Compatibility

The React Native bindings maintain 100% API compatibility with the UniFFI definitions. All functions are generated directly from the UDL file ensuring consistency across platforms.

### Known Issues

1. **Manual Include Path Fix**: After running `just uniffi`, you must manually fix the include path in `cpp/bennyblader-ddk-rn.cpp`:
   - Change: `#include "/ddk_ffi.hpp"`
   - To: `#include "ddk_ffi.hpp"`

2. **New Architecture**: The library requires React Native's new architecture to be enabled:
   - iOS: Set `RCT_NEW_ARCH_ENABLED=1`
   - Android: Set `newArchEnabled=true` in `gradle.properties`

## Troubleshooting

### iOS Build Issues

If you encounter build issues on iOS:

```bash
cd example/ios
pod deintegrate
pod install
```

### Android Build Issues

Clean and rebuild Android:

```bash
cd example/android
./gradlew clean
./gradlew build
```

### Missing Bindings

If bindings are missing, regenerate them:

```bash
just clean
just uniffi
```

## License

MIT
