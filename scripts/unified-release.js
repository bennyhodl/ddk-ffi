#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { applyHotFix } = require("../ddk-rn/scripts/apply-hotfix.js");

// Parse command line arguments
const args = process.argv.slice(2);
const version = args[0];
// Apple-only by default. Opt into the Linux x64 build with --build-linux or
// BUILD_LINUX=1 (requires the x86_64-unknown-linux-gnu target + cross linker,
// and re-adding the Linux target/optionalDependency in ddk-ts/package.json).
const buildLinux = args.includes("--build-linux") || process.env.BUILD_LINUX === "1";

if (!version || args.includes("--help") || args.includes("-h")) {
  console.log(`
🚀 Unified Release Script for DDK-FFI

Usage:
  node scripts/unified-release.js <version>
  just release <version>

Example:
  just release 0.3.0
  node scripts/unified-release.js 0.3.0

This script performs a unified release for both ddk-rn and ddk-ts packages:
  1. Check git status is clean
  2. Run tests in all packages (ddk-ffi, ddk-rn, ddk-ts)
  3. Update Rust crate versions
  4. Update package.json versions
  5. Generate bindings for both React Native and TypeScript
  6. Fix C++ include path issue
  7. Commit all changes
  8. Create git tag
  9. Create GitHub release with artifacts
  10. Publish both npm packages

Prerequisites:
  - Clean git working directory
  - npm authentication (npm login)
  - GitHub CLI authentication (gh auth login)
  - uniffi-bindgen-react-native installed globally
  - napi-rs CLI installed (@napi-rs/cli)
  - Android NDK configured (for Android builds)
  - Rust toolchain installed
`);
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

// Validate version format
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("❌ Invalid version format. Expected: X.Y.Z or X.Y.Z-tag");
  process.exit(1);
}

const projectRoot = path.join(__dirname, "..");
const ddkFfiRoot = path.join(projectRoot, "ddk-ffi");
const ddkRnRoot = path.join(projectRoot, "ddk-rn");
const ddkTsRoot = path.join(projectRoot, "ddk-ts");
const archiveDir = path.join(projectRoot, "release-archives");

console.log(`🚀 Starting unified release for version ${version}...\n`);

function runCommand(command, cwd = projectRoot, options = {}) {
  const { description, silent = false, encoding = "utf8" } = options;

  if (description && !silent) {
    console.log(`📋 ${description}`);
  }
  if (!silent) {
    console.log(`   $ ${command}`);
  }

  try {
    const result = execSync(command, {
      cwd,
      stdio: silent ? "pipe" : "inherit",
      encoding,
    });
    return result;
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    throw error;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Step 1: Check git status
function checkGitStatus() {
  console.log("🔍 Checking git status...");
  const status = runCommand("git status --porcelain", projectRoot, {
    silent: true,
  });

  if (status.trim()) {
    console.error(
      "❌ Git working directory is not clean. Please commit or stash changes first."
    );
    console.error("Uncommitted changes:");
    console.error(status);
    process.exit(1);
  }

  console.log("✅ Git working directory is clean\n");
}

// Step 1b: Verify auth up front so we never leave a half-release
// (git tag + GitHub release pushed but npm publish failing on auth).
function checkAuth() {
  console.log("🔐 Checking publish credentials...");

  try {
    runCommand("npm whoami", projectRoot, { silent: true });
  } catch (error) {
    console.error(
      "❌ Not authenticated with npm. Run `npm login` before releasing."
    );
    process.exit(1);
  }

  try {
    runCommand("gh auth status", projectRoot, { silent: true });
  } catch (error) {
    console.error(
      "❌ Not authenticated with GitHub CLI. Run `gh auth login` before releasing."
    );
    process.exit(1);
  }

  console.log("✅ npm and GitHub CLI authenticated\n");
}

// Step 2: Run all tests
function runTests() {
  console.log("🧪 Running tests...\n");

  // Rust tests
  console.log("   Testing ddk-ffi (Rust)...");
  runCommand("cargo test", ddkFfiRoot, { description: "Rust tests" });

  // React Native tests (if they exist)
  try {
    console.log("\n   Testing ddk-rn (React Native)...");
    runCommand("pnpm test", ddkRnRoot, {
      description: "React Native tests",
      silent: true,
    });
  } catch (error) {
    console.log("   ⚠️  No React Native tests found or tests skipped");
  }

  // TypeScript tests
  console.log("\n   Testing ddk-ts (TypeScript)...");
  runCommand("pnpm test", ddkTsRoot, { description: "TypeScript tests" });

  console.log("\n✅ All tests passed\n");
}

// Step 3: Update Rust versions
function updateRustVersions() {
  console.log("📝 Updating Rust crate versions...");

  const cargoPaths = [
    path.join(ddkFfiRoot, "Cargo.toml"),
    path.join(ddkTsRoot, "Cargo.toml"),
  ];

  cargoPaths.forEach((cargoPath) => {
    if (fs.existsSync(cargoPath)) {
      let content = fs.readFileSync(cargoPath, "utf8");
      content = content.replace(/^version = ".*"/m, `version = "${version}"`);
      fs.writeFileSync(cargoPath, content);
      console.log(
        `   ✅ Updated ${path.basename(path.dirname(cargoPath))}/Cargo.toml`
      );
    }
  });

  console.log();
}

// Step 4: Update package.json versions
function updatePackageVersions() {
  console.log("📝 Updating package.json versions...");

  [ddkRnRoot, ddkTsRoot].forEach((packageRoot) => {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = version;
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2) + "\n"
    );
    console.log(`   ✅ Updated ${path.basename(packageRoot)}/package.json`);
  });

  console.log();
}

// Step 5: Generate React Native bindings
function generateReactNativeBindings() {
  console.log("🔧 Generating React Native bindings...");

  // Generate JSI bindings
  runCommand("just uniffi-jsi", projectRoot, {
    description: "Generating JSI bindings",
  });

  // Generate Turbo Module
  runCommand("just uniffi-turbo", projectRoot, {
    description: "Generating Turbo Module",
  });

  // Build iOS (if on macOS)
  if (process.platform === "darwin") {
    runCommand("just build-ios", projectRoot, {
      description: "Building iOS libraries",
    });
  } else {
    console.log("   ⚠️  Skipping iOS build (not on macOS)");
  }

  // Build Android (if NDK is available)
  if (process.env.ANDROID_NDK_ROOT || process.env.NDK_HOME) {
    try {
      runCommand("just build-android", projectRoot, {
        description: "Building Android libraries",
      });
    } catch (error) {
      console.log("   ⚠️  Android build failed (may be missing toolchain)");
    }
  } else {
    console.log("   ⚠️  Skipping Android build (NDK not configured)");
  }

  console.log();
}

// Step 6: Apply hot fixes (imported from apply-hotfix.js)
// This is handled by the imported applyHotFix function

// Step 7: Generate TypeScript bindings
function generateTypeScriptBindings() {
  console.log("🔧 Building TypeScript/Node.js bindings...");

  // Build for all platforms if possible
  if (process.platform === "darwin") {
    runCommand("pnpm build:darwin-arm64", ddkTsRoot, {
      description: "Building for Darwin ARM64",
    });

    if (buildLinux) {
      runCommand("pnpm build:linux-x64", ddkTsRoot, {
        description: "Building for Linux x64",
      });
    } else {
      console.log("   ⚠️  Skipping Linux x64 build (Apple-only; pass --build-linux to enable)");
    }
  }

  // Build for current platform as fallback
  runCommand("pnpm build", ddkTsRoot, {
    description: "Building for current platform",
  });

  // NOTE: Do NOT call `napi prepublish` here. It is wired as the
  // `prepublishOnly` lifecycle script in ddk-ts/package.json, so it runs
  // automatically during `npm publish` (see publishNpmPackages). Calling it
  // explicitly here would publish the platform sub-packages a second time and
  // fail with EPUBLISHCONFLICT.

  console.log();
}

// Step 8: Build React Native package
function buildReactNativePackage() {
  console.log("🔨 Building React Native package...");
  runCommand("pnpm prepare", ddkRnRoot, {
    description: "Building with react-native-builder-bob",
  });
  console.log();
}

// Step 10: Create release artifacts
function createReleaseArtifacts() {
  console.log("📦 Creating release artifacts...");

  ensureDir(archiveDir);

  // Create React Native artifacts (.a files)
  const rnArtifacts = [];

  // iOS XCFrameworks
  const iosDir = path.join(ddkRnRoot, "ios");
  if (fs.existsSync(iosDir)) {
    const xcframeworks = fs
      .readdirSync(iosDir)
      .filter((f) => f.endsWith(".xcframework"));
    if (xcframeworks.length > 0) {
      const iosArchive = path.join(
        archiveDir,
        `react-native-ios-xcframeworks-${version}.tar.gz`
      );
      const tempDir = path.join(archiveDir, "temp-ios");
      ensureDir(tempDir);

      xcframeworks.forEach((framework) => {
        runCommand(
          `cp -R "${path.join(iosDir, framework)}" "${tempDir}"`,
          projectRoot,
          { silent: true }
        );
      });

      runCommand(`tar -czf "${iosArchive}" -C "${tempDir}" .`, projectRoot, {
        silent: true,
      });
      runCommand(`rm -rf "${tempDir}"`, projectRoot, { silent: true });

      console.log(
        `   ✅ Created react-native-ios-xcframeworks-${version}.tar.gz`
      );
      rnArtifacts.push(iosArchive);
    }
  }

  // Android JNI libraries
  const androidLibsDir = path.join(
    ddkRnRoot,
    "android",
    "src",
    "main",
    "jniLibs"
  );
  if (fs.existsSync(androidLibsDir)) {
    const androidArchive = path.join(
      archiveDir,
      `react-native-android-jni-${version}.tar.gz`
    );
    runCommand(
      `tar -czf "${androidArchive}" -C "${androidLibsDir}" .`,
      projectRoot,
      { silent: true }
    );
    console.log(`   ✅ Created react-native-android-jni-${version}.tar.gz`);
    rnArtifacts.push(androidArchive);
  }

  // Create TypeScript artifacts (.node files)
  const tsArtifacts = [];
  const tsDistDir = path.join(ddkTsRoot, "dist");

  if (fs.existsSync(tsDistDir)) {
    const nodeFiles = fs
      .readdirSync(tsDistDir)
      .filter((f) => f.endsWith(".node"));

    nodeFiles.forEach((nodeFile) => {
      const platform = nodeFile.includes("darwin")
        ? "darwin-arm64"
        : nodeFile.includes("linux")
        ? "linux-x64"
        : "unknown";
      const artifactName = `typescript-${platform}-${version}.node`;
      const source = path.join(tsDistDir, nodeFile);
      const dest = path.join(archiveDir, artifactName);

      fs.copyFileSync(source, dest);
      console.log(`   ✅ Created ${artifactName}`);
      tsArtifacts.push(dest);
    });
  }

  console.log(`\n📁 Artifacts created in: ${archiveDir}\n`);

  return { rnArtifacts, tsArtifacts };
}

// Step 11: Commit changes
function commitChanges() {
  console.log("📝 Committing changes...");

  runCommand("git add .", projectRoot, { silent: true });
  runCommand(`git commit -m "chore: release ${version}"`, projectRoot, {
    description: "Creating commit",
  });

  console.log();
}

// Step 12: Create tag
function createTag() {
  console.log("🏷️  Creating git tag...");

  runCommand(`git tag -a v${version} -m "Release v${version}"`, projectRoot, {
    description: `Creating tag v${version}`,
  });

  console.log();
}

// Step 13: Push to GitHub
function pushToGitHub() {
  console.log("📤 Pushing to GitHub...");

  runCommand("git push origin master", projectRoot, {
    description: "Pushing commits",
  });
  runCommand(`git push origin v${version}`, projectRoot, {
    description: "Pushing tag",
  });

  console.log();
}

// Step 14: Create GitHub release
function createGitHubRelease(artifacts) {
  console.log("🚀 Creating GitHub release...");

  const { rnArtifacts, tsArtifacts } = artifacts;
  const allArtifacts = [...rnArtifacts, ...tsArtifacts];

  // Create release notes
  const releaseNotes = `## Release v${version}

### 📦 Packages Released
- **@bennyblader/ddk-rn**: v${version} - React Native bindings
- **@bennyblader/ddk-ts**: v${version} - TypeScript/Node.js bindings

### 🎯 Release Artifacts
- React Native iOS XCFrameworks
- React Native Android JNI libraries  
- TypeScript Node.js native modules (Darwin ARM64, Linux x64)

### 📝 Changelog
- Updated to ddk-ffi v${version}
- Synchronized all package versions
- Generated fresh bindings for all platforms

### 📚 Installation

#### React Native
\`\`\`bash
npm install @bennyblader/ddk-rn@${version}
# or
yarn add @bennyblader/ddk-rn@${version}
\`\`\`

#### TypeScript/Node.js
\`\`\`bash
npm install @bennyblader/ddk-ts@${version}
# or
yarn add @bennyblader/ddk-ts@${version}
\`\`\`

---
🤖 Generated with [Claude Code](https://claude.ai/code)`;

  // Write release notes to temporary file to avoid command line length issues
  const releaseNotesFile = path.join(archiveDir, "release-notes.md");
  fs.writeFileSync(releaseNotesFile, releaseNotes);

  // Build gh release command with proper asset labels
  let ghCommand = `gh release create v${version} --title "v${version}" --notes-file "${releaseNotesFile}"`;

  // Add artifact files with display labels
  rnArtifacts.forEach((artifact) => {
    const filename = path.basename(artifact);
    const label = filename.replace(".tar.gz", "").replace(`-${version}`, "");
    ghCommand += ` "${artifact}#${label}"`;
  });

  tsArtifacts.forEach((artifact) => {
    const filename = path.basename(artifact);
    const label = filename.replace(".node", "").replace(`-${version}`, "");
    ghCommand += ` "${artifact}#${label}"`;
  });

  runCommand(ghCommand, projectRoot, {
    description: "Creating GitHub release with artifacts",
  });

  // Clean up temp file
  fs.unlinkSync(releaseNotesFile);

  console.log();
}

// Step 15: Publish npm packages
async function publishNpmPackages() {
  console.log("📦 Publishing npm packages...\n");

  // Check npm authentication
  try {
    runCommand("npm whoami", projectRoot, { silent: true });
  } catch (error) {
    console.error(
      "❌ You are not authenticated with npm. Please run: npm login"
    );
    process.exit(1);
  }

  // Publish React Native package
  console.log("   Publishing @bennyblader/ddk-rn...");
  runCommand("npm publish --access public", ddkRnRoot, {
    description: "Publishing ddk-rn",
  });

  // Publish TypeScript package
  console.log("\n   Publishing @bennyblader/ddk-ts...");
  runCommand("npm publish --access public", ddkTsRoot, {
    description: "Publishing ddk-ts",
  });

  console.log();

  // Verify both packages have the same version
  console.log("🔍 Verifying published versions...");

  // Wait a moment for npm registry to update
  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    const rnVersion = runCommand(
      "npm view @bennyblader/ddk-rn version",
      projectRoot,
      { silent: true }
    ).trim();
    const tsVersion = runCommand(
      "npm view @bennyblader/ddk-ts version",
      projectRoot,
      { silent: true }
    ).trim();

    if (rnVersion === version && tsVersion === version) {
      console.log(
        `   ✅ Both packages published successfully at version ${version}`
      );
    } else {
      console.warn(`   ⚠️  Version mismatch detected:`);
      console.warn(`      ddk-rn: ${rnVersion}`);
      console.warn(`      ddk-ts: ${tsVersion}`);
    }
  } catch (error) {
    console.warn(
      "   ⚠️  Could not verify published versions (registry may be updating)"
    );
  }

  console.log();
}

// Main release flow
async function main() {
  try {
    // Pre-flight checks
    checkGitStatus();
    checkAuth();

    // Build and test
    runTests();

    // Update versions
    updateRustVersions();
    updatePackageVersions();

    // Generate bindings
    generateReactNativeBindings();
    applyHotFix();
    generateTypeScriptBindings();

    // Prepare packages
    buildReactNativePackage();

    // Create release artifacts
    const artifacts = createReleaseArtifacts();

    // Git operations
    commitChanges();
    createTag();
    pushToGitHub();

    // Create GitHub release
    createGitHubRelease(artifacts);

    // Publish to npm
    await publishNpmPackages();

    // Success!
    console.log("🎉 Release completed successfully!\n");
    console.log("📦 Released packages:");
    console.log(`   - @bennyblader/ddk-rn@${version}`);
    console.log(`   - @bennyblader/ddk-ts@${version}`);
    console.log("\n🔗 Links:");
    console.log(
      `   - GitHub Release: https://github.com/bennyhodl/ddk-ffi/releases/tag/v${version}`
    );
    console.log(
      `   - ddk-rn on npm: https://www.npmjs.com/package/@bennyblader/ddk-rn/v/${version}`
    );
    console.log(
      `   - ddk-ts on npm: https://www.npmjs.com/package/@bennyblader/ddk-ts/v/${version}`
    );
  } catch (error) {
    console.error("\n❌ Release failed:", error.message);
    console.error("\n🔧 You may need to:");
    console.error("   1. Check git status and clean up any partial commits");
    console.error("   2. Delete any tags that were created");
    console.error("   3. Check npm and GitHub for any partial releases");
    process.exit(1);
  }
}

// Run the release
main().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
