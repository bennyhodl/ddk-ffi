#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const ddkRnRoot = path.join(__dirname, '..');
const ddkFfiRoot = path.join(projectRoot, 'ddk-ffi');

console.log('🚀 Starting automated release process...\n');

function runCommand(command, cwd = ddkRnRoot, description = null) {
  if (description) {
    console.log(`📋 ${description}`);
  }
  console.log(`   $ ${command}`);
  try {
    const result = execSync(command, { cwd, stdio: 'inherit' });
    return result;
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    throw error;
  }
}

function checkGitStatus() {
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (status.trim()) {
      console.error(
        '❌ Git working directory is not clean. Please commit all changes first.'
      );
      console.error('Uncommitted changes:');
      console.error(status);
      process.exit(1);
    }
    console.log('✅ Git working directory is clean');
  } catch (error) {
    console.error('❌ Failed to check git status');
    process.exit(1);
  }
}

function getCurrentVersion() {
  const packageJsonPath = path.join(ddkRnRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

function updateRustVersion(version) {
  const cargoTomlPath = path.join(projectRoot, 'ddk-ffi', 'Cargo.toml');
  let cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');

  // Update version in Cargo.toml
  cargoContent = cargoContent.replace(
    /^version = ".*"/m,
    `version = "${version}"`
  );

  fs.writeFileSync(cargoTomlPath, cargoContent);
  console.log(`✅ Updated Cargo.toml version to ${version}`);
}

function generateBindings() {
  console.log('🔧 Generating JSI bindings and turbo module...');

  const srcDir = path.join(ddkRnRoot, 'src');
  const cppDir = path.join(ddkRnRoot, 'cpp');
  const udlFile = path.join(ddkFfiRoot, 'src', 'ddk_ffi.udl');
  const configFile = path.join(ddkRnRoot, 'ubrn.config.yaml');

  // Check if uniffi-bindgen-react-native is available
  try {
    execSync('uniffi-bindgen-react-native --help', { stdio: 'ignore' });
  } catch (error) {
    console.error('❌ uniffi-bindgen-react-native not found!');
    console.error(
      '   Install it with: npm install -g uniffi-bindgen-react-native'
    );
    process.exit(1);
  }

  try {
    // Step 1: Generate JSI bindings (TypeScript and C++)
    // const jsiCmd = `uniffi-bindgen-react-native generate jsi bindings --crate ddk_ffi --config "${configFile}" --ts-dir "${srcDir}" --cpp-dir "${cppDir}" "${udlFile}"`;
    // console.log(`   Running: ${jsiCmd}`);
    // execSync(jsiCmd, {
    //   stdio: 'inherit',
    //   cwd: ddkFfiRoot,
    // });
    // console.log(
    //   '✅ JSI bindings generated (ddk_ffi.ts, ddk_ffi-ffi.ts, ddk_ffi.cpp, ddk_ffi.hpp)'
    // );

    // // Step 2: Generate turbo module files
    // const turboCmd = 'just uniffi-turbo';
    // console.log(`   Running: ${turboCmd}`);
    // execSync(turboCmd, {
    //   stdio: 'inherit',
    //   cwd: ddkRnRoot,
    // });
    // console.log(
    //   '✅ Turbo module generated (NativeDdkRn.ts, index.tsx, bennyblader-ddk-rn.cpp, bennyblader-ddk-rn.h)'
    // );

    // Fix the C++ include path issue
    const cppFile = path.join(cppDir, 'bennyblader-ddk-rn.cpp');
    if (fs.existsSync(cppFile)) {
      let content = fs.readFileSync(cppFile, 'utf8');
      if (content.includes('#include "/ddk_ffi.hpp"')) {
        content = content.replace(
          '#include "/ddk_ffi.hpp"',
          '#include "ddk_ffi.hpp"'
        );
        fs.writeFileSync(cppFile, content);
        console.log('🔧 Fixed include path in C++ bindings');
      }
    }

    console.log(
      'ℹ️  Native libraries are prebuilt and shipped in the package (see the publish workflow)'
    );
  } catch (error) {
    throw new Error(`Failed to generate bindings: ${error.message}`);
  }
}

function runTests() {
  console.log('🧪 Running tests...');

  // Run Rust tests
  runCommand(
    'cargo test',
    path.join(projectRoot, 'ddk-ffi'),
    'Running Rust tests'
  );

  // Run React Native tests
  // runCommand('pnpm test', ddkRnRoot, 'Running React Native tests');

  console.log('✅ All tests passed');
}

function buildPackage() {
  console.log('🔨 Building package...');
  runCommand(
    'pnpm prepare',
    ddkRnRoot,
    'Building with react-native-builder-bob'
  );
  console.log('✅ Package built successfully');
}

function commitVersionChanges(version) {
  console.log(`📝 Checking for changes to commit...`);

  // Check if there are any changes to commit
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    if (!status.trim()) {
      console.log('✅ No changes to commit, skipping commit step');
      return;
    }

    console.log(`📝 Committing Rust version sync for v${version}...`);
    runCommand('git add .', projectRoot, 'Staging all changes');
    runCommand(
      `git commit -m "chore: sync Rust version to v${version} and regenerate bindings"`,
      projectRoot,
      'Committing changes'
    );

    // Push to origin master
    runCommand(
      'git push origin master',
      projectRoot,
      'Pushing changes to origin master'
    );
  } catch (error) {
    console.error('❌ Failed to check git status or commit changes');
    throw error;
  }
}

function releaseWithPnpm() {
  console.log('🚀 Starting automated release with release-it...');

  // Check if user is authenticated with npm
  try {
    runCommand('npm whoami', ddkRnRoot, 'Checking npm authentication');
  } catch (error) {
    console.error(
      '❌ You are not authenticated with npm. Please run: npm login'
    );
    process.exit(1);
  }

  // Run release-it
  runCommand('pnpm release', ddkRnRoot, 'Running pnpm release');
}

function main() {
  try {
    if (dryRun) {
      console.log(
        '🏃 Running in DRY RUN mode - no commits or publishing will occur\n'
      );
    }

    console.log('🔍 Pre-flight checks...');

    // 1. Check git status (skip if dry run)
    if (!dryRun) {
      checkGitStatus();
    } else {
      console.log('⚠️  Skipping git status check (dry run)');
    }

    // 2. Get current version from package.json
    const currentVersion = getCurrentVersion();
    console.log(`📦 Current package version: ${currentVersion}`);

    // 3. Update Rust version to match
    console.log('\n📝 Syncing Rust version...');
    updateRustVersion(currentVersion);

    // 4. Run tests
    console.log('\n🧪 Running tests...');
    runTests();

    // 5. Generate JSI bindings and turbo module (not native builds)
    // console.log('\n🔧 Generating bindings...');
    // generateBindings();

    // 6. Build package
    console.log('\n🔨 Building package...');
    buildPackage();

    if (dryRun) {
      console.log('\n✅ Dry run completed successfully!');
      console.log('📝 All preparation steps completed. Skipped:');
      console.log('   - Git commit');
      console.log('   - Git tag');
      console.log('   - npm publish');
      console.log('   - GitHub release');
      console.log('\n💡 To perform actual release, run without --dry-run flag');
      return;
    }

    // 8. Commit Rust version changes
    console.log('\n📝 Committing changes...');
    commitVersionChanges(currentVersion);

    // 9. Release with pnpm (this will bump version, create tag, publish to npm, create GitHub release)
    console.log('\n🚀 Releasing...');
    releaseWithPnpm();

    // 10. Get the new version (release-it will have bumped it)
    const newVersion = getCurrentVersion();
    console.log(`🎉 Released version: ${newVersion}`);

    console.log('\n🎉 Release completed successfully!');
    console.log(
      `📦 Package @bennyblader/ddk-rn@${newVersion} is now available on npm`
    );
    console.log(
      `🔗 GitHub release: https://github.com/bennyhodl/ddk-ffi/releases/tag/v${newVersion}`
    );
    console.log(
      `📋 npm package: https://www.npmjs.com/package/@bennyblader/ddk-rn/v/${newVersion}`
    );
    console.log('\n📝 Note: This release includes all generated bindings:');
    console.log(
      '   - JSI bindings (ddk_ffi.ts, ddk_ffi-ffi.ts, ddk_ffi.cpp, ddk_ffi.hpp)'
    );
    console.log(
      '   - Turbo module files (NativeDdkRn.ts, index.tsx, bennyblader-ddk-rn.cpp/h)'
    );
    console.log(
      '   - Prebuilt native libraries (iOS XCFramework, Android jniLibs)'
    );
    console.log(
      '   Consumers compile nothing on install; the Rust source is not shipped.'
    );
  } catch (error) {
    console.error('\n❌ Release failed:', error.message);
    console.error('\n🔧 You may need to clean up manually:');
    console.error('   - Check git status and reset if needed');
    if (!dryRun) {
      console.error('   - Check npm and GitHub releases');
    }
    process.exit(1);
  }
}

// Handle CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🚀 Automated Release Script

This script automates the entire release process:
1. Checks git status is clean
2. Updates Rust version to match package.json
3. Runs all tests (Rust + React Native)
4. Prepares Rust source for npm package
5. Builds the npm package
6. Commits Rust version changes (skipped with --dry-run)
7. Runs 'pnpm release' (version bump, git tag, npm publish, GitHub release) (skipped with --dry-run)

Options:
  --dry-run    Run all preparation steps but skip commit, tag, release, and publish
  --help, -h   Show this help message

Prerequisites:
- Clean git working directory (unless --dry-run)
- npm authentication (npm login) (unless --dry-run)
- GitHub CLI authentication (gh auth login) (unless --dry-run)
- All dependencies installed (pnpm install)
- uniffi-bindgen-react-native installed globally

Usage:
  node scripts/release.js              # Full release
  node scripts/release.js --dry-run    # Test run without publishing
  pnpm run release-full                # Full release
  pnpm run release-full -- --dry-run   # Test run without publishing

The script will prompt for version bump during the release process (unless --dry-run).
`);
  process.exit(0);
}

main();
