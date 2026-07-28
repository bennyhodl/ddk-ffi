#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ddkRnRoot = path.join(__dirname, '..');
const projectRoot = path.join(ddkRnRoot, '..');

function runCommand(command, cwd = projectRoot, options = {}) {
  const { silent = false } = options;
  try {
    const result = execSync(command, {
      cwd,
      stdio: silent ? 'pipe' : 'inherit',
      encoding: 'utf8',
    });
    return result;
  } catch (error) {
    if (!silent) {
      console.error(`❌ Command failed: ${command}`);
    }
    throw error;
  }
}

function applyHotFix() {
  console.log('🔧 Applying post-build hot fixes...');

  const cppFile = path.join(ddkRnRoot, 'cpp', 'bennyblader-ddk-rn.cpp');

  // Fix 1: C++ include path
  if (fs.existsSync(cppFile)) {
    let cppContent = fs.readFileSync(cppFile, 'utf8');
    if (cppContent.includes('#include "/ddk_ffi.hpp"')) {
      cppContent = cppContent.replace(
        '#include "/ddk_ffi.hpp"',
        '#include "ddk_ffi.hpp"'
      );
      fs.writeFileSync(cppFile, cppContent);
      console.log('   ✅ Fixed include path in bennyblader-ddk-rn.cpp');
    } else {
      console.log('   ✅ Include path already correct');
    }
  }

  // Fix 2 (REMOVED): this used to inject an `s.xcconfig` LIBRARY_SEARCH_PATHS
  // block into DdkRn.podspec pointing at four XCFramework slices. It is gone
  // deliberately — do not reinstate it:
  //
  //   * `s.vendored_frameworks = "ios/DdkRn.xcframework"` is the supported
  //     CocoaPods mechanism for an XCFramework. CocoaPods selects the right
  //     slice and sets the search paths itself, so the block was redundant.
  //   * Two of the four paths it injected (`ios-x86_64-simulator`, `ios-x86_64`)
  //     never matched a real slice. A 3-target build produced a merged
  //     `ios-arm64_x86_64-simulator`, and the framework now builds only
  //     `ios-arm64` and `ios-arm64-simulator`.
  //   * It hardcoded `$(SRCROOT)/../node_modules/@bennyblader/ddk-rn/...`,
  //     which does not exist under pnpm's layout — the package manager this
  //     project uses.
  //
  // It existed because the XCFramework used to be built on the consumer's
  // machine during postinstall. Now that binaries ship prebuilt in the package,
  // there is nothing to patch around.

  console.log('   ✅ Hot fixes applied and files unstaged');
  console.log();
}

// Export for use in other scripts
module.exports = { applyHotFix };

// Allow running directly
if (require.main === module) {
  console.log('🔧 Running hot fix script...\n');
  applyHotFix();
  console.log('✅ Hot fix completed!\n');
}
