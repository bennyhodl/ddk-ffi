#!/usr/bin/env node
// Usage: node scripts/prep-release.js <X.Y.Z[-tag]>
//
// Bumps versions in ddk-ts/package.json, ddk-rn/package.json, both Cargo.tomls
// and both Cargo.locks, commits, creates tag v<version>, and pushes. CI
// (.github/workflows/publish.yml) takes over on tag push and publishes both npm
// packages.
//
// The lockfiles matter: each records its own crate's version, so bumping only
// Cargo.toml leaves the release commit internally inconsistent and the next
// `cargo build` rewrites the lock — which then blocks the *following* release,
// because this script refuses a dirty tree. Both were stale after v0.4.0.

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

// Only the [package] version at the top of the file \u2014 later `version = "..."`
// lines belong to dependencies.
const bumpCargoToml = file => {
  const p = path.join(repoRoot, file);
  const out = read(p).replace(/^version = ".*"/m, `version = "${version}"`);
  write(p, out);
  console.log(`\u2713 ${file} \u2192 ${version}`);
};
bumpCargoToml('ddk-ffi/Cargo.toml');
bumpCargoToml('ddk-ts/Cargo.toml');

// Rewrite the `version` that follows a given `name = "<crate>"` entry. Done by
// regex rather than by invoking cargo so the release path stays offline, fast,
// and incapable of re-resolving unrelated dependencies. ddk_ffi appears in
// ddk-ts's lockfile too, as a path dependency.
const bumpCargoLock = (file, crates) => {
  const p = path.join(repoRoot, file);
  let out = read(p);
  for (const crate of crates) {
    const re = new RegExp(`(name = "${crate}"\\nversion = )"[^"]*"`);
    if (!re.test(out)) {
      console.error(`\u2717 ${file}: no lock entry for ${crate}`);
      process.exit(1);
    }
    out = out.replace(re, `$1"${version}"`);
  }
  write(p, out);
  console.log(`\u2713 ${file} \u2192 ${version} (${crates.join(', ')})`);
};
bumpCargoLock('ddk-ffi/Cargo.lock', ['ddk_ffi']);
bumpCargoLock('ddk-ts/Cargo.lock', ['ddk_ts', 'ddk_ffi']);

run(
  'git add ddk-ts/package.json ddk-rn/package.json ' +
    'ddk-ffi/Cargo.toml ddk-ffi/Cargo.lock ddk-ts/Cargo.toml ddk-ts/Cargo.lock'
);
run(`git commit -m "chore: release v${version}"`);
run(`git tag v${version}`);
run('git push origin HEAD');
run(`git push origin v${version}`);

console.log(`\n\u2713 Pushed v${version}. CI will publish both packages.`);
