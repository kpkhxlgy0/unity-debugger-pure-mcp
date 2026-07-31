import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("standalone repository exposes only the public debugger dependency", () => {
  const manifest = readJson("package.json");

  assert.equal(
    manifest.repository.url,
    "https://github.com/kpkhxlgy0/unity-debugger-pure-mcp.git",
  );
  assert.equal(
    manifest.bugs.url,
    "https://github.com/kpkhxlgy0/unity-debugger-pure-mcp/issues",
  );
  assert.equal(
    manifest.homepage,
    "https://github.com/kpkhxlgy0/unity-debugger-pure-mcp#readme",
  );
  assert.deepEqual(manifest.extensionDependencies, [
    "kpk.unity-debugger-pure",
  ]);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.workspaces, ["server"]);
  assert.equal(manifest.devDependencies["js-yaml"], "4.3.0");
  assert.equal(fs.existsSync("launcher/pyproject.toml"), true);
  assert.equal(fs.existsSync("launcher/uv.lock"), true);
  assert.equal(fs.existsSync("mcp-extension"), false);
  assert.equal(fs.existsSync("mcp-server"), false);
  assert.equal(git(["remote"]).trim(), "");
});

test("the VSIX ignore boundary excludes every launcher and launcher artifact", () => {
  const ignored = fs.readFileSync(".vscodeignore", "utf8");
  assert.match(ignored, /^launcher\/\*\*$/m);
  assert.match(ignored, /^dist\/launcher\/\*\*$/m);
});

test("runtime and tests never import debugger repository internals", () => {
  const imports = collectImports(["src", "server", "tests"]);

  assert.deepEqual(
    imports.filter((value) =>
      value.includes("unity-debugger-vscode") ||
      value.includes("extension/src/publicApi") ||
      value.includes("adapter/")),
    [],
  );
  assert.deepEqual(
    imports.filter((value) =>
      value.includes("mcp-extension/src") ||
      value.includes("mcp-server/src")),
    [],
  );
});

test("published metadata contains no old GitHub repository URL", () => {
  const oldUrl = "https://github.com/kpkhxlgy0/" + "unity-debugger-vscode";
  const tracked = git(["ls-files"]).trim().split(/\r?\n/).filter(Boolean);
  const offenders = tracked.filter((file) => {
    if (file.startsWith("docs/") || file === "scripts/extract-mcp-history.mjs") {
      return false;
    }
    return fs.readFileSync(file).includes(Buffer.from(oldUrl, "utf8"));
  });

  assert.deepEqual(offenders, []);
});

function collectImports(roots) {
  return walkFiles(roots)
    .filter((file) => /\.(?:ts|mjs)$/.test(file))
    .flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return [...text.matchAll(
        /(?:from\s*|import\s*\()(["'])([^"']+)\1/g,
      )].map((match) => match[2]);
    });
}

function walkFiles(roots) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else {
        files.push(child);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return files;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
