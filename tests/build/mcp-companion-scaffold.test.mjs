import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("MCP companion is a separate dependent Windows extension", () => {
  const manifest = JSON.parse(
    fs.readFileSync("mcp-extension/package.json", "utf8"),
  );
  assert.equal(manifest.publisher, "kpk");
  assert.equal(manifest.name, "unity-debugger-pure-mcp");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.engines.vscode, "^1.101.0");
  assert.equal(manifest.devDependencies["@types/vscode"], "1.101.0");
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
});

test("debugger VSIX excludes companion workspaces", () => {
  const ignore = fs.readFileSync(".vscodeignore", "utf8");
  assert.match(ignore, /^mcp-extension\/\*\*$/m);
  assert.match(ignore, /^mcp-server\/\*\*$/m);
});

test("companion VSIX excludes the workspace parent", () => {
  const ignore = fs.readFileSync("mcp-extension/.vscodeignore", "utf8");
  assert.match(ignore, /^\.\.\/\*\*$/m);
});

test("base and companion TypeScript programs isolate VS Code declarations", () => {
  const base = JSON.parse(fs.readFileSync("tsconfig.json", "utf8"));
  const companion = JSON.parse(
    fs.readFileSync("mcp-extension/tsconfig.json", "utf8"),
  );
  const server = JSON.parse(fs.readFileSync("mcp-server/tsconfig.json", "utf8"));

  assert.equal(base.compilerOptions.skipLibCheck, undefined);
  assert.doesNotMatch(base.include.join("\n"), /^mcp-(extension|server)\//m);
  assert.deepEqual(companion.compilerOptions.types, ["node", "vscode"]);
  assert.deepEqual(companion.compilerOptions.typeRoots, [
    "./node_modules/@types",
    "../node_modules/@types",
  ]);
  assert.equal(companion.compilerOptions.baseUrl, undefined);
  assert.deepEqual(companion.compilerOptions.paths, {
    vscode: ["./node_modules/@types/vscode/index.d.ts"],
  });
  assert.deepEqual(server.compilerOptions.types, ["node"]);
  assert.ok(fs.existsSync("tests/mcp-extension/vscode-1.101-boundary.ts"));
});

test("companion lock entry pins the stable VS Code MCP API types", () => {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

  assert.equal(lock.packages["mcp-extension"].engines.vscode, "^1.101.0");
  assert.equal(
    lock.packages["mcp-extension"].devDependencies["@types/vscode"],
    "1.101.0",
  );
  assert.equal(
    lock.packages["mcp-extension/node_modules/@types/vscode"].version,
    "1.101.0",
  );
});

test("extension manifests do not load MCP server runtime dependencies", () => {
  const manifests = [
    JSON.parse(fs.readFileSync("package.json", "utf8")),
    JSON.parse(fs.readFileSync("mcp-extension/package.json", "utf8")),
  ];

  for (const manifest of manifests) {
    assert.equal(manifest.dependencies?.["@modelcontextprotocol/sdk"], undefined);
    assert.equal(manifest.dependencies?.zod, undefined);
  }
});

test("MCP workspace typechecks include tests and run from normal scripts", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const companion = JSON.parse(
    fs.readFileSync("mcp-extension/tsconfig.json", "utf8"),
  );
  const server = JSON.parse(fs.readFileSync("mcp-server/tsconfig.json", "utf8"));

  assert.deepEqual(companion.include, [
    "src/**/*.ts",
    "../tests/mcp-extension/**/*.ts",
  ]);
  assert.deepEqual(server.include, [
    "typecheck-anchor.d.ts",
    "src/**/*.ts",
    "../tests/mcp-server/**/*.ts",
  ]);
  assert.ok(fs.existsSync("mcp-server/typecheck-anchor.d.ts"));
  assert.equal(manifest.scripts["typecheck:base"], "tsc -p tsconfig.json");
  assert.equal(
    manifest.scripts["typecheck:mcp-extension"],
    "tsc -p mcp-extension/tsconfig.json",
  );
  assert.equal(
    manifest.scripts["typecheck:mcp-server"],
    "tsc -p mcp-server/tsconfig.json",
  );
  assert.equal(
    manifest.scripts.typecheck,
    "npm run typecheck:base && npm run typecheck:mcp-extension && npm run typecheck:mcp-server",
  );
  assert.equal(
    manifest.scripts["test:mcp"],
    "npm run typecheck:mcp-extension && npm run test:mcp-extension && npm run typecheck:mcp-server && npm run test:mcp-server",
  );
});
