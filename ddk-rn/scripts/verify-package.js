#!/usr/bin/env node

/**
 * Refuse to publish a package that would make consumers compile Rust.
 *
 * This package ships prebuilt native binaries and has no postinstall, so a
 * tarball missing them is not "slower to install" — it is broken, and broken
 * in a way that only shows up later as a CMake or linker error in someone
 * else's app.
 *
 * It is wired as `prepublishOnly` rather than called from a release script
 * because that is the one hook every publish path goes through: `npm publish`,
 * release-it (`just rn-release`), and scripts/unified-release.js (`just
 * release`). The local scripts are the ones that need it most — unified-release
 * skips the iOS build off macOS and swallows Android build failures, so it can
 * reach `npm publish` with binaries missing.
 */

const { execSync } = require('child_process');

// --ignore-scripts so the pack does not re-run `prepare` (bob build); we only
// need the file list, and `prepublishOnly` has already been preceded by it.
const output = execSync('npm pack --dry-run --ignore-scripts 2>&1', {
  cwd: __dirname + '/..',
  encoding: 'utf8',
});

const required = [
  [/ios\/DdkRn\.xcframework\/ios-arm64\/libddk_ffi\.a/, 'iOS device slice'],
  [
    /ios\/DdkRn\.xcframework\/ios-[^/\s]*simulator\/libddk_ffi\.a/,
    'iOS simulator slice',
  ],
  [
    /android\/src\/main\/jniLibs\/arm64-v8a\/libddk_ffi\.so/,
    'Android arm64-v8a shared library',
  ],
];

const missing = required.filter(([pattern]) => !pattern.test(output));

const problems = missing.map(([, label]) => `missing ${label}`);

// A static archive would link fine but multiply the package size ~10x, so it
// is a silent regression rather than a loud one. See android.useSharedLibrary.
if (/jniLibs\/[^/\s]*\/libddk_ffi\.a/.test(output)) {
  problems.push(
    'Android shipped a static archive; expected a shared library (android.useSharedLibrary)'
  );
}

if (/ddk-ffi\/(src|Cargo)/.test(output)) {
  problems.push('Rust source leaked into the tarball');
}

if (problems.length > 0) {
  console.error('\n❌ Refusing to publish @bennyblader/ddk-rn:\n');
  for (const problem of problems) {
    console.error(`   - ${problem}`);
  }
  console.error('\nBuild the native libraries first:');
  console.error('   just build-ios       # requires macOS');
  console.error('   just build-android   # requires the Android NDK');
  console.error(
    '\nBoth are built for you by .github/workflows/publish.yml when you push a'
  );
  console.error('v*.*.* tag, which is the supported way to release.\n');
  process.exit(1);
}

console.log('✅ Package contains prebuilt binaries for iOS and Android');
