// Only repository build outputs. Keep dependencies, source, committed generated
// bindings, native SDKs, and the remote cache so a normal clean can demonstrate
// Turbo restoring the build. --cache also clears the local Turbo cache.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputs = [
  "ffi/target",
  "packages/node-browser/dist",
  "packages/node-browser/platform",
  "packages/node-browser/browser/generated/ddk_ffi.wasm",
  "packages/react-native/lib",
  "packages/react-native/ios/DdkRn.xcframework",
  "packages/react-native/android/src/main/jniLibs",
  "packages/react-native/android/build",
  "packages/react-native/android/.cxx",
  "packages/react-native/android/.gradle",
  "examples/node/dist",
  "examples/browser/dist",
  "examples/react-native/ios/build",
  "examples/react-native/android/build",
  "examples/react-native/android/app/build",
  "examples/react-native/android/app/.cxx",
  "examples/react-native/android/.gradle",
  "artifact",
  "packages/node-browser/.turbo",
  "packages/react-native/.turbo",
  "examples/node/.turbo",
  "examples/browser/.turbo",
  "examples/react-native/.turbo",
  "packages/node-browser/coverage",
  "packages/react-native/coverage",
  "tests/compatibility/coverage",
];
if (process.argv.includes("--cache"))
  outputs.push(".turbo/cache", ".turbo/runs");
for (const path of outputs) {
  rmSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), {
    recursive: true,
    force: true,
  });
  console.log(`Removed ${path}`);
}
