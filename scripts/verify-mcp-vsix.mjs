import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

import { assertSupportedNodeVersion } from "./build-tool-version-policy.mjs";
import { parseRuntimeInventory } from "./runtime-inventory.mjs";

assertSupportedNodeVersion(process.version);

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requested = process.argv[2];
if (!requested) {
  throw new Error("Usage: verify-mcp-vsix.mjs <artifact.vsix>");
}

const vsixPath = path.resolve(repositoryRoot, requested);
const archive = new AdmZip(vsixPath);
const files = new Map();
const seenPaths = new Set();
for (const entry of archive.getEntries()) {
  const normalized = entry.entryName.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe ZIP path: ${entry.entryName}`);
  }
  const key = normalized.toLowerCase();
  if (seenPaths.has(key)) {
    throw new Error(`Duplicate ZIP path: ${normalized}`);
  }
  seenPaths.add(key);
  if (
    /UnityDebuggerPure\.exe|Mono\.Debugging|Mono\.Debugger/i.test(normalized) ||
    /(?:^|\/)(?:adapter|vendor)(?:\/|$)/i.test(normalized) ||
    /unitycommunitydebug|vscode-mono-debug|debugger-libs|nrefactory/i.test(normalized)
  ) {
    throw new Error(`Forbidden debugger runtime path: ${normalized}`);
  }
  if (entry.isDirectory) {
    if (!allowedDirectory(key)) {
      throw new Error(`Unexpected companion package directory: ${normalized}`);
    }
    continue;
  }
  if (!allowedPath(key)) {
    throw new Error(`Unexpected companion package file: ${normalized}`);
  }
  files.set(key, { path: normalized, bytes: entry.getData() });
}

const required = [
  "[content_types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/license.txt",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/security.md",
  "extension/third_party_notices.md",
  "extension/images/icon.png",
  "extension/dist/extension.cjs",
  "extension/dist/mcp-bridge.exe",
  "extension/dist/runtime-inventory.json",
];
for (const requiredPath of required) {
  if (!files.has(requiredPath)) {
    throw new Error(`Required companion VSIX file is missing: ${requiredPath}`);
  }
}

const manifest = JSON.parse(
  files.get("extension/package.json").bytes.toString("utf8"),
);
const expectedCommands = [
  {
    command: "unityDebuggerPureMcp.configureCodex",
    title: "Configure Codex",
    category: "Unity Debugger Pure MCP",
  },
  {
    command: "unityDebuggerPureMcp.configureClaudeCode",
    title: "Configure Claude Code",
    category: "Unity Debugger Pure MCP",
  },
];
if (
  manifest.publisher !== "kpk" ||
  manifest.name !== "unity-debugger-pure-mcp" ||
  manifest.displayName !== "Unity Debugger Pure MCP" ||
  manifest.version !== "0.1.1" ||
  manifest.icon !== "images/icon.png" ||
  manifest.main !== "./dist/extension.cjs" ||
  JSON.stringify(manifest.extensionDependencies) !==
    JSON.stringify(["kpk.unity-debugger-pure"]) ||
  JSON.stringify(manifest.contributes?.commands) !== JSON.stringify(expectedCommands)
) {
  throw new Error(
    "Packaged companion manifest has the wrong production identity, dependency, or commands.",
  );
}
if (manifest.dependencies !== undefined) {
  throw new Error("Companion manifest must not declare external Node dependencies.");
}

verifyPngIcon(files.get("extension/images/icon.png").bytes);

const executable = files.get("extension/dist/mcp-bridge.exe").bytes;
verifyAmd64Pe(executable);
const packagedInventoryText = files
  .get("extension/dist/runtime-inventory.json")
  .bytes.toString("utf8");
const inventory = parseRuntimeInventory(packagedInventoryText);
const digest = createHash("sha256").update(executable).digest("hex");
if (inventory.sha256 !== digest) {
  throw new Error("MCP bridge digest does not match the packaged runtime inventory.");
}

console.log(`MCP VSIX verification passed: ${files.size} allowlisted files, AMD64 SEA ${digest}.`);

function allowedPath(filePath) {
  return new Set([
    "[content_types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/license.txt",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/security.md",
    "extension/third_party_notices.md",
    "extension/images/icon.png",
    "extension/dist/extension.cjs",
    "extension/dist/mcp-bridge.exe",
    "extension/dist/runtime-inventory.json",
  ]).has(filePath);
}

function allowedDirectory(directoryPath) {
  return new Set([
    "extension/",
    "extension/dist/",
    "extension/images/",
  ]).has(directoryPath);
}

function verifyPngIcon(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.byteLength < 26 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== 512 ||
    bytes.readUInt32BE(20) !== 512 ||
    bytes[24] !== 8 ||
    (bytes[25] !== 2 && bytes[25] !== 6)
  ) {
    throw new Error("Companion icon must be a 512px RGB or RGBA PNG.");
  }
}

function verifyAmd64Pe(bytes) {
  if (bytes.byteLength < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("MCP bridge executable has no DOS PE header.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.byteLength ||
    bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error("MCP bridge executable has no valid PE signature.");
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("MCP bridge executable is not AMD64.");
  }
}
