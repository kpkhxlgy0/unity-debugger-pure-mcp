import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredUvVersion = "uv 0.12.0";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "dist", "launcher");
const rawWheel = "unity_debugger_pure_mcp-0.1.0-py3-none-any.whl";
const finalWheel = "unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl";
const sdist = "unity_debugger_pure_mcp-0.1.0.tar.gz";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Launcher artifacts must be built on Windows x64.");
}

const uvVersion = run("uv", ["--version"]).stdout.trim();
if (!/^uv 0\.12\.0(?:\s|$)/.test(uvVersion)) {
  throw new Error(`Launcher builds require ${requiredUvVersion}; found ${uvVersion}.`);
}

run("uv", ["build", "launcher", "--out-dir", "dist/launcher", "--clear"]);
assertArtifacts(new Set([rawWheel, sdist, ".gitignore"]));
run("uvx", [
  "--from",
  "wheel==0.47.0",
  "wheel",
  "tags",
  "--remove",
  "--platform-tag=win_amd64",
  path.join("dist", "launcher", rawWheel),
]);
fs.rmSync(path.join(outputRoot, ".gitignore"), { force: true });
assertArtifacts(new Set([finalWheel, sdist]));
console.log(`Launcher wheel and sdist built in ${path.relative(repositoryRoot, outputRoot)}.`);

function assertArtifacts(expected) {
  const actual = new Set(fs.readdirSync(outputRoot));
  if (
    actual.size !== expected.size ||
    [...actual].some((name) => !expected.has(name))
  ) {
    throw new Error(
      `Unexpected launcher artifacts: ${[...actual].sort().join(", ")}`,
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}):\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}
