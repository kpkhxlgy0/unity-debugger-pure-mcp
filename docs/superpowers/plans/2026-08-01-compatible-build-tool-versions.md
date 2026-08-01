# Compatible Build Tool Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ordinary Windows x64 development builds use Node.js `>=26.5.0 <27.0.0` and uv `>=0.12.0 <0.13.0`, while preserving exact Node.js `26.5.0` and uv `0.12.0` as the reviewed public-release toolchain.

**Architecture:** Separate local artifact self-consistency from public-release reproducibility. A shared build-time policy parses supported tool versions; the bridge build writes its actual Node version and SEA digest into `dist/runtime-inventory.json`; the VSIX packages and validates that generated inventory beside the executable. A separate release verifier compares the generated inventory with the tracked root `runtime-inventory.json`, and only exact-version release workflows invoke that stricter gate.

**Tech Stack:** Node.js ESM build scripts, Node test runner, TypeScript/Vitest, Windows x64 Node SEA, uv/Python launcher packaging, VSCE, GitHub Actions.

## File Structure and Responsibilities

- `scripts/build-tool-version-policy.mjs`: single build-time parser and compatibility policy for Node.js and uv, including exact official-release constants.
- `scripts/runtime-inventory.mjs`: strict two-field inventory parsing/formatting shared by build and verification scripts.
- `scripts/verify-release-inventory.mjs`: exact public-release comparison between tracked and generated inventories.
- `scripts/build-mcp-bridge.mjs`: accept compatible Node versions and write the generated SEA inventory after all bridge checks pass.
- `scripts/build-launcher.mjs`: accept compatible uv `0.12.x` output without weakening platform or artifact checks.
- `scripts/verify-mcp-vsix.mjs`: verify a self-consistent compatible local package, independent of the tracked release inventory.
- `src/external/liveHostRegistrationPublisher.ts`: self-contained runtime validation of compatible packaged inventory and executable digest.
- `src/extension.ts`: resolve the inventory from `dist/runtime-inventory.json` beside `mcp-bridge.exe`.
- `.vscodeignore`: exclude the tracked release inventory and include only the generated dist inventory.
- `tests/build/*.test.mjs`: range boundaries, strict inventory schema, release comparison, manifest/build contracts, and workflow gates.
- `tests/extension/liveHostRegistrationPublisher.test.ts`: extension-host runtime compatibility and digest checks.
- `tests/package/mcp-vsix.test.mjs`: actual local Node identity, generated inventory path, archive allowlist, and tracked-inventory immutability.
- `.github/workflows/ci.yml`: retain exact versions and exercise the strict release-inventory gate as an early reproducibility check.
- `.github/workflows/release-companion.yml`: require exact Node and a reviewed-inventory match before upload.
- `.github/workflows/release-launcher.yml`: retain exact uv `0.12.0` for public launcher artifacts.
- `package.json` / `package-lock.json`: declare Node `<27`, add the release verifier command, and preserve package identities.
- `README.md` / `CHANGELOG.md`: explain compatible local tooling versus pinned public release tooling.

## Global Constraints

- Local Node support is exactly `>=26.5.0 <27.0.0`; local uv support is exactly `>=0.12.0 <0.13.0`.
- Stable semantic versions only: prereleases, incomplete versions, malformed output, Node 27+, and uv 0.13+ fail closed.
- Windows x64 remains mandatory for SEA and launcher production builds.
- `runtime-inventory.json` remains tracked, reviewed, and unchanged by normal builds.
- Normal bridge builds write only `dist/runtime-inventory.json`, after AMD64 verification and both SEA smoke modes succeed.
- The packaged inventory path is exactly `extension/dist/runtime-inventory.json`; `extension/runtime-inventory.json` is removed.
- The VSIX remains exactly 12 allowlisted files and never bundles `scripts/` or the tracked root inventory.
- The extension continues hashing `mcp-bridge.exe` and comparing the digest with its packaged inventory before publishing live-host registration.
- Official workflows retain Node `26.5.0` and uv `0.12.0`; no bypass environment variable or automatic release-inventory update is introduced.
- MCP protocol version 1, tool schemas, live-host registration schema, companion `0.1.1`, server `0.1.0`, and launcher `0.1.0` remain unchanged.
- The existing dirty worktree contains approved 0.1.1/configuration work. Stage only task-listed paths, preserve unrelated edits, and do not commit or push without explicit user authorization.

---

### Task 1: Define and test the compatible build-tool policy

**Files:**
- Create: `scripts/build-tool-version-policy.mjs`
- Create: `tests/build/build-tool-version-policy.test.mjs`
- Modify: `scripts/build-launcher.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Export `OFFICIAL_RELEASE_NODE_VERSION = "v26.5.0"`.
- Export `OFFICIAL_RELEASE_UV_VERSION = "0.12.0"`.
- Export `assertSupportedNodeVersion(value): string`.
- Export `assertSupportedUvVersionOutput(value): string`, returning the normalized numeric version without the `uv ` prefix.
- Both assertion functions throw a stable error that names the supported range and the received version, but never provide a bypass.

- [ ] **Step 1: Write failing version-boundary tests**

Create `tests/build/build-tool-version-policy.test.mjs` with table-driven behavior tests:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFICIAL_RELEASE_NODE_VERSION,
  OFFICIAL_RELEASE_UV_VERSION,
  assertSupportedNodeVersion,
  assertSupportedUvVersionOutput,
} from "../../scripts/build-tool-version-policy.mjs";

test("Node policy accepts stable compatible 26.x versions", () => {
  for (const version of ["v26.5.0", "v26.5.1", "v26.6.0", "v26.99.4"]) {
    assert.equal(assertSupportedNodeVersion(version), version);
  }
  assert.equal(OFFICIAL_RELEASE_NODE_VERSION, "v26.5.0");
});

test("Node policy rejects versions outside the supported stable range", () => {
  for (const version of [
    "26.5.0",
    "v26.4.9",
    "v26.5",
    "v26.5.1-rc.1",
    "v27.0.0",
    "garbage",
  ]) {
    assert.throws(() => assertSupportedNodeVersion(version), />=26\.5\.0 <27\.0\.0/);
  }
});

test("uv policy accepts stable 0.12.x output", () => {
  assert.equal(assertSupportedUvVersionOutput("uv 0.12.0"), "0.12.0");
  assert.equal(assertSupportedUvVersionOutput("uv 0.12.1"), "0.12.1");
  assert.equal(
    assertSupportedUvVersionOutput(
      "uv 0.12.1 (329541a50 2026-07-31 x86_64-pc-windows-msvc)",
    ),
    "0.12.1",
  );
  assert.equal(OFFICIAL_RELEASE_UV_VERSION, "0.12.0");
});

test("uv policy rejects versions outside stable 0.12.x", () => {
  for (const version of [
    "0.12.0",
    "uv 0.11.9",
    "uv 0.12",
    "uv 0.12.1-rc.1",
    "uv 0.12.1 (nested (metadata))",
    "uv 0.12.1 metadata-without-parentheses",
    "uv 0.13.0",
    "uv garbage",
  ]) {
    assert.throws(() => assertSupportedUvVersionOutput(version), />=0\.12\.0 <0\.13\.0/);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
node --test tests/build/build-tool-version-policy.test.mjs
```

Expected: FAIL because `scripts/build-tool-version-policy.mjs` does not exist.

- [ ] **Step 3: Implement the minimum strict version policy**

Create `scripts/build-tool-version-policy.mjs` with strict stable-triplet parsing:

```js
export const OFFICIAL_RELEASE_NODE_VERSION = "v26.5.0";
export const OFFICIAL_RELEASE_UV_VERSION = "0.12.0";

const stableTriplet = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";

export function assertSupportedNodeVersion(value) {
  const match = new RegExp(`^v${stableTriplet}$`).exec(value);
  if (match === null || Number(match[1]) !== 26 || Number(match[2]) < 5) {
    throw new Error(
      `Node.js builds require >=26.5.0 <27.0.0; found ${String(value)}.`,
    );
  }
  return value;
}

export function assertSupportedUvVersionOutput(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const match = new RegExp(
    `^uv ${stableTriplet}(?: \\([^()\\r\\n]+\\))?$`,
  ).exec(normalized);
  if (match === null || Number(match[1]) !== 0 || Number(match[2]) !== 12) {
    throw new Error(
      `Launcher builds require uv >=0.12.0 <0.13.0; found ${String(value)}.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}
```

The optional suffix is deliberately limited to one nonempty, nonnested,
single-line parenthesized value. This accepts the observed official output while
rejecting prerelease syntax and arbitrary trailing text.

- [ ] **Step 4: Run the policy tests and verify GREEN**

```powershell
node --test tests/build/build-tool-version-policy.test.mjs
```

Expected: PASS with all accepted and rejected boundary cases.

- [ ] **Step 5: Drive the launcher through the shared policy**

First extend the test to spawn a small fixture or export the parser behavior so `uv 0.12.1` is proven accepted and `uv 0.13.0` rejected. Then replace the exact regex in `scripts/build-launcher.mjs`:

```js
import { assertSupportedUvVersionOutput } from "./build-tool-version-policy.mjs";

const uvVersion = run("uv", ["--version"]).stdout.trim();
assertSupportedUvVersionOutput(uvVersion);
```

Do not change the Windows/x64 guard, artifact names, wheel tag rewrite, or independent launcher verifier.

- [ ] **Step 6: Narrow the manifest engine declaration**

Change the root manifest from:

```json
"node": ">=26.5.0"
```

to:

```json
"node": ">=26.5.0 <27.0.0"
```

Run `npm install --package-lock-only` with an already-supported Node version so `package-lock.json` mirrors the root engine without changing dependency versions.

- [ ] **Step 7: Run Task 1 verification**

```powershell
npm run test:build
npm run typecheck
git diff --check
```

Expected: build-policy tests pass; existing exact workflow-pin tests remain green.

- [ ] **Step 8: Commit only after explicit authorization**

```powershell
git add package.json package-lock.json scripts/build-tool-version-policy.mjs scripts/build-launcher.mjs tests/build/build-tool-version-policy.test.mjs
git commit -m "build: accept compatible local tool versions"
```

---

### Task 2: Generate local SEA inventory and add the strict release comparator

**Files:**
- Create: `scripts/runtime-inventory.mjs`
- Create: `scripts/verify-release-inventory.mjs`
- Create: `tests/build/runtime-inventory.test.mjs`
- Create: `tests/build/release-inventory.test.mjs`
- Modify: `scripts/build-mcp-bridge.mjs`
- Modify: `package.json`
- Modify: `runtime-inventory.json` only if the exact Node `26.5.0` release build genuinely changes the reviewed SEA; never modify it during an ordinary compatible build.

**Interfaces:**
- `parseRuntimeInventory(text)` returns a frozen `{ nodeVersion, sha256 }` only for an exact two-field schema, compatible Node version, and lowercase 64-hex digest.
- `formatRuntimeInventory(value)` emits canonical two-space JSON plus one trailing newline.
- `verify-release-inventory.mjs [reviewedPath] [generatedPath]` defaults to root `runtime-inventory.json` and `dist/runtime-inventory.json` and requires exact field equality plus official Node `v26.5.0`.

- [ ] **Step 1: Write failing strict inventory tests**

Create `tests/build/runtime-inventory.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRuntimeInventory,
  parseRuntimeInventory,
} from "../../scripts/runtime-inventory.mjs";

test("runtime inventory round-trips a compatible local SEA identity", () => {
  const value = { nodeVersion: "v26.5.1", sha256: "a".repeat(64) };
  assert.deepEqual(parseRuntimeInventory(formatRuntimeInventory(value)), value);
});

test("runtime inventory rejects extensions, unsupported versions, and bad digests", () => {
  for (const value of [
    null,
    { nodeVersion: "v26.5.1", sha256: "a".repeat(64), extra: true },
    { nodeVersion: "v26.4.9", sha256: "a".repeat(64) },
    { nodeVersion: "v27.0.0", sha256: "a".repeat(64) },
    { nodeVersion: "v26.5.1-rc.1", sha256: "a".repeat(64) },
    { nodeVersion: "v26.5.1", sha256: "A".repeat(64) },
  ]) {
    assert.throws(() => parseRuntimeInventory(JSON.stringify(value)), /inventory/i);
  }
});
```

- [ ] **Step 2: Write failing release-comparison tests**

Create `tests/build/release-inventory.test.mjs` using `fs.mkdtempSync` and `spawnSync` to run the real CLI against controlled files:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const verifier = path.resolve("scripts/verify-release-inventory.mjs");

test("release inventory requires exact reviewed Node and SEA identity", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reviewedPath = path.join(directory, "reviewed.json");
  const generatedPath = path.join(directory, "generated.json");
  const digest = "a".repeat(64);
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const run = () => spawnSync(
    process.execPath,
    [verifier, reviewedPath, generatedPath],
    { encoding: "utf8", windowsHide: true },
  );

  write(reviewedPath, { nodeVersion: "v26.5.0", sha256: digest });
  write(generatedPath, { nodeVersion: "v26.5.0", sha256: digest });
  assert.equal(run().status, 0);

  write(generatedPath, { nodeVersion: "v26.5.1", sha256: digest });
  assert.notEqual(run().status, 0);

  write(generatedPath, { nodeVersion: "v26.5.0", sha256: "b".repeat(64) });
  assert.notEqual(run().status, 0);

  write(reviewedPath, { nodeVersion: "v26.5.1", sha256: digest });
  write(generatedPath, { nodeVersion: "v26.5.1", sha256: digest });
  assert.notEqual(run().status, 0);

  write(reviewedPath, { nodeVersion: "v26.5.0", sha256: digest, extra: true });
  write(generatedPath, { nodeVersion: "v26.5.0", sha256: digest });
  const malformed = run();
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /inventory/i);
});
```

The test must observe CLI exit status and stderr; do not assert source text.

- [ ] **Step 3: Run the new tests and verify RED**

```powershell
node --test tests/build/runtime-inventory.test.mjs tests/build/release-inventory.test.mjs
```

Expected: FAIL because both production modules are absent.

- [ ] **Step 4: Implement strict inventory parsing and formatting**

Create `scripts/runtime-inventory.mjs`:

```js
import { assertSupportedNodeVersion } from "./build-tool-version-policy.mjs";

export function parseRuntimeInventory(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("MCP bridge runtime inventory is invalid.");
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "nodeVersion,sha256" ||
    typeof value.nodeVersion !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error("MCP bridge runtime inventory is invalid.");
  }
  try {
    assertSupportedNodeVersion(value.nodeVersion);
  } catch {
    throw new Error("MCP bridge runtime inventory is invalid.");
  }
  return Object.freeze({
    nodeVersion: value.nodeVersion,
    sha256: value.sha256,
  });
}

export function formatRuntimeInventory(value) {
  return `${JSON.stringify(parseRuntimeInventory(JSON.stringify(value)), null, 2)}\n`;
}
```

- [ ] **Step 5: Change the bridge build from reviewed-input verification to generated-output writing**

In `scripts/build-mcp-bridge.mjs`:

1. call `assertSupportedNodeVersion(process.version)` before building;
2. keep PE/AMD64 and direct/registry smoke tests unchanged;
3. after both smoke tests pass, atomically write:

```js
const generatedInventoryPath = path.join(
  repositoryRoot,
  "dist",
  "runtime-inventory.json",
);
const temporaryInventoryPath = `${generatedInventoryPath}.${process.pid}.tmp`;
try {
  await fs.writeFile(
    temporaryInventoryPath,
    formatRuntimeInventory({ nodeVersion: process.version, sha256 }),
    "utf8",
  );
  await fs.rename(temporaryInventoryPath, generatedInventoryPath);
} finally {
  await fs.rm(temporaryInventoryPath, { force: true });
}
```

Remove `verifyReviewedInventory`. Ensure a failed build cannot rewrite the tracked root inventory. Preserve the candidate digest in normal success output for auditability.

- [ ] **Step 6: Implement the exact release verifier**

Create `scripts/verify-release-inventory.mjs` with optional CLI paths for real fixture testing:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OFFICIAL_RELEASE_NODE_VERSION } from "./build-tool-version-policy.mjs";
import { parseRuntimeInventory } from "./runtime-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewedPath = path.resolve(root, process.argv[2] ?? "runtime-inventory.json");
const generatedPath = path.resolve(root, process.argv[3] ?? "dist/runtime-inventory.json");
const reviewed = parseRuntimeInventory(fs.readFileSync(reviewedPath, "utf8"));
const generated = parseRuntimeInventory(fs.readFileSync(generatedPath, "utf8"));

if (
  reviewed.nodeVersion !== OFFICIAL_RELEASE_NODE_VERSION ||
  generated.nodeVersion !== reviewed.nodeVersion ||
  generated.sha256 !== reviewed.sha256
) {
  throw new Error("Generated SEA does not match the reviewed release inventory.");
}
```

Add to `package.json`:

```json
"verify:release-inventory": "node scripts/verify-release-inventory.mjs"
```

- [ ] **Step 7: Run Task 2 tests and verify GREEN**

```powershell
node --test tests/build/build-tool-version-policy.test.mjs tests/build/runtime-inventory.test.mjs tests/build/release-inventory.test.mjs
npm run test:build
git diff --check
```

Expected: strict schema and release mismatch fixtures pass; root `runtime-inventory.json` remains byte-for-byte unchanged.

- [ ] **Step 8: Commit only after explicit authorization**

```powershell
git add package.json scripts/build-mcp-bridge.mjs scripts/runtime-inventory.mjs scripts/verify-release-inventory.mjs tests/build/runtime-inventory.test.mjs tests/build/release-inventory.test.mjs
git commit -m "build: separate local and release SEA inventories"
```

Add `runtime-inventory.json` only if an explicitly reviewed exact release rebuild requires it.

---

### Task 3: Package and consume the generated inventory beside the bridge

**Files:**
- Modify: `.vscodeignore`
- Modify: `src/extension.ts`
- Modify: `src/external/liveHostRegistrationPublisher.ts`
- Modify: `tests/extension/liveHostRegistrationPublisher.test.ts`
- Modify: `tests/extension/extension.test.ts`
- Modify: `scripts/verify-mcp-vsix.mjs`
- Modify: `tests/package/mcp-vsix.test.mjs`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`

**Interfaces:**
- Rename internal `verifyReviewedBridgeIntegrity` to `verifyPackagedBridgeIntegrity` so runtime naming matches the new generated-package boundary.
- The extension must call it with `context.asAbsolutePath(path.join("dist", "runtime-inventory.json"))`.
- Runtime TypeScript validates the same compatible stable Node range without importing `scripts/` into the extension bundle.

- [ ] **Step 1: Update extension runtime tests first and verify RED**

In `tests/extension/liveHostRegistrationPublisher.test.ts`, rename the describe block and imported function, then require:

```ts
it.each(["v26.5.0", "v26.5.1", "v26.6.0"])(
  "accepts compatible packaged inventory %s",
  async (nodeVersion) => {
    const setup = await harness();
    const inventory = path.join(setup.base, "runtime-inventory.json");
    const digest = createHash("sha256").update(setup.bridgeBytes).digest("hex");
    await fs.writeFile(inventory, JSON.stringify({ nodeVersion, sha256: digest }));
    await expect(verifyPackagedBridgeIntegrity(inventory, setup.bridgeExecutable))
      .resolves.toBe(digest);
  },
);

it.each(["v26.4.9", "v26.5.1-rc.1", "v27.0.0", "26.5.1"])(
  "rejects unsupported packaged inventory %s",
  async (nodeVersion) => {
    const setup = await harness();
    const inventory = path.join(setup.base, "runtime-inventory.json");
    const digest = createHash("sha256").update(setup.bridgeBytes).digest("hex");
    await fs.writeFile(inventory, JSON.stringify({ nodeVersion, sha256: digest }));
    await expect(verifyPackagedBridgeIntegrity(inventory, setup.bridgeExecutable))
      .rejects.toThrow("MCP bridge runtime inventory is invalid.");
  },
);
```

Retain malformed JSON, extra key, uppercase digest, digest mismatch, oversize inventory, missing file, and unreadable bridge cases.

In `tests/extension/extension.test.ts`, change the activation fixture and assertion so the requested inventory path ends in `dist\\runtime-inventory.json` and remains adjacent to `dist\\mcp-bridge.exe`.

Run:

```powershell
npx vitest run tests/extension/liveHostRegistrationPublisher.test.ts tests/extension/extension.test.ts
```

Expected: FAIL on `v26.5.1` and the old root inventory path.

- [ ] **Step 2: Implement self-contained runtime compatibility**

In `src/external/liveHostRegistrationPublisher.ts`, replace the literal inventory type with:

```ts
function hasExactInventory(value: unknown): value is {
  readonly nodeVersion: string;
  readonly sha256: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "nodeVersion,sha256" &&
    typeof record.nodeVersion === "string" &&
    isSupportedPackagedNodeVersion(record.nodeVersion) &&
    typeof record.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.sha256);
}

function isSupportedPackagedNodeVersion(value: string): boolean {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match !== null && Number(match[1]) === 26 && Number(match[2]) >= 5;
}
```

Keep the runtime copy intentionally small and self-contained; build scripts remain excluded from the VSIX. Rename the exported integrity function and all imports/callers.

- [ ] **Step 3: Move the runtime path beside the executable**

In `src/extension.ts`, use:

```ts
const bridgeSha256 = await verifyPackagedBridgeIntegrity(
  context.asAbsolutePath(path.join("dist", "runtime-inventory.json")),
  executable,
);
```

Do not change the bridge executable path, registration schema, pipe token, or workspace-root behavior.

- [ ] **Step 4: Drive the VSIX archive path and self-consistency through package tests**

Update `tests/package/mcp-vsix.test.mjs` before the verifier:

- allowed/required inventory becomes `extension/dist/runtime-inventory.json`;
- `extension/runtime-inventory.json` must be absent;
- packaged inventory `nodeVersion` must equal the Node process used by `package:companion`;
- packaged digest must equal the packaged SEA digest;
- root tracked inventory content and mtime must stay unchanged;
- archive file count remains 12;
- tampering Node to `v26.4.9`, `v27.0.0`, a prerelease, adding a third field, or changing the digest must make the production verifier fail;
- the current compatible local Node package must pass the real verifier.

Run the test once before changing the verifier:

```powershell
node --test tests/package/mcp-vsix.test.mjs
```

Expected: FAIL because the current build/verifier still requires and packages the root reviewed inventory.

- [ ] **Step 5: Change the strict VSIX verifier to local self-consistency**

In `scripts/verify-mcp-vsix.mjs`:

1. call `assertSupportedNodeVersion(process.version)`;
2. import `parseRuntimeInventory`;
3. require `extension/dist/runtime-inventory.json`;
4. remove the root tracked-inventory text comparison;
5. parse the packaged inventory strictly and require its SHA to match the packaged AMD64 SEA;
6. retain all existing path traversal, case-folded duplicate, directory, debugger runtime, launcher, manifest, icon, stdout smoke, and exact allowlist checks.

- [ ] **Step 6: Change `.vscodeignore` without changing file count**

Use explicit package boundaries:

```text
runtime-inventory.json
dist/**
!dist/extension.cjs
!dist/mcp-bridge.exe
!dist/runtime-inventory.json
```

The first line excludes the tracked reviewed inventory; the final negation includes only the generated inventory. Update `tests/build/mcp-companion-scaffold.test.mjs` to prove these Git/package inputs remain intentional without relying only on regex source inspection.

- [ ] **Step 7: Run Task 3 verification**

```powershell
npm run typecheck
npx vitest run tests/extension/liveHostRegistrationPublisher.test.ts tests/extension/extension.test.ts
npm run test:package:companion
npm run test:build
git diff --check
```

Expected: compatible packaged inventories pass, unsupported inventories fail, root inventory is unchanged, and VSIX contains exactly 12 allowed files.

- [ ] **Step 8: Commit only after explicit authorization**

```powershell
git add .vscodeignore src/extension.ts src/external/liveHostRegistrationPublisher.ts scripts/verify-mcp-vsix.mjs tests/build/mcp-companion-scaffold.test.mjs tests/extension/liveHostRegistrationPublisher.test.ts tests/extension/extension.test.ts tests/package/mcp-vsix.test.mjs
git commit -m "build: package generated bridge inventory"
```

---

### Task 4: Preserve exact public-release gates and document the split policy

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-companion.yml`
- Modify: `tests/build/workflows.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-01-compatible-build-tool-versions-design.md` only if implementation evidence requires a clarification, never to weaken the approved boundary.

**Interfaces:**
- CI and companion release remain pinned to Node `26.5.0` and uv `0.12.0`.
- Launcher release remains pinned to uv `0.12.0`.
- CI and companion release invoke `npm run verify:release-inventory` only after the final package-test rebuild and before artifact upload.

- [ ] **Step 1: Write failing workflow behavior assertions**

Extend `tests/build/workflows.test.mjs`:

```js
assert.equal(setupNodeVersion(build), "26.5.0");
assertUvSetup(build); // still exact 0.12.0
assert.match(buildCommands, /npm run package:companion/);
assert.match(buildCommands, /npm run verify:release-inventory/);
assert.ok(
  buildCommands.indexOf("npm run test:package:companion") <
    buildCommands.indexOf("npm run verify:release-inventory"),
);
```

Add the same strict-inventory assertion to CI after `npm run package`. Keep launcher release assertions unchanged and explicitly prove it does not invoke the companion inventory verifier.

- [ ] **Step 2: Run workflow tests and verify RED**

```powershell
node --test tests/build/workflows.test.mjs
```

Expected: FAIL because the strict release-inventory command is not yet in CI or companion release.

- [ ] **Step 3: Insert the strict gate in exact-version workflows**

In `.github/workflows/release-companion.yml`:

```yaml
      - run: npm run package:companion
      - run: npm run test:package:companion
      - run: npm run verify:release-inventory
```

In `.github/workflows/ci.yml`, after `npm run test:package`, add:

```yaml
      - run: npm run verify:release-inventory
```

Do not relax either workflow setup version. Do not add the strict companion inventory gate to launcher release.

- [ ] **Step 4: Document local compatibility and release reproducibility**

Update `README.md` build instructions to state:

- local Windows x64 Node `>=26.5.0 <27` and uv `>=0.12.0 <0.13` are accepted;
- `npm run package` records the actual local Node version in the packaged VSIX;
- public workflows remain exact and require the reviewed root inventory;
- local builds do not rewrite or approve `runtime-inventory.json`.

Add one concise `CHANGELOG.md` 0.1.1 bullet explaining compatible local builds with pinned release verification. Do not imply a new companion or launcher version.

- [ ] **Step 5: Run Task 4 verification**

```powershell
node --test tests/build/workflows.test.mjs
npm run test:build
git diff --check
```

Expected: exact workflow pins and gate order are proven; documentation matches the approved policy.

- [ ] **Step 6: Commit only after explicit authorization**

```powershell
git add .github/workflows/ci.yml .github/workflows/release-companion.yml tests/build/workflows.test.mjs README.md CHANGELOG.md docs/superpowers/specs/2026-08-01-compatible-build-tool-versions-design.md docs/superpowers/plans/2026-08-01-compatible-build-tool-versions.md
git commit -m "ci: preserve reviewed release toolchain"
```

---

### Task 5: Verify both ordinary local and exact release environments

**Files:**
- Verify all changed files from Tasks 1–4.
- Modify: `runtime-inventory.json` only after explicit review if the exact official build changes the SEA digest.

**Interfaces:**
- Local acceptance proves current compatible machine tools work without path overrides.
- Release acceptance proves exact Node `26.5.0` and uv `0.12.0` still reproduce the tracked reviewed inventory.

- [ ] **Step 1: Record the tracked inventory before either build**

```powershell
$reviewedInventoryPath = Resolve-Path runtime-inventory.json
$reviewedInventoryBefore = Get-Content -Raw $reviewedInventoryPath
$reviewedInventoryHashBefore = (Get-FileHash -Algorithm SHA256 $reviewedInventoryPath).Hash
node --version
uv --version
```

Expected ordinary environment for this machine: compatible Node 26.x and uv 0.12.x, even when their patch versions differ from the official release pins.

- [ ] **Step 2: Run the complete ordinary local gate without PATH overrides**

```powershell
npm ci
npm run typecheck
npm test
npm run package
npm run test:package
```

Then verify:

```powershell
$generated = Get-Content -Raw dist/runtime-inventory.json | ConvertFrom-Json
if ($generated.nodeVersion -ne (node --version)) {
  throw "Generated inventory does not record the local Node version."
}
if ((Get-Content -Raw $reviewedInventoryPath) -ne $reviewedInventoryBefore) {
  throw "Ordinary packaging modified the reviewed release inventory."
}
```

Expected: all suites and package audits pass; the generated inventory matches the ordinary Node and SEA; the tracked inventory is byte-for-byte unchanged.

- [ ] **Step 3: Prove the ordinary environment cannot impersonate a release**

When ordinary Node is not exactly `v26.5.0`, run:

```powershell
npm run verify:release-inventory
```

Expected: FAIL with the stable reviewed-inventory mismatch error while the already-built local VSIX remains valid under `verify:vsix`.

- [ ] **Step 4: Run the exact release gate**

Use process-local PATH prefixes only; do not change global installations:

```powershell
$nodeReleaseDir = Join-Path $env:USERPROFILE 'scoop\apps\nodejs\26.5.0'
$uvReleaseDir = Join-Path $env:USERPROFILE 'scoop\apps\uv\0.12.0'
$env:PATH = "$nodeReleaseDir;$uvReleaseDir;$env:PATH"

node --version
uv --version
npm ci
npm run typecheck
npm test
npm run package:companion
npm run test:package:companion
npm run verify:release-inventory
npm run package:launcher
npm run test:package:launcher
```

Expected: Node prints `v26.5.0`, uv prints `uv 0.12.0`, both release artifact families pass, and generated inventory exactly matches tracked inventory.

- [ ] **Step 5: Verify release artifacts and repository state**

```powershell
npm run verify:vsix
npm run verify:launcher
git diff --check
git status --short
```

Also confirm:

- VSIX has exactly 12 allowed files;
- inventory exists only at `extension/dist/runtime-inventory.json` inside the archive;
- SEA is AMD64 and standalone smoke passes with empty PATH;
- launcher wheel/sdist identity remains 0.1.0;
- root companion remains 0.1.1 and server remains 0.1.0;
- tracked inventory hash equals `$reviewedInventoryHashBefore` unless a separately reviewed official rebuild explicitly changed it;
- no child SEA, Node, uv, named-pipe test, Unity, or VS Code process was left running by validation.

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review` on the complete version-policy diff. Require explicit findings for:

- prerelease/malformed parser bypasses;
- generated versus tracked inventory confusion;
- package path or allowlist regressions;
- extension runtime accepting an unsupported Node identity;
- official workflows accidentally using ranges instead of exact pins;
- normal builds mutating the reviewed inventory.

Address accepted findings through `superpowers:receiving-code-review` and TDD, then rerun both gates.

- [ ] **Step 7: Final commit only after explicit authorization**

If earlier task commits were intentionally deferred, stage only the complete approved version-policy paths plus the already-approved 0.1.1 work requested by the user, inspect `git diff --cached`, and commit with an authorized message. Do not push, tag, or publish without separate explicit authorization.

## Completion Criteria

- Ordinary Node 26.5+ / 26.x and uv 0.12.x builds pass without exact local installation paths.
- Unsupported, prerelease, and malformed tool versions fail before publishable artifacts are produced.
- Every local VSIX contains and validates its own actual bridge inventory at `dist/runtime-inventory.json`.
- The tracked root inventory remains a reviewed exact-release input and is never rewritten by normal builds.
- Exact release workflows still use Node 26.5.0 and uv 0.12.0 and fail if generated SEA identity differs from the reviewed inventory.
- All existing MCP, named-pipe, configuration command, launcher, SEA, and package security tests remain green.
- No protocol, registration schema, package version, or release destination changes.
