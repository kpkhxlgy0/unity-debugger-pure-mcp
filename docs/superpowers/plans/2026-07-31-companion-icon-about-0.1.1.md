# Companion Icon, About, and 0.1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved Protocol Ring icon, polish the repository presentation, prepare and validate companion 0.1.1, and preserve the debugger-before-companion release order.

**Architecture:** Keep one canonical PNG in the extension package and make both the manifest and strict VSIX verifier reference it. Bump only the root companion identity and fixed VSIX artifact name; keep the private MCP server and public PyPI launcher at 0.1.0. Treat GitHub About as externally verified repository metadata and treat real debugger/companion validation as a release gate rather than a code dependency.

**Tech Stack:** VS Code extension manifest, Node.js 26.5.0, Node test runner, Vitest, ImageGen, ImageMagick, VSCE, GitHub CLI, Windows x64 SEA, Unity Debugger Pure API v1.

## Global Constraints

- Final icon is `images/icon.png`, PNG RGB/RGBA, exactly 512 by 512 pixels.
- Icon uses the approved Protocol Ring design: flat near-black navy background, cyan cube and hexagonal connection ring, one coral-red lower-right breakpoint node, no text, glow, gradient, shadow, or third-party mark.
- Root companion version becomes 0.1.1; `server/package.json`, `launcher/pyproject.toml`, launcher source, wheel, and sdist remain 0.1.0.
- Companion artifact is exactly `dist/unity-debugger-pure-mcp-0.1.1.vsix`.
- VSIX gains only `extension/images/icon.png`; Adapter, Mono, Python launcher, source maps, and unlisted files remain forbidden.
- GitHub About description, Marketplace homepage, and eight topics must match the approved design exactly.
- Do not create or push a tag, publish either extension, push a branch, or change MyGame configuration without explicit authorization.
- Public release order is debugger 0.2.0 first, companion 0.1.1 second; launcher 0.1.0 is not republished.
- Real Unity validation must first call Unity MCP `debug_request_context` and verify the active MyGame instance as required by `D:/Unity/TuanjieHub/Projects/MyGame/docs/agent-rules/unity-mcp-validation.md`.

---

### Task 1: Produce and enforce the canonical companion icon

**Files:**
- Create: `images/icon.png`
- Create: `tests/build/icon.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: approved Concept C and `D:/Unity/unity-debugger-vscode/images/icon.png` as visual references.
- Produces: `images/icon.png` and manifest field `icon: "images/icon.png"` for the package and README.

- [ ] **Step 1: Write the failing PNG and manifest contract test**

Create `tests/build/icon.test.mjs` with a test that reads `package.json`, then reads the PNG header without adding an image library:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the companion uses one canonical 512px RGB icon", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(manifest.icon, "images/icon.png");

  const png = fs.readFileSync(manifest.icon);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[24], 8);
  assert.ok(png[25] === 2 || png[25] === 6, "Icon must be RGB or RGBA.");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/build/icon.test.mjs
```

Expected: FAIL because `manifest.icon` is absent and `images/icon.png` does not exist.

- [ ] **Step 3: Generate and normalize the final Protocol Ring asset**

Use built-in ImageGen in edit/reference mode with the debugger icon and selected Concept C. Require flat fills and strokes, no glow/gradient/shadow, no text, and generous padding. Set `$generatedImagePath` to the exact saved path returned by ImageGen, copy that result to the ignored build area, then normalize it without overwriting the debugger icon:

```powershell
New-Item -ItemType Directory -Force images | Out-Null
Copy-Item -LiteralPath $generatedImagePath -Destination dist/icon-source.png
magick dist/icon-source.png -filter Lanczos -resize 512x512! -strip PNG24:images/icon.png
```

Inspect `images/icon.png` at original size, then create ignored previews and inspect both:

```powershell
magick images/icon.png -resize 64x64 dist/icon-preview-64.png
magick images/icon.png -resize 32x32 dist/icon-preview-32.png
```

Reject the asset and regenerate once if the cube, ring, or red breakpoint node becomes ambiguous at either preview size.

- [ ] **Step 4: Declare the icon and run GREEN**

Add this root manifest field next to `displayName`:

```json
"icon": "images/icon.png"
```

Run:

```powershell
node --test tests/build/icon.test.mjs
git diff --check
```

Expected: PASS; PNG is exactly 512 by 512 RGB/RGBA and the manifest points at it.

- [ ] **Step 5: Commit after explicit authorization**

```powershell
git add package.json images/icon.png tests/build/icon.test.mjs
git commit -m "feat: add companion extension icon"
```

---

### Task 2: Bump only the companion identity and preserve the strict VSIX boundary

**Files:**
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`
- Modify: `tests/package/mcp-vsix.test.mjs`
- Modify: `scripts/verify-mcp-vsix.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: canonical `images/icon.png` from Task 1.
- Produces: companion manifest/VSIX identity 0.1.1 and a 12-file audited VSIX allowlist.

- [ ] **Step 1: Change build tests to the intended version split**

Update `tests/build/mcp-companion-scaffold.test.mjs` to require:

```js
assert.equal(manifest.version, "0.1.1");
assert.equal(manifest.icon, "images/icon.png");

const lock = readJson("package-lock.json");
assert.equal(lock.version, "0.1.1");
assert.equal(lock.packages[""].version, "0.1.1");
assert.equal(lock.packages.server.version, "0.1.0");

const launcher = fs.readFileSync("launcher/pyproject.toml", "utf8");
assert.match(launcher, /^version = "0\.1\.0"$/m);
```

Also assert the package scripts use only `unity-debugger-pure-mcp-0.1.1.vsix`; reject any launcher artifact containing `0.1.1`.

- [ ] **Step 2: Change package tests to the intended 0.1.1 archive**

In `tests/package/mcp-vsix.test.mjs`:

```js
const artifactPath = path.join(
  repositoryRoot,
  "dist",
  "unity-debugger-pure-mcp-0.1.1.vsix",
);
```

Add `extension/images/icon.png` to the exact allowlist, require the directory `extension/images/`, and assert:

```js
assert.equal(manifest.version, "0.1.1");
assert.equal(manifest.icon, "images/icon.png");
assert.equal(files.size, 12);
```

Read the packaged icon and repeat the PNG signature, 512-by-512 dimensions, bit-depth, and RGB/RGBA assertions from Task 1.

- [ ] **Step 3: Run the focused tests and verify RED**

Run with exact Node 26.5.0 first on `PATH`:

```powershell
$nodeDir = 'C:\Users\Admin\scoop\apps\nodejs\26.5.0'
$env:PATH = "$nodeDir;$env:PATH"
node --test tests/build/mcp-companion-scaffold.test.mjs tests/package/mcp-vsix.test.mjs
```

Expected: scaffold assertions fail on 0.1.0 and package assertions fail because the 0.1.1 artifact/verifier contract does not exist.

- [ ] **Step 4: Implement the minimal production version and allowlist changes**

Update root `package.json` only:

```json
"version": "0.1.1",
"verify:vsix": "node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.1.vsix",
"package:vsix": "vsce package --no-dependencies --out dist/unity-debugger-pure-mcp-0.1.1.vsix"
```

Regenerate only root lockfile identity:

```powershell
npm install --package-lock-only --ignore-scripts
```

In `scripts/verify-mcp-vsix.mjs`, change the manifest version to 0.1.1, add `extension/images/icon.png` to `required` and `allowedPath`, and add `extension/images/` to `allowedDirectory`. Add a `verifyPngIcon(bytes)` helper that checks the PNG signature, IHDR chunk, 512-by-512 dimensions, 8-bit depth, and color type 2 or 6 before printing success.

Do not change `server/package.json`, `scripts/build-mcp-bridge.mjs`, `launcher/**`, live-host protocol version 1, or generic test fixtures that merely prove arbitrary valid registration version strings.

- [ ] **Step 5: Run the focused tests and verify GREEN**

```powershell
node --test tests/build/icon.test.mjs tests/build/mcp-companion-scaffold.test.mjs
npm run package:companion
npm run test:package:companion
git diff --check
```

Expected: all pass; verifier reports 12 allowlisted files and the package contains no launcher/Adapter/Mono content.

- [ ] **Step 6: Commit after explicit authorization**

```powershell
git add package.json package-lock.json scripts/verify-mcp-vsix.mjs tests/build/mcp-companion-scaffold.test.mjs tests/package/mcp-vsix.test.mjs
git commit -m "build: prepare companion 0.1.1"
```

---

### Task 3: Polish README and changelog without changing launcher guidance

**Files:**
- Create: `tests/build/repository-presentation.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `images/icon.png`, companion version 0.1.1, launcher version 0.1.0.
- Produces: repository header and durable release notes matching the two independent release channels.

- [ ] **Step 1: Write the failing presentation test**

Create `tests/build/repository-presentation.test.mjs` and require the README to contain:

```js
assert.match(readme, /<img src="images\/icon\.png"[^>]+width="128"/);
assert.match(readme, /visual-studio-marketplace\/v\/kpk\.unity-debugger-pure-mcp/);
assert.match(readme, /open-vsx\/v\/kpk\/unity-debugger-pure-mcp/);
assert.match(readme, /pypi\/v\/unity-debugger-pure-mcp/);
assert.match(readme, /actions\/workflows\/ci\.yml\/badge\.svg/);
assert.match(readme, /github\/license\/kpkhxlgy0\/unity-debugger-pure-mcp/);
assert.match(readme, /companion version `0\.1\.1`/);
assert.match(readme, /"unity-debugger-pure-mcp==0\.1\.0"/);
assert.doesNotMatch(readme, /"unity-debugger-pure-mcp==0\.1\.1"/);
assert.match(changelog, /^## 0\.1\.1$/m);
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
node --test tests/build/repository-presentation.test.mjs
```

Expected: FAIL because the icon header, badges, companion 0.1.1 text, and changelog section are absent.

- [ ] **Step 3: Add the approved README header**

Use one centered icon and one centered badge row at the top of `README.md`. Link badges to the Marketplace item, Open VSX extension, PyPI project, CI Actions page, and `LICENSE.txt`. Change only the companion prerequisite text from 0.1.0 to 0.1.1; retain the exact public launcher pin:

```toml
"unity-debugger-pure-mcp==0.1.0"
```

Keep the historical statement that the initial Marketplace listing was 0.1.0.

- [ ] **Step 4: Add changelog entry 0.1.1**

Prepend:

```markdown
## 0.1.1

- Added a dedicated companion icon aligned with Unity Debugger Pure.
- Added repository discovery metadata and release-channel badges.
- Kept the external `uvx` launcher pinned independently at version 0.1.0.
```

- [ ] **Step 5: Run GREEN and commit after explicit authorization**

```powershell
node --test tests/build/repository-presentation.test.mjs tests/build/external-launcher-docs.test.mjs
git diff --check
git add README.md CHANGELOG.md tests/build/repository-presentation.test.mjs
git commit -m "docs: polish companion repository presentation"
```

Expected: both documentation contracts pass; launcher remains pinned to 0.1.0.

---

### Task 4: Set and verify exact GitHub About metadata

**Files:**
- No repository files.

**Interfaces:**
- Consumes: public repository `kpkhxlgy0/unity-debugger-pure-mcp` and existing Marketplace item.
- Produces: exact GitHub description, homepage, and topics.

- [ ] **Step 1: Capture current metadata before mutation**

```powershell
gh repo view kpkhxlgy0/unity-debugger-pure-mcp --json description,homepageUrl,repositoryTopics,url
```

Expected current baseline: short description, empty homepage, and no topics. Stop if the repository owner/name differs.

- [ ] **Step 2: Update description and Marketplace homepage**

```powershell
gh api --method PATCH repos/kpkhxlgy0/unity-debugger-pure-mcp `
  -f description='VS Code MCP companion for inspecting and controlling Unity and Tuanjie debug sessions with Unity Debugger Pure.' `
  -f homepage='https://marketplace.visualstudio.com/items?itemName=kpk.unity-debugger-pure-mcp'
```

- [ ] **Step 3: Replace topics atomically**

```powershell
@{
  names = @(
    'unity',
    'tuanjie',
    'vscode-extension',
    'mcp',
    'model-context-protocol',
    'debugger',
    'debug-adapter-protocol',
    'codex'
  )
} | ConvertTo-Json | gh api --method PUT repos/kpkhxlgy0/unity-debugger-pure-mcp/topics --input -
```

- [ ] **Step 4: Read back public metadata**

```powershell
gh repo view kpkhxlgy0/unity-debugger-pure-mcp --json description,homepageUrl,repositoryTopics,url
```

Expected: description and homepage match exactly; topic names equal the approved eight-name set with no extras.

---

### Task 5: Run automated release gates and inspect the final artifacts

**Files:**
- Generated/ignored: `dist/unity-debugger-pure-mcp-0.1.1.vsix`
- Generated/ignored: `dist/icon-preview-64.png`
- Generated/ignored: `dist/icon-preview-32.png`
- Generated/ignored in debugger repo: `D:/Unity/unity-debugger-vscode/dist/unity-debugger-pure-0.2.0.vsix`

**Interfaces:**
- Consumes: completed Tasks 1–4 and local debugger master `8808192` or its exact successor containing API v1.
- Produces: fresh automated evidence and exact VSIX files for combined validation.

- [ ] **Step 1: Verify both source trees and required versions**

```powershell
git -C D:\Unity\unity-debugger-pure-mcp status --short
git -C D:\Unity\unity-debugger-pure-mcp branch --show-current
git -C D:\Unity\unity-debugger-vscode status --short
git -C D:\Unity\unity-debugger-vscode branch --show-current
node -p "require('D:/Unity/unity-debugger-pure-mcp/package.json').version"
node -p "require('D:/Unity/unity-debugger-vscode/package.json').version"
uv version --project D:\Unity\unity-debugger-pure-mcp\launcher --short
```

Expected: no unrelated changes; versions are companion 0.1.1, debugger 0.2.0, launcher 0.1.0.

- [ ] **Step 2: Run the complete companion gate with exact Node 26.5.0**

```powershell
$nodeDir = 'C:\Users\Admin\scoop\apps\nodejs\26.5.0'
$node260 = Join-Path $nodeDir 'node.exe'
$npm260 = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
$env:PATH = "$nodeDir;$env:PATH"
& $node260 $npm260 ci
& $node260 $npm260 run typecheck
& $node260 $npm260 test
& $node260 $npm260 run package
& $node260 $npm260 run test:package
```

Expected: all extension, server, integration, launcher, SEA, VSIX, and artifact tests pass. Confirm packaging does not rewrite `runtime-inventory.json`.

- [ ] **Step 3: Rebuild and audit debugger 0.2.0**

From `D:/Unity/unity-debugger-vscode` with the same Node directory first on `PATH`:

```powershell
& $node260 $npm260 ci
dotnet restore UnityDebugger.sln --locked-mode
& $node260 $npm260 run typecheck
& $node260 $npm260 test
& $node260 $npm260 run package
& $node260 $npm260 run verify:vsix
```

Expected: debugger API/extension/Adapter/integration/package suites pass and the exact 0.2.0 VSIX is audited.

- [ ] **Step 4: Inspect visual and archive boundaries**

Use the image viewer on `images/icon.png`, `dist/icon-preview-64.png`, and `dist/icon-preview-32.png`. Then inspect the companion archive and require exactly one new packaged path relative to 0.1.0:

```text
extension/images/icon.png
```

Record SHA-256 values for both VSIX files, but do not treat them as stable until no further file changes remain.

---

### Task 6: Perform the combined MyGame acceptance gate without Computer Use

**Files:**
- No product source files.
- Optional project configuration requires separate explicit authorization: `D:/Unity/TuanjieHub/Projects/MyGame/.codex/config.toml`.

**Interfaces:**
- Consumes: exact audited debugger 0.2.0 VSIX, companion 0.1.1 VSIX, public launcher 0.1.0, trusted MyGame workspace, and its Tuanjie Editor.
- Produces: evidence that debugger API v1 and one real MCP inspection/control flow work together.

- [ ] **Step 1: Install the exact local VSIX files**

After confirming the intended VS Code CLI/profile, run:

```powershell
code --install-extension D:\Unity\unity-debugger-vscode\dist\unity-debugger-pure-0.2.0.vsix --force
code --install-extension D:\Unity\unity-debugger-pure-mcp\dist\unity-debugger-pure-mcp-0.1.1.vsix --force
```

Ask the user to reload the VS Code window opened from MyGame. Do not use Computer Use unless the user separately requests it.

- [ ] **Step 2: Verify the correct Unity/Tuanjie instance before debugging**

Use Unity MCP `debug_request_context`. Require `session_state.active_instance` to identify the MyGame project and report its MCP port. If Unity MCP is unavailable, ask whether the Editor is closed and do not claim real validation.

- [ ] **Step 3: Make the external MCP client available**

If project-scoped Codex configuration is still absent, stop and request explicit authorization before writing:

```toml
[mcp_servers.unity_debugger_pure]
command = "uvx"
args = [
  "--from",
  "unity-debugger-pure-mcp==0.1.0",
  "unity-debugger-pure-mcp"
]
startup_timeout_sec = 60
tool_timeout_sec = 70
enabled = true
required = false
```

Restart Codex after configuration so tool discovery is refreshed.

- [ ] **Step 4: Run one real debugger MCP flow**

Against the verified MyGame instance:

1. call `unity_debug_list_targets` and select only the discovered MyGame target;
2. call `unity_debug_attach` and require a visible VS Code debug session backed by debugger API v1;
3. call `unity_debug_status`, then `unity_debug_pause`;
4. call `unity_debug_wait_for_event` and require a normalized stopped event;
5. call `unity_debug_snapshot`, `unity_debug_threads`, `unity_debug_stack_trace`, `unity_debug_scopes`, and `unity_debug_variables` using only opaque references;
6. call `unity_debug_evaluate_safe` on a side-effect-free local value;
7. call `unity_debug_continue`, then `unity_debug_disconnect` without terminating the shared VS Code session unless explicitly requested.

Require no stale raw DAP IDs in tool output, no unexpected Unity Console errors/warnings, and successful reconnection after a VS Code reload if reload behavior is exercised.

- [ ] **Step 5: Record the release gate result**

Report the exact debugger/companion VSIX SHA-256 values, verified MyGame instance and port, tools exercised, and any skipped UI-only observation. Do not claim release readiness if the active instance, attach, stopped snapshot, safe evaluation, or continue path was not verified.

---

### Task 7: Prepare the ordered release handoff

**Files:**
- No new product files.

**Interfaces:**
- Consumes: clean code review, automated gates, combined MyGame acceptance, and exact artifacts.
- Produces: an authorization-ready release checklist; performs no publication by itself.

- [ ] **Step 1: Verify repository status and review diff**

```powershell
git status --short
git diff master...HEAD --check
git log --oneline master..HEAD
```

Request a final code review. Resolve any Important/Critical findings and rerun Tasks 5–6 before proceeding.

- [ ] **Step 2: Obtain separate Git authorizations**

Do not commit remaining changes, merge, or push until the user explicitly authorizes each operation under the current task. Keep the existing branch intact otherwise.

- [ ] **Step 3: Publish debugger 0.2.0 first only after authorization**

Push the debugger API commit and follow the debugger repository's release process. Require public Marketplace/Open VSX/GitHub evidence for debugger 0.2.0 before touching `companion-v0.1.1`.

- [ ] **Step 4: Publish companion 0.1.1 second only after authorization**

Provide the exact `dist/unity-debugger-pure-mcp-0.1.1.vsix` for manual Marketplace upload. After the user confirms that upload and explicitly authorizes the companion release, create and push exactly:

```powershell
git tag -a companion-v0.1.1 -m "Unity Debugger Pure MCP companion 0.1.1"
git push origin companion-v0.1.1
```

Require the workflow to publish only the audited VSIX and SHA sidecar to Open VSX/GitHub Release. Verify Marketplace, Open VSX, and GitHub Release all report companion 0.1.1. Do not create `launcher-v0.1.1` or publish PyPI.
