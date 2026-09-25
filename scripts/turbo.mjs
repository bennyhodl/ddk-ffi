// Native outputs depend on tools outside pnpm's lockfile. Hash their identities
// before Turbo decides whether it can restore a build from another machine.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout + result.stderr : null;
};
const config = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const sdkHome =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  resolve(homedir(), "Library/Android/sdk");
const ndkHome =
  process.env.ANDROID_NDK_HOME || resolve(sdkHome, "ndk/27.1.12297006");
const identity = {
  platform: process.platform,
  arch: process.arch,
  os: release(),
  node: process.version,
  rust: version("rustc", ["-vV"]),
  cc: version(process.env.CC || "cc", ["--version"]),
  xcode:
    process.platform === "darwin" ? version("xcodebuild", ["-version"]) : null,
  sdks:
    process.platform === "darwin" ? version("xcodebuild", ["-showsdks"]) : null,
  java: version("java", ["-version"]),
  cargoNdk: version("cargo", ["ndk", "--version"]),
  cocoapods:
    process.platform === "darwin" ? version("pod", ["--version"]) : null,
  cargoConfig: config(
    resolve(
      process.env.CARGO_HOME || resolve(homedir(), ".cargo"),
      "config.toml",
    ),
  ),
  ndk: config(resolve(ndkHome, "source.properties")),
  wasm: [
    process.env.WASM_CC,
    process.env.WASM_AR,
    "/opt/homebrew/opt/llvm/bin/clang",
    "/opt/homebrew/opt/llvm/bin/llvm-ar",
    "/usr/local/opt/llvm/bin/clang",
    "/usr/local/opt/llvm/bin/llvm-ar",
    "/usr/bin/clang",
    "/usr/bin/llvm-ar",
  ]
    .filter(Boolean)
    .map((tool) => [tool, version(tool, ["--version"])]),
};
const result = spawnSync(
  resolve(root, "node_modules/.bin/turbo"),
  process.argv.slice(2),
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(existsSync(sdkHome) ? { ANDROID_HOME: sdkHome } : {}),
      ...(existsSync(ndkHome) ? { ANDROID_NDK_HOME: ndkHome } : {}),
      DDK_TOOLCHAIN: createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex"),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
