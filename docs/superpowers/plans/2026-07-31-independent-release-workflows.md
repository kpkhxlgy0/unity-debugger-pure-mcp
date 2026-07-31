# Independent Companion and Launcher Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coupled `v*` release with independent companion VSIX and Python launcher release streams.

**Architecture:** Keep one repository and one cross-product CI gate, but give each product a separate packaging command, tag prefix, workflow, artifact handoff, registry credential boundary, and GitHub Release. `companion-v<version>` publishes only the audited VSIX to Open VSX and GitHub; `launcher-v<version>` publishes only the audited wheel and sdist to PyPI and GitHub.

**Tech Stack:** GitHub Actions YAML, Node.js 26.5.0, npm, `@vscode/vsce` 3.9.2, `ovsx` 1.0.2, uv 0.12.0, Python 3.10, PyPI Trusted Publishing, Node test runner, js-yaml 4.3.0.

## Global Constraints

- Work only in `D:\Unity\unity-debugger-pure-mcp` on an ordinary Git branch; do not create a worktree.
- Preserve the complete `npm run package` and `npm run test:package` commands as local/CI gates.
- Companion versions come only from root `package.json`; launcher versions come only from `launcher/pyproject.toml`.
- Companion tags are exactly `companion-v<version>`; launcher tags are exactly `launcher-v<version>`.
- VS Code Marketplace remains manual and must never receive a credential or upload command from GitHub Actions.
- Open VSX receives only the audited VSIX and reads `OVSX_PAT` only from the `openvsx` GitHub Environment.
- PyPI receives only the audited wheel and sdist through the `pypi` Environment with job-scoped `id-token: write`; no PyPI token is stored.
- A companion GitHub Release contains only the VSIX and SHA-256 sidecar. A launcher GitHub Release contains only the wheel, sdist, and their SHA-256 sidecars.
- Do not create or push a tag, create a GitHub Release, publish Open VSX/PyPI, or modify MyGame configuration without a fresh explicit user authorization.
- The already completed one-time Marketplace listing is `kpk.unity-debugger-pure-mcp` version `0.1.0`.

---

### Task 1: Split local packaging and package-test entry points

**Files:**
- Modify: `package.json`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`
- Modify: `tests/package/mcp-vsix.test.mjs`

**Interfaces:**
- Consumes: existing `build:extension`, `build:bridge`, `build:launcher`, `package:vsix`, `verify:vsix`, and `verify:launcher` scripts.
- Produces: `package:companion`, `package:launcher`, `test:package:companion`, and `test:package:launcher` commands used by Tasks 2 and 3.

- [ ] **Step 1: Add failing script-boundary assertions**

Extend `normal scripts typecheck and test both standalone programs` in `tests/build/mcp-companion-scaffold.test.mjs` with these literal contracts:

```js
assert.equal(
  scripts["package:companion"],
  "npm run build:extension && npm run build:bridge && npm run package:vsix && npm run verify:vsix",
);
assert.equal(
  scripts["package:launcher"],
  "npm run build:launcher && npm run verify:launcher",
);
assert.equal(
  scripts["test:package:companion"],
  "node --test tests/package/mcp-vsix.test.mjs",
);
assert.equal(
  scripts["test:package:launcher"],
  "node --test tests/package/launcher-package.test.mjs",
);
assert.equal(
  scripts["test:package"],
  "npm run test:package:companion && npm run test:package:launcher",
);
assert.equal(
  scripts.package,
  "npm run package:companion && npm run package:launcher",
);
```

- [ ] **Step 2: Run the focused test and record the expected RED**

Run:

```powershell
node --test tests/build/mcp-companion-scaffold.test.mjs
```

Expected: FAIL because the four product-specific scripts do not exist and the two aggregate scripts still use the coupled commands.

- [ ] **Step 3: Add the minimal independent scripts**

Replace only the package-related entries in root `package.json`:

```json
"test:package:companion": "node --test tests/package/mcp-vsix.test.mjs",
"test:package:launcher": "node --test tests/package/launcher-package.test.mjs",
"test:package": "npm run test:package:companion && npm run test:package:launcher",
"package:companion": "npm run build:extension && npm run build:bridge && npm run package:vsix && npm run verify:vsix",
"package:launcher": "npm run build:launcher && npm run verify:launcher",
"package": "npm run package:companion && npm run package:launcher"
```

In `tests/package/mcp-vsix.test.mjs`, change the nested npm invocation from `package` to `package:companion`. Keep its inventory, allowlist, PE, no-launcher, and tamper assertions unchanged.

- [ ] **Step 4: Run focused GREEN verification**

Run with Node 26.5.0 first on `PATH`:

```powershell
node --test tests/build/mcp-companion-scaffold.test.mjs
npm run package:companion
npm run test:package:companion
npm run package:launcher
npm run test:package:launcher
```

Expected: all commands exit 0; the companion command trace never invokes
`build:launcher`, and the launcher command trace never invokes
`build:extension`, `build:bridge`, or `package:vsix`.

- [ ] **Step 5: Verify the aggregate gates remain equivalent**

Run:

```powershell
npm run package
npm run test:package
```

Expected: the VSIX, wheel, and sdist pass the existing independent audits and real uvx integration.

- [ ] **Step 6: Commit the packaging boundary**

```powershell
git add package.json tests/build/mcp-companion-scaffold.test.mjs tests/package/mcp-vsix.test.mjs
git commit -m "build: split companion and launcher packaging"
```

---

### Task 2: Add the companion-only Open VSX and GitHub release workflow

**Files:**
- Delete: `.github/workflows/release.yml`
- Create: `.github/workflows/release-companion.yml`
- Modify: `tests/build/workflows.test.mjs`

**Interfaces:**
- Consumes: `package:companion`, `test:package:companion`, root `package.json#version`, the `openvsx` Environment, and `OVSX_PAT`.
- Produces: tag contract `companion-v<root-version>`, artifact `companion-release`, an Open VSX version, and a companion-only GitHub Release.

- [ ] **Step 1: Replace the coupled-workflow test with a failing companion contract**

Add a test named `companion tags publish only the audited VSIX to Open VSX and GitHub` in `tests/build/workflows.test.mjs`. Parse `.github/workflows/release-companion.yml` and assert:

```js
assert.equal(fs.existsSync(".github/workflows/release.yml"), false);
assert.deepEqual(workflow.on.push.tags, ["companion-v*"]);
assert.equal(build["runs-on"], "windows-latest");
assert.deepEqual(build.permissions, { contents: "read" });
assert.match(runBodies(build), /package\.json/);
assert.match(runBodies(build), /companion-v/);
assert.match(runBodies(build), /npm run package:companion/);
assert.match(runBodies(build), /npm run test:package:companion/);
assert.doesNotMatch(runBodies(build), /package:launcher|test:package:launcher|PyPI|pypi/);
assert.equal(openvsx.needs, "build-companion");
assert.equal(openvsx.environment, "openvsx");
assert.equal(openvsx.steps.some((step) => step.uses === "actions/download-artifact@v4"), true);
assert.match(runBodies(openvsx), /npx --yes ovsx@1\.0\.2 publish/);
assert.equal(openvsx.steps.find((step) => typeof step.run === "string").env.OVSX_PAT, "${{ secrets.OVSX_PAT }}");
assert.doesNotMatch(runBodies(openvsx), /--pat|vsce publish|marketplace/i);
assert.equal(githubRelease.needs, "publish-openvsx");
assert.deepEqual(githubRelease.permissions, { contents: "write" });
assert.match(runBodies(githubRelease), /gh release create/);
assert.doesNotMatch(runBodies(githubRelease), /\.whl|\.tar\.gz|PyPI|pypi/);
```

Also assert the uploaded `companion-release` artifact path list is exactly the versioned VSIX plus its `.sha256` sidecar.

- [ ] **Step 2: Run the workflow test and record the expected RED**

Run:

```powershell
node --test tests/build/workflows.test.mjs
```

Expected: FAIL because `release-companion.yml` is absent and the coupled `release.yml` still exists.

- [ ] **Step 3: Create `release-companion.yml`**

Implement three jobs:

1. `build-companion` on `windows-latest`, with `contents: read`, Node
   `26.5.0`, uv `0.12.0`/Python `3.10`, `npm ci`, `npm run typecheck`,
   `npm test`, strict tag comparison against root `package.json`,
   `npm run package:companion`, `npm run test:package:companion`, SHA-256
   creation, and `actions/upload-artifact@v4` for only the VSIX and sidecar.
2. `publish-openvsx` on `ubuntu-latest`, `needs: build-companion`, `environment: openvsx`, no write permissions, `actions/download-artifact@v4`, and this token-safe command:

```yaml
- name: Publish audited VSIX to Open VSX
  run: npx --yes ovsx@1.0.2 publish "dist/unity-debugger-pure-mcp-${{ needs.build-companion.outputs.version }}.vsix"
  env:
    OVSX_PAT: ${{ secrets.OVSX_PAT }}
```

3. `github-release` on `ubuntu-latest`, `needs: publish-openvsx`, `contents: write`, download of `companion-release`, and `gh release create` with only the VSIX and its sidecar.

The build job must expose the root manifest version as a job output and reject any tag other than `companion-v<version>`. Delete the old `.github/workflows/release.yml` in the same change.

- [ ] **Step 4: Run companion workflow GREEN verification**

Run:

```powershell
node --test tests/build/workflows.test.mjs
npm run package:companion
npm run test:package:companion
node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix
```

Expected: all commands exit 0; workflow tests prove there is no launcher/PyPI path in the companion release.

- [ ] **Step 5: Commit the companion workflow**

```powershell
git add .github/workflows/release.yml .github/workflows/release-companion.yml tests/build/workflows.test.mjs
git commit -m "build: add independent companion releases"
```

---

### Task 3: Add the launcher-only PyPI and GitHub release workflow

**Files:**
- Create: `.github/workflows/release-launcher.yml`
- Modify: `tests/build/workflows.test.mjs`

**Interfaces:**
- Consumes: `package:launcher`, `test:package:launcher`, `launcher/pyproject.toml#project.version`, and the existing `pypi` Environment.
- Produces: tag contract `launcher-v<launcher-version>`, artifacts `pypi-distributions` and `launcher-release`, a PyPI release, and a launcher-only GitHub Release.

- [ ] **Step 1: Add a failing launcher workflow contract**

Add a test named `launcher tags publish only audited Python distributions to PyPI and GitHub` in `tests/build/workflows.test.mjs`. Assert:

```js
assert.deepEqual(workflow.on.push.tags, ["launcher-v*"]);
assert.equal(build["runs-on"], "windows-latest");
assert.deepEqual(build.permissions, { contents: "read" });
assert.match(runBodies(build), /launcher\/pyproject\.toml/);
assert.match(runBodies(build), /launcher-v/);
assert.match(runBodies(build), /npm run package:launcher/);
assert.match(runBodies(build), /npm run test:package:launcher/);
assert.doesNotMatch(runBodies(build), /package:companion|test:package:companion|\.vsix|Open VSX|ovsx/i);
assert.equal(pypi.needs, "build-launcher");
assert.deepEqual(pypi.environment, {
  name: "pypi",
  url: "https://pypi.org/p/unity-debugger-pure-mcp",
});
assert.deepEqual(pypi.permissions, { "id-token": "write" });
assert.equal(pypi.steps.some((step) => step.uses === "pypa/gh-action-pypi-publish@release/v1"), true);
assert.equal(runBodies(pypi), "");
assert.equal(githubRelease.needs, "pypi-publish");
assert.deepEqual(githubRelease.permissions, { contents: "write" });
assert.match(runBodies(githubRelease), /gh release create/);
assert.doesNotMatch(runBodies(githubRelease), /\.vsix|Open VSX|ovsx/i);
```

Assert the `pypi-distributions` artifact contains exactly the wheel and sdist, while `launcher-release` contains exactly those two files plus their SHA-256 sidecars.

- [ ] **Step 2: Run the workflow test and record the expected RED**

Run:

```powershell
node --test tests/build/workflows.test.mjs
```

Expected: FAIL because `release-launcher.yml` does not exist.

- [ ] **Step 3: Create `release-launcher.yml`**

Implement three jobs:

1. `build-launcher` on `windows-latest`, with `contents: read`, Node
   `26.5.0`, uv `0.12.0`/Python `3.10`, `npm ci`, `npm run typecheck`,
   `npm test`, strict extraction of `[project].version` from
   `launcher/pyproject.toml`, rejection of tags other than
   `launcher-v<version>`, `npm run package:launcher`,
   `npm run test:package:launcher`, SHA-256 sidecars, and two exact artifact
   uploads.
2. `pypi-publish` on `ubuntu-latest`, `needs: build-launcher`, the `pypi` Environment, only `id-token: write`, download of `pypi-distributions` into `dist`, and `pypa/gh-action-pypi-publish@release/v1` with `packages-dir: dist`.
3. `github-release` on `ubuntu-latest`, `needs: pypi-publish`, `contents: write`, download of `launcher-release`, and `gh release create` with only the wheel, sdist, and two sidecars.

The build job must expose the launcher version as an output. Neither publishing job checks out source or receives a long-lived PyPI credential.

- [ ] **Step 4: Run launcher workflow GREEN verification**

Run:

```powershell
node --test tests/build/workflows.test.mjs
npm run package:launcher
npm run test:package:launcher
uv run --project launcher --locked --python 3.10 python launcher/scripts/verify_artifacts.py dist/launcher
```

Expected: all commands exit 0; workflow tests prove there is no VSIX/Open VSX path in the launcher release.

- [ ] **Step 5: Commit the launcher workflow**

```powershell
git add .github/workflows/release-launcher.yml tests/build/workflows.test.mjs
git commit -m "build: add independent launcher releases"
```

---

### Task 4: Document release ownership and configure publication identities

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/superpowers/plans/2026-07-31-unity-debugger-pure-mcp-pypi-launcher.md`

**Interfaces:**
- Consumes: the workflow/tag/environment contracts from Tasks 2 and 3.
- Produces: operator instructions that distinguish manual Marketplace, Open VSX automation, and PyPI Trusted Publishing without exposing credentials.

- [ ] **Step 1: Update human release documentation**

Add a concise `Release channels` section to `README.md` containing these exact facts:

```text
VS Code Marketplace: manual upload under kpk; initial 0.1.0 listing exists.
Open VSX and companion GitHub Release: companion-v<version>.
PyPI and launcher GitHub Release: launcher-v<version>.
```

Add to `SECURITY.md` that `OVSX_PAT` belongs only in the `openvsx` GitHub Environment, PyPI uses OIDC without a stored token, and release logs/configuration must never contain Open VSX/PyPI tokens.

Mark the former coupled-release/publication steps in the older implementation plan as superseded by the approved independent-release specification and this plan. Do not rewrite historical implementation evidence.

- [ ] **Step 2: Run documentation-adjacent workflow tests**

Run:

```powershell
node --test tests/build/workflows.test.mjs tests/build/external-launcher-docs.test.mjs
git diff --check
```

Expected: PASS. Do not add grep-only prose tests; release behavior remains enforced through parsed workflows and executable package tests.

- [ ] **Step 3: Commit release documentation**

```powershell
git add README.md SECURITY.md docs/superpowers/plans/2026-07-31-unity-debugger-pure-mcp-pypi-launcher.md
git commit -m "docs: document independent release channels"
```

- [ ] **Step 4: Stop for account-bound setup authorization**

Before mutating external settings, obtain explicit authorization. Then:

1. create the GitHub Environment `openvsx` without embedding any token in workflow YAML;
2. have the user create/verify namespace `kpk` and an Open VSX token at `https://open-vsx.org/user-settings/tokens`;
3. have the user store it as Environment secret `OVSX_PAT` through GitHub Settings, or interactively with `gh secret set OVSX_PAT --env openvsx --repo kpkhxlgy0/unity-debugger-pure-mcp` without echoing the value;
4. verify the existing GitHub Environment `pypi`; and
5. configure the PyPI Pending Trusted Publisher with project `unity-debugger-pure-mcp`, owner `kpkhxlgy0`, repository `unity-debugger-pure-mcp`, workflow `release-launcher.yml`, and environment `pypi`.

Do not store, print, copy into a command argument, or request that the user send `OVSX_PAT` through chat.

---

### Task 5: Run release gates and perform separately authorized first releases

**Files:**
- No source changes expected.
- Generated/ignored: `dist/unity-debugger-pure-mcp-0.1.0.vsix`
- Generated/ignored: `dist/launcher/unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl`
- Generated/ignored: `dist/launcher/unity_debugger_pure_mcp-0.1.0.tar.gz`
- Conditionally modify after public launcher verification: `D:\Unity\TuanjieHub\Projects\MyGame\.codex\config.toml`

**Interfaces:**
- Consumes: merged workflows, Open VSX environment secret, Pending Trusted Publisher, and the manually created Marketplace listing.
- Produces: public companion `0.1.0`, public launcher `0.1.0`, and verified project-scoped Codex startup.

- [ ] **Step 1: Run the complete committed-source release gate**

With `C:\Users\Admin\scoop\apps\nodejs\26.5.0` first on process `PATH`, run:

```powershell
npm ci
npm run typecheck
npm test
npm run package
npm run test:package
git diff --check
git status --short
```

Expected: every command exits 0; `git status --short` is empty; the SEA inventory still matches; VSIX remains the strict 11-file package; launcher audit finds exactly one wheel and one sdist.

- [ ] **Step 2: Push the implementation branch and require green CI**

Push only after explicit authorization. Wait for the CI run on the exact branch HEAD and require `conclusion: success` for install, typecheck, tests, package, and package tests.

- [ ] **Step 3: Merge without creating a release**

Merge only after explicit authorization. Confirm no `companion-v*` or `launcher-v*` tag was created and no Release/Open VSX/PyPI publication occurred during merge.

- [ ] **Step 4: Publish the companion release under a separate authorization**

After the user explicitly authorizes companion release `0.1.0`:

```powershell
git tag -a companion-v0.1.0 -m "Unity Debugger Pure MCP companion 0.1.0"
git push origin companion-v0.1.0
```

Wait for `release-companion.yml`. Require successful Open VSX publication and a GitHub Release whose assets are only `unity-debugger-pure-mcp-0.1.0.vsix` and its `.sha256`. Verify the Marketplace listing remains `0.1.0` and the Open VSX listing reports `0.1.0`.

- [ ] **Step 5: Publish the launcher release under a separate authorization**

Recheck that `https://pypi.org/pypi/unity-debugger-pure-mcp/json` is still absent. After the user explicitly authorizes launcher release `0.1.0`:

```powershell
git tag -a launcher-v0.1.0 -m "Unity Debugger Pure MCP launcher 0.1.0"
git push origin launcher-v0.1.0
```

Wait for `release-launcher.yml`. Require successful Trusted Publishing and a GitHub Release whose assets are only the wheel, sdist, and their two `.sha256` files.

- [ ] **Step 6: Verify the exact public launcher**

With the trusted MyGame VS Code window and companion active, run:

```powershell
uvx --refresh --from unity-debugger-pure-mcp==0.1.0 unity-debugger-pure-mcp
```

Verify initialize and `tools/list` expose exactly 19 tools, then use MCP calls for the real debugger acceptance. Use Unity MCP for Unity-side triggers; request Computer Use only if no MCP-accessible Unity action can trigger the chosen code path.

- [ ] **Step 7: Add project configuration only after public verification**

Preserve all existing MyGame MCP tables and append exactly:

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

Do not commit MyGame configuration without separate explicit commit authorization. Restart the Codex task to reload project MCP configuration; reload VS Code only if its VSIX was installed or upgraded.
