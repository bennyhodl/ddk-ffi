# ====================
# Develop
# ====================

# Check the Rust crate (cargo test) and both sets of bindings
check:
    cd {{justfile_directory()}}/ddk-ffi && cargo test --all-features
    cd {{justfile_directory()}}/ddk-ts && pnpm generate:debug && pnpm test
    cd {{justfile_directory()}}/ddk-rn && pnpm typecheck

# Lint the Rust crate (rustfmt + clippy) and the React Native bindings (eslint)
lint:
    cd {{justfile_directory()}}/ddk-ffi && cargo fmt -- --check && cargo clippy --all-features -- -D warnings
    cd {{justfile_directory()}}/ddk-ts && pnpm format:check
    cd {{justfile_directory()}}/ddk-rn && pnpm lint

# ====================
# Build bindings
# ====================

# Build all bindings: React Native (iOS) + TypeScript/Node.js
build:
    just uniffi-jsi
    just uniffi-turbo
    just build-ios
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm generate
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
# End-to-end (Maestro)
# ====================

# CI's e2e stage is deliberately dumb: it installs an app an earlier stage
# already built and runs `maestro test`. It compiles, lints and generates
# nothing. These recipes are those same steps locally, split so the expensive
# one can be skipped — the whole point being that a flow change should not cost
# a round trip through a macOS runner.
#
# Cheapest first:
#   just e2e-flows       no device, no build      parses every flow      ~15s
#   just e2e-ios-test    app already installed    reruns the flows       ~10s
#   just e2e-ios         build + install + run    what CI does           ~5-10m
#
# While editing a flow, sit in `e2e-ios-test`. Only rebuild when the app itself
# changes — JS, Rust, or the generated bindings.

# CI pins the same simulator; override with SIMULATOR_NAME=... for a local one.
sim := env_var_or_default("SIMULATOR_NAME", "iPhone 15")
avd := env_var_or_default("AVD_NAME", "ddk-e2e")

# Resolve {{sim}} to a UDID. `booted` is ambiguous the moment a second simulator
# is up: simctl and Maestro each pick independently, which is exactly how CI came
# to install the app onto one device and drive another, then report that the app
# "failed to launch". The trailing " (" stops "iPhone 15" matching "iPhone 15 Pro".
_sim-udid:
  #!/usr/bin/env bash
  set -euo pipefail
  UDID=$(xcrun simctl list devices available \
    | grep -E "^[[:space:]]+{{sim}} \(" | head -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')
  [ -n "$UDID" ] || { echo "no available simulator named '{{sim}}'" >&2; exit 1; }
  echo "$UDID"

# Parse every Maestro flow — no simulator, no emulator, no app build
e2e-flows:
  {{justfile_directory()}}/scripts/check-maestro-flows.sh {{justfile_directory()}}/ddk-rn/example/.maestro

# Build the example app for the iOS simulator (Release)
e2e-ios-build:
  #!/usr/bin/env bash
  set -euo pipefail
  cd {{justfile_directory()}}/ddk-rn/example/ios
  # Release, not Debug, and this is load-bearing: only a release build embeds the
  # JS bundle, which is what lets the flow run with no Metro dev server. Signing
  # is off because this is only ever installed on a simulator.
  xcodebuild \
    -workspace DdkRnExample.xcworkspace \
    -scheme DdkRnExample \
    -configuration Release \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
    build

# Boot the simulator and install the app built by e2e-ios-build
e2e-ios-install:
  #!/usr/bin/env bash
  set -euo pipefail
  cd {{justfile_directory()}}
  APP=$(find ddk-rn/example/ios/build/Build/Products -name 'DdkRnExample.app' -type d | head -1)
  [ -n "$APP" ] || { echo "✗ no .app found — run 'just e2e-ios-build' first"; exit 1; }
  UDID=$(just _sim-udid)
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b
  xcrun simctl install "$UDID" "$APP"
  # Assert it landed on the device the test will drive.
  xcrun simctl get_app_container "$UDID" ddkrn.example >/dev/null \
    || { echo "✗ ddkrn.example is not installed on $UDID"; exit 1; }
  echo "✓ installed $APP on {{sim}} ($UDID)"

# Targeting is not optional here. A bare `maestro test` with a simulator and an
# emulator both up picks one on its own, so this would happily report a pass
# having run the whole flow on Android; and --platform alone still leaves the
# choice open when two simulators are booted. --udid pins it exactly.
#
# Run the flows against the already-installed iOS app (the fast edit loop)
e2e-ios-test:
  #!/usr/bin/env bash
  set -euo pipefail
  UDID=$(just _sim-udid)
  cd {{justfile_directory()}}/ddk-rn/example && maestro --udid "$UDID" test .maestro/

# Full iOS e2e: validate, build, install, run — the local equivalent of CI
e2e-ios:
  just e2e-flows
  just e2e-ios-build
  just e2e-ios-install
  just e2e-ios-test

# arm64-v8a, where CI uses x86_64 — each has to match its host, or the emulator
# runs under full CPU emulation and is unusably slow. API 35 and google_apis do
# match CI. The consequence is that `just e2e-android-build` builds a different
# ABI than CI does, so a local run proves the flow and the bindings, not the
# exact artifact CI ships.
#
# One-time Android setup: emulator, system image and AVD (~1.5GB of downloads)
e2e-android-setup:
  #!/usr/bin/env bash
  set -euo pipefail
  SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  IMAGE="system-images;android-35;google_apis;arm64-v8a"
  # cmdline-tools is installed into the SDK and then used from there. A Homebrew
  # `sdkmanager`/`avdmanager` hard-codes its own SDK root and ignores
  # ANDROID_HOME, so it lists no system images and refuses to create the AVD
  # ("Package path is not valid ... Valid system image paths are: null"). CI
  # invokes cmdline-tools by absolute path inside the SDK for the same reason.
  yes | sdkmanager --sdk_root="$SDK" --install "cmdline-tools;latest" "emulator" "$IMAGE"
  # Prints "Could not load devices from .../devices.xml" and exits 0 — the
  # profile is still applied (config.ini gets hw.device.name=pixel_6).
  echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd \
    -n "{{avd}}" -k "$IMAGE" -d pixel_6 --force
  echo "✓ AVD {{avd}} ready"

# Reverts ddk-rn/android/build.gradle afterwards: passing an ABI to
# `just build-android` rewrites the committed file's abiFilters down to that one
# ABI, which would ship an app that runs on a single architecture. See the
# warning on build-android.
#
# Build the example APK for the emulator (Release)
e2e-android-build:
  #!/usr/bin/env bash
  set -euo pipefail
  cd {{justfile_directory()}}
  just build-android arm64-v8a
  git checkout ddk-rn/android/build.gradle
  cd ddk-rn/example/android
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --console=plain
  APK=app/build/outputs/apk/release/app-release.apk
  # Fail here rather than as a blank screen on the emulator.
  #
  # Listing captured first, not piped into grep: `grep -q` exits at the first
  # match, unzip gets SIGPIPE, and under `pipefail` that fails the recipe even
  # though the bundle is present. CI runs the same assertion without pipefail,
  # so it does not hit this.
  listing=$(unzip -l "$APK")
  grep -q 'assets/index.android.bundle' <<<"$listing" \
    || { echo "✗ APK has no embedded JS bundle"; exit 1; }
  echo "✓ $APK"

# Boot the emulator and install the APK built by e2e-android-build
e2e-android-install:
  #!/usr/bin/env bash
  set -euo pipefail
  cd {{justfile_directory()}}
  APK=ddk-rn/example/android/app/build/outputs/apk/release/app-release.apk
  [ -f "$APK" ] || { echo "✗ no APK — run 'just e2e-android-build' first"; exit 1; }
  if ! adb devices | grep -q 'emulator.*device$'; then
    echo "Booting {{avd}}…"
    # nohup, so the emulator outlives this recipe and is still up for
    # `just e2e-android-test`. A bare `&` dies with the shell's process group in
    # some runners — the same teardown that killed Metro in the first version of
    # the CI e2e stage.
    nohup "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/emulator/emulator -avd "{{avd}}" \
      -no-window -no-snapshot -noaudio -no-boot-anim -gpu swiftshader_indirect \
      >/dev/null 2>&1 &
    adb wait-for-device
    # `adb wait-for-device` returns as soon as adb connects, long before Android
    # is up; installing then fails with a package-manager error.
    until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
      sleep 2
    done
  fi
  adb install -r "$APK"
  echo "✓ installed on the emulator"

# Run the flows against the already-installed Android app (the fast edit loop)
e2e-android-test:
  #!/usr/bin/env bash
  set -euo pipefail
  SERIAL=$(adb devices | awk '/emulator.*device$/ {print $1; exit}')
  [ -n "$SERIAL" ] || { echo "✗ no emulator in adb devices"; exit 1; }
  # Same suppression CI applies, so a local run reproduces it rather than being
  # quietly more fragile (or quietly less) than the pipeline.
  {{justfile_directory()}}/scripts/android-suppress-dialogs.sh "$SERIAL"
  cd {{justfile_directory()}}/ddk-rn/example && maestro --udid "$SERIAL" test .maestro/

# Full Android e2e: validate, build, install, run
e2e-android:
  just e2e-flows
  just e2e-android-build
  just e2e-android-install
  just e2e-android-test

# ====================
# Maintenance
# ====================

# Clean all build artifacts and dependencies
clean:
  # Clean React Native bindings
  cd {{justfile_directory()}}/ddk-rn && rm -rf cpp/ddk_ffi.* cpp/ddk-rn.* cpp/UniffiCallInvoker.h src/ddk_ffi*.ts src/NativeDdkRn.ts ios/DdkRn.xcframework android/src/main/jniLibs lib ios/build android/build example/ios/build example/android/build example/android/app/build example/ios/Pods example/ios/Podfile.lock example/ios/DdkRnExample.xcworkspace src/index.tsx

  # Clean TypeScript/Node.js bindings
  cd {{justfile_directory()}}/ddk-ts && rm -rf node_modules dist platform src
  cd {{justfile_directory()}}/ddk-ts/example && rm -rf node_modules dist

# ====================
# TypeScript (Node.js) Bindings
# ====================

# ddk-ts contains no Rust. `pnpm generate` builds the ddk-ffi cdylib, generates
# the N-API bindings from it into ddk-ts/src, compiles them to dist/, and links
# the host platform package into node_modules so tests and the example resolve
# the library exactly as a consumer does.
#
# Generate + build the TypeScript bindings for the host platform
ts-build:
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm generate

# Build for every published platform (needs the cross toolchains; CI does this per host)
ts-build-all:
    cd {{justfile_directory()}}/ddk-ts && pnpm install && pnpm build

# Run TypeScript example
ts-example:
    cd {{justfile_directory()}}/ddk-ts && pnpm generate
    cd {{justfile_directory()}}/ddk-ts/example && pnpm install && pnpm dev

# Run TypeScript tests
ts-test:
    cd {{justfile_directory()}}/ddk-ts && pnpm test

# ====================
# BAL compatibility suite (compat/)
# ====================
#
# Tests ddk's wire messages and contract lifecycle against
# bitcoin-abstraction-layer + @node-dlc — the stack lygos is migrating away
# from. The BAL side installs from npm (latest published @atomicfinance
# release + the ddk-ts 0.3.42 engine production pairs it with); locally it
# only needs a built ddk-ts (`just ts-build`). The lifecycle/splice suites use
# a regtest bitcoind: a throwaway node is spawned automatically when none is
# reachable; point DDK_COMPAT_RPC_URL/_USER/_PASS at an existing one (e.g. the
# lygos-dev stack on :18443) to reuse it instead. Details in compat/README.md.

# Install the compat suite's dependencies
compat-install:
    cd {{justfile_directory()}}/compat && pnpm install

# Full compat suite: message parity + lifecycle + splice + vectors
compat-test:
    cd {{justfile_directory()}}/compat && pnpm test

# Offline suites only — message parity + committed vectors, no bitcoind
compat-test-messages:
    cd {{justfile_directory()}}/compat && pnpm test:messages

# Regenerate the committed compat vectors AND their ddk-rn example copies
# (example/src/compatVectors.ts + compatReplay.ts). Run after a Rust core
# change makes compat/__test__/vectors.spec.ts fail, then commit all three.
compat-vectors:
    cd {{justfile_directory()}}/compat && pnpm vectors

# ====================
# Release
# ====================

# Publishing happens in CI, not here. Neither package can be built correctly on
# one machine any more: ddk-rn ships prebuilt binaries that need a macOS host for
# the XCFramework and a Linux host with the NDK for the JNI libraries, and ddk-ts
# ships one cdylib per platform. This recipe therefore only bumps versions and
# pushes a tag; .github/workflows/publish.yml does the rest.

# Bump ddk-ts, ddk-rn and ddk-ffi to <version>, commit, tag v<version> and push (CI publishes)
release version:
    node {{justfile_directory()}}/scripts/prep-release.js {{version}}
