#!/usr/bin/env node
// Usage: node scripts/prep-release.js <X.Y.Z[-tag]>
//
// Bumps versions in ddk-ts/package.json, ddk-rn/package.json, and ddk-ffi/Cargo.toml,
// commits, creates tag v<version>, and pushes. CI (.github/workflows/publish.yml)
// takes over on tag push and publishes both npm packages.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('Usage: node scripts/prep-release.js <X.Y.Z[-tag]>');
  process.exit(1);
}

const repoRoot = path.join(__dirname, '..');
const run = (cmd, cwd = repoRoot) => execSync(cmd, { cwd, stdio: 'inherit' });
const read = p => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' });
if (status.trim()) {
  console.error('Working directory not clean. Commit or stash changes first:');
  console.error(status);
  process.exit(1);
}

const bumpPkg = file => {
  const p = path.join(repoRoot, file);
  const pkg = JSON.parse(read(p));
  pkg.version = version;
  write(p, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\u2713 ${file} \u2192 ${version}`);
};
bumpPkg('ddk-ts/package.json');
bumpPkg('ddk-rn/package.json');

const cargoPath = path.join(repoRoot, 'ddk-ffi/Cargo.toml');
const cargo = read(cargoPath).replace(/^version = ".*"/m, `version = "${version}"`);
write(cargoPath, cargo);
console.log(`\u2713 ddk-ffi/Cargo.toml \u2192 ${version}`);

run('git add ddk-ts/package.json ddk-rn/package.json ddk-ffi/Cargo.toml');
run(`git commit -m "chore: release v${version}"`);
run(`git tag v${version}`);
run('git push origin HEAD');
run(`git push origin v${version}`);

console.log(`\n\u2713 Pushed v${version}. CI will publish both packages.`);
