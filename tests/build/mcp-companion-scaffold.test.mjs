import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

test("repository root is the dependent Windows MCP extension", () => {
  const manifest = readJson("package.json");

  assert.equal(manifest.publisher, "kpk");
  assert.equal(manifest.name, "unity-debugger-pure-mcp");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(
    manifest.repository.url,
    "https://github.com/kpkhxlgy0/unity-debugger-pure-mcp.git",
  );
  assert.equal(manifest.engines.vscode, "^1.101.0");
  assert.equal(manifest.devDependencies["@types/vscode"], "1.101.0");
  assert.deepEqual(manifest.workspaces, ["server"]);
  assert.deepEqual(manifest.activationEvents, []);
  assert.deepEqual(manifest.extensionDependencies, [
    "kpk.unity-debugger-pure",
  ]);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.deepEqual(manifest.os, ["win32"]);
  assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [
    {
      id: "unity-debugger-pure-mcp.server",
      label: "Unity Debugger Pure MCP",
    },
  ]);
  assert.equal(fs.existsSync("src/extension.ts"), true);
  assert.equal(fs.existsSync("server/src/server.ts"), true);
  assert.equal(fs.existsSync("tests/extension/vscode-1.101-boundary.ts"), true);
  assert.equal(fs.existsSync("mcp-extension"), false);
  assert.equal(fs.existsSync("mcp-server"), false);
});

test("only the private server workspace loads MCP runtime dependencies", () => {
  const extension = readJson("package.json");
  const server = readJson("server/package.json");

  assert.equal(extension.dependencies, undefined);
  assert.equal(server.private, true);
  assert.equal(server.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
  assert.equal(server.dependencies.zod, "4.4.3");
});

test("TypeScript programs isolate VS Code and server declarations", () => {
  const extension = readJson("tsconfig.json");
  const server = readJson("server/tsconfig.json");

  assert.equal(extension.compilerOptions.skipLibCheck, undefined);
  assert.deepEqual(extension.compilerOptions.types, [
    "node",
    "vscode",
    "vitest/globals",
  ]);
  assert.deepEqual(extension.include, [
    "src/" + "**" + "/*.ts",
    "tests/extension/" + "**" + "/*.ts",
    "tests/integration/" + "**" + "/*.ts",
    "vitest.config.ts",
    "esbuild.mjs",
  ]);
  assert.equal(server.extends, "../tsconfig.json");
  assert.deepEqual(server.compilerOptions.types, ["node"]);
  assert.deepEqual(server.include, [
    "typecheck-anchor.d.ts",
    "src/" + "**" + "/*.ts",
    "../tests/server/" + "**" + "/*.ts",
  ]);
});

test("normal scripts typecheck and test both standalone programs", () => {
  const scripts = readJson("package.json").scripts;

  assert.equal(scripts["typecheck:extension"], "tsc -p tsconfig.json");
  assert.equal(scripts["typecheck:server"], "tsc -p server/tsconfig.json");
  assert.equal(
    scripts.typecheck,
    "npm run typecheck:extension && npm run typecheck:server",
  );
  assert.equal(scripts["test:extension"], "vitest run tests/extension");
  assert.equal(scripts["test:server"], "vitest run tests/server");
  assert.equal(scripts["test:integration"], "vitest run tests/integration");
});

test("lockfile pins stable extension and server workspace dependencies", () => {
  const lock = readJson("package-lock.json");

  assert.equal(lock.packages[""].engines.vscode, "^1.101.0");
  assert.equal(
    lock.packages[""].devDependencies["@types/vscode"],
    "1.101.0",
  );
  assert.equal(lock.packages["node_modules/@types/vscode"].version, "1.101.0");
  assert.equal(
    lock.packages.server.dependencies["@modelcontextprotocol/sdk"],
    "1.30.0",
  );
  assert.equal(lock.packages.server.dependencies.zod, "4.4.3");
  assert.equal(
    lock.packages["node_modules/@modelcontextprotocol/sdk"].version,
    "1.30.0",
  );
  assert.equal(lock.packages["node_modules/zod"].version, "4.4.3");
});

test("Git ignores generated outputs but keeps product inputs visible", () => {
  for (const generated of [
    "node_modules/example.js",
    "dist/extension.cjs",
    "coverage/report.json",
    "cache.tsbuildinfo",
  ]) {
    assert.equal(isIgnored(generated), true, `${generated} was not ignored`);
  }
  for (const productInput of [
    "src/extension.ts",
    "server/src/server.ts",
    "tests/extension/extension.test.ts",
    "scripts/build-mcp-bridge.mjs",
    "docs/repository-split-provenance.json",
    "runtime-inventory.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(
      isIgnored(productInput),
      false,
      `${productInput} was unexpectedly ignored`,
    );
  }
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isIgnored(file) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", "--", file],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined);
  assert.ok(
    result.status === 0 || result.status === 1,
    `git check-ignore failed for ${file}: ${result.stderr}`,
  );
  return result.status === 0;
}
