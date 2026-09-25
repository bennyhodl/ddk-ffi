# React Native example

This app exercises `@bennyblader/ddk-rn` from `packages/react-native`, including the contract lifecycle and compatibility vectors.

Run these commands from the repository root. Install the native toolchains described in the [development guide](../../README.md) first.

```sh
just install

# iOS (requires macOS and Xcode)
just build react-native ios
pnpm --dir packages/react-native example:pods
just example react-native ios

# Android (requires the Android SDK and NDK)
just build react-native android
just example react-native android
```

To start Metro separately:

```sh
pnpm --dir examples/react-native start
```

Edit `examples/react-native/src/App.tsx` to change the app. Its Metro, Babel, and autolinking configuration resolve the local package.

Run the device end-to-end flows with `just test react-native ios` or `just test react-native android`. CI runs both platforms.
