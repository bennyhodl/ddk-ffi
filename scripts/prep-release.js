#!/usr/bin/env node
// Cut a release for the ddk-rn + ddk-ts npm packages.
//
//   node scripts/prep-release.js                 # patch bump  (0.3.38 -> 0.3.39)
//   node scripts/prep-release.js --minor         # minor bump  (0.3.38 -> 0.4.0)
//   node scripts/prep-release.js --major         # major bump  (0.3.38 -> 1.0.0)
//   node scripts/prep-release.js 0.4.0-rc.1      # explicit version (overrides bump flag)
//   node scripts/prep-release.js --minor --dry   # validate the gates, mutate nothing
//   node scripts/prep-release.js --yes           # skip the confirmation prompt
//
// This script is only a *trigger*: it bumps the version in ddk-ts/package.json,
// ddk-rn/package.json, and ddk-ffi/Cargo.toml, commits, tags v<version>, and
// pushes. The tag push fires .github/workflows/publish.yml, which builds the
// native binaries on CI runners and publishes both npm packages with provenance.
// Because the publish is remote and irreversible, the preflight gates below make
// sure we only ever tag a commit that is up to date and already green on CI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("node:readline/promises");

const BASE_BRANCH = "master";
const RELEASES_DIR = "releases";
// Workflows that must be green on the commit we're releasing. These run on every
// push to master (see .github/workflows/*.yml).
const REQUIRED_WORKFLOWS = ["ddk-ffi CI", "ddk-rn CI", "ddk-ts CI"];

const repoRoot = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => fs.writeFileSync(p, s);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(read(__filename).split("\n").slice(1, 16).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}
const dryRun = args.includes("--dry");
const skipConfirm = args.includes("--yes") || args.includes("-y");
const bumpKind = args.includes("--major")
  ? "major"
  : args.includes("--minor")
  ? "minor"
  : "patch";
// First non-flag argument is treated as an explicit version override.
const explicitVersion = args.find((a) => !a.startsWith("-"));

if (explicitVersion && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(explicitVersion)) {
  console.error("❌ Invalid version format. Use X.Y.Z or X.Y.Z-tag (e.g. 0.4.0 or 0.4.0-rc.1)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Run a command and capture its trimmed stdout. `allowFailure` returns null on a
// non-zero exit instead of throwing.
function cap(cmd, { allowFailure = false } = {}) {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (error) {
    if (allowFailure) return null;
    console.error(`❌ Command failed: ${cmd}`);
    console.error(error.message);
    process.exit(1);
  }
}

// Run a command inheriting stdio. A no-op (logged) during --dry.
function run(cmd) {
  if (dryRun) {
    console.log(`   [DRY RUN] ${cmd}`);
    return;
  }
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

const TS_PKG = "ddk-ts/package.json";
const RN_PKG = "ddk-rn/package.json";
const FFI_CARGO = "ddk-ffi/Cargo.toml";

// Read the current version from the three files that must stay in lockstep and
// make sure they already agree — a pre-existing mismatch is a bug we shouldn't
// paper over by bumping on top of it.
function currentVersion() {
  const tsVersion = JSON.parse(read(path.join(repoRoot, TS_PKG))).version;
  const rnVersion = JSON.parse(read(path.join(repoRoot, RN_PKG))).version;
  const cargoMatch = read(path.join(repoRoot, FFI_CARGO)).match(/^version = "(.*)"$/m);
  const cargoVersion = cargoMatch && cargoMatch[1];

  const all = { [TS_PKG]: tsVersion, [RN_PKG]: rnVersion, [FFI_CARGO]: cargoVersion };
  const distinct = [...new Set(Object.values(all))];
  if (distinct.length !== 1) {
    console.error("❌ Version files are out of sync; fix them before releasing:");
    for (const [file, v] of Object.entries(all)) console.error(`   ${file}: ${v}`);
    process.exit(1);
  }
  return distinct[0];
}

// Compute the next version from a bump keyword. Drops any pre-release suffix.
function nextVersion(cur, kind) {
  const [maj, min, pat] = cur.split("-")[0].split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// Gate 1: working tree is clean.
function checkGitClean() {
  console.log("📋 Checking git status...");
  const status = cap("git status --porcelain");
  if (status) {
    if (!dryRun) {
      console.error("❌ Git working directory is not clean. Commit or stash first:");
      console.error(status);
      process.exit(1);
    }
    console.warn("⚠️  Working directory is not clean (ignored in dry run)");
  } else {
    console.log("✅ Working directory is clean");
  }
}

// Gate 2: local HEAD is not behind origin/<base>, so we tag the latest commit.
function checkUpToDate() {
  const branch = cap("git rev-parse --abbrev-ref HEAD");
  if (branch !== BASE_BRANCH) {
    const msg = `On branch '${branch}', not '${BASE_BRANCH}'. Releases are cut from ${BASE_BRANCH}.`;
    if (!dryRun) {
      console.error(`❌ ${msg}`);
      process.exit(1);
    }
    console.warn(`⚠️  ${msg} (ignored in dry run)`);
  }

  console.log(`🔄 Fetching origin/${BASE_BRANCH}...`);
  cap(`git fetch origin ${BASE_BRANCH}`);
  const behind = cap(`git rev-list HEAD..origin/${BASE_BRANCH} --count`);
  if (behind !== "0") {
    if (!dryRun) {
      console.error(`❌ Branch is ${behind} commits behind origin/${BASE_BRANCH}. Pull first.`);
      process.exit(1);
    }
    console.warn(`⚠️  Branch is ${behind} commits behind origin/${BASE_BRANCH} (ignored in dry run)`);
  } else {
    console.log(`✅ Up to date with origin/${BASE_BRANCH}`);
  }
}

// Gate 3: every required workflow has a completed, successful run for the exact
// commit we're about to release. We gate on origin/<base> (the commit CI ran on)
// rather than local HEAD so the check is meaningful even if HEAD diverged.
function checkCi() {
  console.log("🔍 Checking CI status...");
  if (!cap("gh --version", { allowFailure: true })) {
    const msg = "GitHub CLI (gh) not found — cannot verify CI is green.";
    if (!dryRun) {
      console.error(`❌ ${msg} Install with: brew install gh`);
      process.exit(1);
    }
    console.warn(`⚠️  ${msg} (ignored in dry run)`);
    return;
  }

  const targetSha = cap(`git rev-parse origin/${BASE_BRANCH}`);
  console.log(`   Releasing commit ${targetSha.substring(0, 7)} on ${BASE_BRANCH}`);

  const raw = cap(
    `gh run list --branch ${BASE_BRANCH} --limit 40 ` +
      `--json status,conclusion,headSha,workflowName`,
    { allowFailure: true }
  );
  const runs = raw ? JSON.parse(raw).filter((r) => r.headSha === targetSha) : [];

  const problems = [];
  for (const wf of REQUIRED_WORKFLOWS) {
    const wfRuns = runs.filter((r) => r.workflowName === wf);
    if (wfRuns.length === 0) {
      problems.push(`${wf}: no run found for this commit (has CI started?)`);
    } else if (wfRuns.some((r) => r.status !== "completed")) {
      problems.push(`${wf}: still in progress`);
    } else if (wfRuns.some((r) => r.conclusion !== "success")) {
      const bad = wfRuns.find((r) => r.conclusion !== "success");
      problems.push(`${wf}: ${bad.conclusion}`);
    }
  }

  if (problems.length) {
    if (!dryRun) {
      console.error("❌ CI is not green for this commit:");
      for (const p of problems) console.error(`   - ${p}`);
      process.exit(1);
    }
    console.warn("⚠️  CI is not green for this commit (ignored in dry run):");
    for (const p of problems) console.warn(`   - ${p}`);
  } else {
    console.log("✅ All required workflows are green for this commit");
  }
}

// Generate Claude-authored release notes into releases/<version>-RELEASE.md and
// return the repo-relative path. This runs locally (where the `claude` CLI is
// available and authenticated) so CI needs no API key — publish.yml reads the
// committed file for the GitHub release body. Falls back to a git-log template
// if `claude` isn't installed or returns nothing.
function generateReleaseNotes(version) {
  const relRepoPath = `${RELEASES_DIR}/${version}-RELEASE.md`;
  const relDir = path.join(repoRoot, RELEASES_DIR);
  const relFile = path.join(relDir, `${version}-RELEASE.md`);

  if (fs.existsSync(relFile)) {
    console.log(`   ✅ Notes already exist at ${relRepoPath}`);
    return relRepoPath;
  }

  const lastTag = cap("git describe --tags --abbrev=0", { allowFailure: true });
  const range = lastTag ? `${lastTag}..HEAD` : "";
  const commits =
    (range ? cap(`git log ${range} --oneline`) : cap("git log --oneline -20")) ||
    "(no commits)";
  const diffstat = range ? cap(`git diff ${range} --stat`, { allowFailure: true }) || "" : "";

  if (!fs.existsSync(relDir)) fs.mkdirSync(relDir, { recursive: true });

  const prompt = `Generate professional release notes for v${version} of the DDK FFI project, which publishes two npm packages: @bennyblader/ddk-rn (React Native UniFFI bindings) and @bennyblader/ddk-ts (TypeScript/Node.js napi bindings).

Commits since ${lastTag || "the start"}:
${commits}

File changes:
${diffstat}

Write clean GitHub-release markdown with: a one-paragraph summary, a Breaking Changes section (only if there are any), Features (commits with feat:), Fixes (commits with fix:), Other notable changes, and an Installation section showing:
  npm install @bennyblader/ddk-rn@${version}
  npm install @bennyblader/ddk-ts@${version}
Be concise but informative. Do not invent changes that aren't in the commits. Output only the markdown, no preamble.`;

  if (cap("command -v claude", { allowFailure: true })) {
    const promptFile = path.join(os.tmpdir(), `ddk-release-prompt-${version}.txt`);
    fs.writeFileSync(promptFile, prompt);
    const out = cap(`claude -p "$(cat ${promptFile})"`, { allowFailure: true });
    fs.unlinkSync(promptFile);
    if (out) {
      fs.writeFileSync(relFile, out.endsWith("\n") ? out : out + "\n");
      console.log(`   ✅ Claude-generated notes → ${relRepoPath}`);
      return relRepoPath;
    }
    console.warn("   ⚠️  Claude returned nothing — using git-log template");
  } else {
    console.warn("   ⚠️  `claude` CLI not found — using git-log template");
  }

  const fallback =
    `# v${version}\n\n## Changes\n\n\`\`\`\n${commits}\n\`\`\`\n\n` +
    `## Installation\n\n\`\`\`bash\nnpm install @bennyblader/ddk-rn@${version}\n` +
    `npm install @bennyblader/ddk-ts@${version}\n\`\`\`\n`;
  fs.writeFileSync(relFile, fallback);
  console.log(`   ✅ Template notes → ${relRepoPath}`);
  return relRepoPath;
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------
async function main() {
  const cur = currentVersion();
  const version = explicitVersion || nextVersion(cur, bumpKind);

  console.log(
    `\n🚀 Release: ${cur} → ${version} (${explicitVersion ? "explicit" : bumpKind})` +
      `${dryRun ? " — DRY RUN" : ""}\n`
  );

  // Preflight gates (cheap, fail fast, before anything irreversible).
  checkGitClean();
  checkUpToDate();
  checkCi();

  if (!dryRun && !skipConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n❓ Tag v${version} and trigger the npm publish on CI? [y/N] `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // Generate release notes (committed with the bump so CI can read them).
  console.log("\n📝 Generating release notes...");
  let notesPath = null;
  if (dryRun) {
    console.log(`   [DRY RUN] would generate ${RELEASES_DIR}/${version}-RELEASE.md`);
  } else {
    notesPath = generateReleaseNotes(version);
  }

  // Bump the three lockstep files.
  console.log("\n📝 Bumping versions...");
  for (const file of [TS_PKG, RN_PKG]) {
    if (dryRun) {
      console.log(`   [DRY RUN] ${file} → ${version}`);
      continue;
    }
    const p = path.join(repoRoot, file);
    const pkg = JSON.parse(read(p));
    pkg.version = version;
    write(p, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`   ✅ ${file} → ${version}`);
  }
  if (dryRun) {
    console.log(`   [DRY RUN] ${FFI_CARGO} → ${version}`);
  } else {
    const cargoPath = path.join(repoRoot, FFI_CARGO);
    write(cargoPath, read(cargoPath).replace(/^version = ".*"/m, `version = "${version}"`));
    console.log(`   ✅ ${FFI_CARGO} → ${version}`);
  }

  // Commit, tag, push. The tag push triggers publish.yml.
  console.log("\n📤 Committing, tagging, and pushing...");
  const toAdd = [TS_PKG, RN_PKG, FFI_CARGO, notesPath].filter(Boolean).join(" ");
  run(`git add ${toAdd}`);
  run(`git commit -m "chore: release v${version}"`);
  run(`git tag v${version}`);
  run("git push origin HEAD");
  run(`git push origin v${version}`);

  if (dryRun) {
    console.log("\n🎉 Dry run complete. To perform the real release:");
    console.log(`   node scripts/prep-release.js ${explicitVersion ? version : `--${bumpKind}`}`);
    return;
  }

  console.log(`\n🎉 Tagged and pushed v${version}.`);
  console.log("   CI (publish.yml) will: build native binaries → publish both npm packages →");
  console.log(`   create the GitHub release from ${notesPath} with the .node binaries attached.`);
  console.log(`   Watch it: gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId -q '.[0].databaseId')`);
}

main().catch((error) => {
  console.error("\n❌ Release failed:", error.message);
  process.exit(1);
});
