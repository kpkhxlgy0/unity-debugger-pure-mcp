import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const artifactPath = path.join(
  repositoryRoot,
  "dist",
  "unity-debugger-pure-mcp-0.1.0.vsix",
);
const inventoryPath = path.join(
  repositoryRoot,
  "mcp-extension",
  "runtime-inventory.json",
);
const verifierPath = path.join(repositoryRoot, "scripts", "verify-mcp-vsix.mjs");

test("companion SEA and VSIX satisfy the isolated production contract", {
  timeout: 90_000,
}, async () => {
  const reviewedInventory = fs.readFileSync(inventoryPath, "utf8");
  const reviewedInventoryMtime = fs.statSync(inventoryPath, { bigint: true }).mtimeNs;
  const packaged = await runCommand(
    process.execPath,
    [
      process.env.npm_execpath ?? path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      "run",
      "package:mcp",
    ],
    {
      cwd: repositoryRoot,
      timeout: 60_000,
    },
  );
  assert.equal(
    fs.readFileSync(inventoryPath, "utf8"),
    reviewedInventory,
    "Companion packaging changed the reviewed runtime inventory.",
  );
  assert.equal(
    fs.statSync(inventoryPath, { bigint: true }).mtimeNs,
    reviewedInventoryMtime,
    "Companion packaging rewrote the reviewed runtime inventory.",
  );
  assert.equal(
    packaged.status,
    0,
    `Companion packaging failed:\n${packaged.stdout}\n${packaged.stderr}`,
  );

  const files = auditArchiveEntries(new AdmZip(artifactPath));

  const allowed = new Set([
    "[content_types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/license.txt",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/security.md",
    "extension/third_party_notices.md",
    "extension/runtime-inventory.json",
    "extension/dist/extension.cjs",
    "extension/dist/mcp-bridge.exe",
  ]);
  assert.deepEqual(
    [...files.keys()].filter((name) => !allowed.has(name)),
    [],
    "Companion VSIX contains a file outside the strict allowlist.",
  );
  for (const required of allowed) {
    assert.equal(files.has(required), true, `Required VSIX file is missing: ${required}`);
  }
  assert.equal(
    [...files.keys()].some((name) =>
      /UnityDebuggerPure\.exe|Mono\.Debugging|Mono\.Debugger/i.test(name),
    ),
    false,
  );
  assert.equal(
    [...files.keys()].some((name) => /(?:^|\/)adapter(?:\/|$)/i.test(name)),
    false,
  );

  const manifest = JSON.parse(files.get("extension/package.json").bytes.toString("utf8"));
  assert.deepEqual(manifest.extensionDependencies, ["kpk.unity-debugger-pure"]);
  assert.equal(manifest.name, "unity-debugger-pure-mcp");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.main, "./dist/extension.cjs");

  const executable = files.get("extension/dist/mcp-bridge.exe").bytes;
  verifyAmd64Pe(executable);
  const inventory = JSON.parse(
    files.get("extension/runtime-inventory.json").bytes.toString("utf8"),
  );
  assert.equal(
    files.get("extension/runtime-inventory.json").bytes.toString("utf8"),
    reviewedInventory,
  );
  assert.equal(inventory.nodeVersion, "v26.5.0");
  assert.equal(
    inventory.sha256,
    createHash("sha256").update(executable).digest("hex"),
  );

  const executablePath = path.join(
    repositoryRoot,
    "mcp-extension",
    "dist",
    "mcp-bridge.exe",
  );
  const standalone = spawnSync(executablePath, ["--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: "" },
    timeout: 10_000,
  });
  assert.equal(
    standalone.status,
    0,
    `SEA required an external Node runtime:\n${standalone.stdout}\n${standalone.stderr}`,
  );
  assert.equal(standalone.stdout, "");
  assert.match(standalone.stderr, /Unity Debugger Pure MCP/);
});

test("production verifier rejects forbidden directory entries", () => {
  withTamperedArtifact("forbidden-directory", (archive) => {
    addDirectory(archive, "extension/Adapter/");
  }, (tamperedPath) => {
    const result = runVerifier(tamperedPath);
    assert.notEqual(result.status, 0, "Production verifier accepted an Adapter directory.");
    assert.match(result.stderr, /Forbidden debugger runtime path: extension\/Adapter\//);
  });
});

test("production verifier rejects case-insensitive duplicate directories", () => {
  withTamperedArtifact("duplicate-directory", (archive) => {
    return rebuildWithDirectories(archive, ["extension/dist/", "EXTENSION/DIST/"]);
  }, (tamperedPath) => {
    const result = runVerifier(tamperedPath);
    assert.notEqual(result.status, 0, "Production verifier accepted duplicate directories.");
    assert.match(result.stderr, /Duplicate ZIP path: EXTENSION\/DIST\//);
  });
});

test("independent audit rejects forbidden directory entries", () => {
  withTamperedArtifact("independent-forbidden-directory", (archive) => {
    addDirectory(archive, "extension/Adapter/");
  }, (tamperedPath) => {
    assert.throws(
      () => auditArchiveEntries(new AdmZip(tamperedPath)),
      /Forbidden debugger runtime path: extension\/Adapter\//,
    );
  });
});

test("independent audit rejects case-insensitive duplicate directories", () => {
  withTamperedArtifact("independent-duplicate-directory", (archive) => {
    return rebuildWithDirectories(archive, ["extension/dist/", "EXTENSION/DIST/"]);
  }, (tamperedPath) => {
    assert.throws(
      () => auditArchiveEntries(new AdmZip(tamperedPath)),
      /Duplicate ZIP path: EXTENSION\/DIST\//,
    );
  });
});

function auditArchiveEntries(archive) {
  const files = new Map();
  const seenPaths = new Set();
  for (const entry of archive.getEntries()) {
    const normalized = entry.entryName.replaceAll("\\", "/");
    assert.equal(
      normalized.startsWith("/") ||
        /^[A-Za-z]:/.test(normalized) ||
        normalized.split("/").includes(".."),
      false,
      `Unsafe ZIP path: ${entry.entryName}`,
    );
    const key = normalized.toLowerCase();
    assert.equal(seenPaths.has(key), false, `Duplicate ZIP path: ${normalized}`);
    seenPaths.add(key);
    assert.equal(
      /UnityDebuggerPure\.exe|Mono\.Debugging|Mono\.Debugger/i.test(normalized) ||
        /(?:^|\/)(?:adapter|vendor)(?:\/|$)/i.test(normalized) ||
        /unitycommunitydebug|vscode-mono-debug|debugger-libs|nrefactory/i.test(normalized),
      false,
      `Forbidden debugger runtime path: ${normalized}`,
    );
    if (entry.isDirectory) {
      assert.equal(
        new Set(["extension/", "extension/dist/"]).has(key),
        true,
        `Unexpected companion package directory: ${normalized}`,
      );
      continue;
    }
    files.set(key, { name: normalized, bytes: entry.getData() });
  }
  return files;
}

function withTamperedArtifact(name, mutate, inspect) {
  const tamperedPath = path.join(repositoryRoot, "dist", `${name}.vsix`);
  try {
    const archive = new AdmZip(artifactPath);
    const mutatedArchive = mutate(archive) ?? archive;
    mutatedArchive.writeZip(tamperedPath);
    inspect(tamperedPath);
  } finally {
    fs.rmSync(tamperedPath, { force: true });
  }
}

function addDirectory(archive, entryName) {
  archive.addFile(entryName, Buffer.alloc(0));
  assert.equal(archive.getEntry(entryName).isDirectory, true);
}

function rebuildWithDirectories(source, directoryNames) {
  const rebuilt = new AdmZip();
  for (const entryName of directoryNames) {
    addDirectory(rebuilt, entryName);
  }
  for (const entry of source.getEntries()) {
    if (!entry.isDirectory) {
      rebuilt.addFile(entry.entryName, entry.getData(), entry.comment, entry.attr);
    }
  }
  return rebuilt;
}

function runVerifier(vsixPath) {
  return spawnSync(process.execPath, [verifierPath, vsixPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let closed = false;
  let timedOut = false;
  let timeout;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      closed = true;
      resolve({ status, signal, stdout, stderr });
    });
  });
  try {
    const expiration = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
        reject(new Error(`Command timed out after ${options.timeout} ms.`));
      }, options.timeout);
    });
    return await Promise.race([completion, expiration]);
  } finally {
    clearTimeout(timeout);
    if (!closed) {
      terminateProcessTree(child);
      await waitBounded(
        new Promise((resolve) => child.once("close", resolve)),
        2_000,
      );
    } else if (timedOut) {
      terminateProcessTree(child);
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function waitBounded(operation, milliseconds) {
  let timeout;
  try {
    await Promise.race([
      operation,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function terminateProcessTree(child) {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", timeout: 5_000, windowsHide: true },
    );
  } else {
    child.kill("SIGKILL");
  }
}

function verifyAmd64Pe(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0x5a4d, "SEA has no DOS PE header.");
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(
    bytes.toString("ascii", peOffset, peOffset + 4),
    "PE\0\0",
    "SEA has no valid PE signature.",
  );
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, "SEA is not AMD64.");
}
