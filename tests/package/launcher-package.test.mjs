import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const artifactRoot = path.join(repositoryRoot, "dist", "launcher");
const wheel = path.join(
  artifactRoot,
  "unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl",
);
const sdist = path.join(
  artifactRoot,
  "unity_debugger_pure_mcp-0.1.0.tar.gz",
);

test("launcher builds exactly one audited Windows wheel and one sdist", {
  timeout: 90_000,
}, () => {
  runNpm("build:launcher");
  runNpm("verify:launcher");

  assert.deepEqual(
    fs.readdirSync(artifactRoot).sort(),
    [path.basename(sdist), path.basename(wheel)].sort(),
  );
  assert.equal(fs.statSync(wheel).isFile(), true);
  assert.equal(fs.statSync(sdist).isFile(), true);
});

test("local wheel launched through uvx reaches the real Host and all 19 tools", {
  timeout: 90_000,
}, () => {
  if (!fs.existsSync(wheel)) {
    runNpm("build:launcher");
  }
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/integration/externalLauncher.integration.test.ts",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MCP_LAUNCHER_WHEEL: wheel,
        UV_LINK_MODE: "copy",
        UV_NO_PROGRESS: "1",
      },
      timeout: 80_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `Local wheel integration failed:\n${result.stdout}\n${result.stderr}`,
  );
});

function runNpm(script) {
  const npmCli = process.env.npm_execpath ?? path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const result = spawnSync(process.execPath, [npmCli, "run", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 80_000,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${script} failed:\n${result.stdout}\n${result.stderr}`,
  );
}
