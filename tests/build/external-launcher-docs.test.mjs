import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("README documents the exact path-free Codex uvx configuration", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  const launcherReadme = fs.readFileSync("launcher/README.md", "utf8");
  const expected = [
    '[mcp_servers.unity_debugger_pure]',
    'command = "uvx"',
    '"--from"',
    '"unity-debugger-pure-mcp==0.1.0"',
    '"unity-debugger-pure-mcp"',
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 70',
  ];

  for (const document of [readme, launcherReadme]) {
    for (const line of expected) {
      assert.match(document, new RegExp(escapeRegex(line)));
    }
    assert.doesNotMatch(
      document,
      /[A-Za-z]:[\\/](?![\\/])|\\\\[^\s]+\\|\bUsers[\\/]|%[^%]+%|\$env:|\$\{?env|powershell|--pipe|--token/i,
    );
  }
});

test("README distinguishes direct and external launch paths and prerequisites", () => {
  const readme = fs.readFileSync("README.md", "utf8");

  assert.match(readme, /VS Code Agent[^\n]+native provider[^\n]+direct mode/i);
  assert.match(readme, /Codex[^\n]+pinned `uvx` launcher[^\n]+registry mode/i);
  assert.match(readme, /Windows x64/i);
  assert.match(readme, /VS Code 1\.101/i);
  assert.match(readme, /Unity Debugger Pure[^\n]+0\.2\.0/i);
  assert.match(readme, /trusted workspace/i);
  assert.match(readme, /19 tools/i);
  assert.match(readme, /BRIDGE_UNAVAILABLE/);
  assert.match(readme, /one Agent[\s\S]{0,80}control mutations/i);
  assert.match(readme, /global-storage installer[\s\S]{0,80}superseded/i);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
