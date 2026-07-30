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
  assert.equal(manifest.engines.vscode, "^1.96.0");
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
