# Unity Debugger Pure MCP Repository Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Unity Debugger Pure MCP into a self-contained local Git repository with preserved relevant history, then remove its implementation from the debugger repository while retaining debugger API v1.

**Architecture:** Build an audited history extractor in the source repository, use it to create a filtered local repository, and normalize the filtered tree so the VS Code extension lives at the new repository root with a private server workspace. Verify the independent repository completely before making one cleanup commit in the debugger repository.

**Tech Stack:** Git plumbing, Node.js 26.5.0, npm workspaces, TypeScript 7, Vitest 4, Node test runner, esbuild, VS Code 1.101 MCP APIs, MCP SDK 1.30, Zod 4, Node SEA, VSCE, PowerShell, Windows x64.

## Global Constraints

- Source repository: `D:/Unity/unity-debugger-vscode`.
- Source branch: `feature/unity-debugger-pure-mcp`.
- Target repository: `D:/Unity/unity-debugger-pure-mcp`; it must not exist before extraction.
- Use ordinary Git branches and local clones only; do not create a worktree.
- New repository implementation branch: `codex/standalone-repository`.
- Preserve relevant commit authors, timestamps, messages, and order; rewritten commit IDs are expected.
- The target repository must have no configured remote.
- Do not create or push a GitHub repository and do not publish a release or registry package.
- Root extension identity remains `kpk.unity-debugger-pure-mcp` version `0.1.0`.
- Manifest dependency remains exactly `kpk.unity-debugger-pure`.
- Debugger dependency contract remains public API version 1; do not import debugger-internal source.
- VS Code engine remains `^1.101.0` and `@types/vscode` remains exactly `1.101.0`.
- Runtime dependencies remain `@modelcontextprotocol/sdk` `1.30.0` and `zod` `4.4.3` inside the private server workspace.
- SEA builds require exact Node `v26.5.0` and Windows AMD64.
- Companion VSIX must contain no Adapter, Mono runtime, source, source maps, Git metadata, tests, or `node_modules`.
- Do not change MCP tool semantics, bridge protocol behavior, debugger behavior, or public API v1.
- Do not start Unity/Tuanjie, a separate VS Code profile, Computer Use, or real-Editor testing.
- Do not clean the debugger repository until every independent-repository gate passes.

---

## File and Responsibility Map

### Source migration tooling

- Create `scripts/extract-mcp-history.mjs`: safety checks, allowlisted Git rewrite, remote removal, and provenance.
- Create `tests/build/extract-mcp-history.test.mjs`: disposable-repository tests for metadata, content, pruning, collisions, and source immutability.

### Independent repository

- Move `mcp-extension/src/` to `src/` and promote its manifest, config, docs, notices, and inventory to the root.
- Move `mcp-server/` to `server/`.
- Rename `tests/mcp-extension/` to `tests/extension/` and `tests/mcp-server/` to `tests/server/`.
- Keep the MCP integration, package, stdout, build, and audit files with standalone paths.
- Create root Vitest, ignore, CI, release, lockfile, and provenance files.

### Debugger repository

- Remove companion workspaces, commands, dependencies, source, tests, scripts, and companion-owned documents.
- Keep API v1 implementation, tests, version `0.2.0`, and base package/release audits.
- Keep `scripts/verify-vsix.mjs` rejection of MCP payloads as defense in depth.
- Add a repository-boundary regression test.

---

### Task 1: Build and test the audited history extractor

**Repository:** `D:/Unity/unity-debugger-vscode`

**Files:**
- Create: `scripts/extract-mcp-history.mjs`
- Create: `tests/build/extract-mcp-history.test.mjs`

**Interfaces:**
- Produces: `extractStandaloneHistory(options): Promise<ExtractionReport>`.
- Produces: `COMPANION_PATHS` as the reviewed allowlist.
- Consumes: Git, local paths, and an exact source commit.

- [ ] **Step 1: Write failing miniature-repository tests**

Create a fixture source with a debugger-only commit, companion commit, mixed commit, companion-test commit, and debugger-only tail. Assert:

```js
const report = await extractStandaloneHistory({
  source: sourcePath,
  sourceRef: sourceHead,
  target: targetPath,
});
assert.deepEqual(
  git(targetPath, ["log", "--reverse", "--format=%s"]).trim().split(/\r?\n/),
  ["add companion source", "change both products", "test companion"],
);
assert.equal(
  git(targetPath, ["show", "HEAD:mcp-extension/src/extension.ts"]),
  git(sourcePath, ["show", sourceHead + ":mcp-extension/src/extension.ts"]),
);
assert.equal(git(targetPath, ["remote"]).trim(), "");
assert.equal(git(sourcePath, ["rev-parse", "HEAD"]).trim(), sourceHead);
assert.equal(report.retainedCommits.length, 3);
```

Add cases for author/committer metadata and message preservation, debugger-path exclusion, existing-target rejection, dirty-source rejection, non-HEAD `sourceRef`, and source immutability after target failure.

- [ ] **Step 2: Run tests and verify the module is absent**

Run: `node --test tests/build/extract-mcp-history.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Define the exact allowlist**

```js
export const COMPANION_PATHS = Object.freeze([
  "mcp-extension",
  "mcp-server",
  "scripts/build-mcp-bridge.mjs",
  "scripts/mcp-smoke-stdout.mjs",
  "scripts/verify-mcp-vsix.mjs",
  "scripts/extract-mcp-history.mjs",
  "tests/build/mcp-companion-scaffold.test.mjs",
  "tests/build/extract-mcp-history.test.mjs",
  "tests/integration/mcpCompanion.integration.test.ts",
  "tests/mcp-extension",
  "tests/mcp-server",
  "tests/package/mcp-smoke-stdout.test.mjs",
  "tests/package/mcp-vsix.test.mjs",
  "docs/superpowers/specs/2026-07-30-unity-debugger-pure-mcp-companion-design.md",
  "docs/superpowers/specs/2026-07-30-unity-debugger-pure-mcp-repository-split-design.md",
  "docs/superpowers/plans/2026-07-30-mcp-companion-core.md",
  "docs/superpowers/plans/2026-07-30-mcp-external-bridge-release.md",
  "docs/superpowers/plans/2026-07-30-unity-debugger-pure-mcp-repository-split.md",
]);
```

Do not include the debugger API plan, root manifests/workflows, Adapter, `extension/src`, or base tests.

- [ ] **Step 4: Implement safety validation and clone creation**

```js
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Command failed: " + command + " " + args.join(" "));
  }
  return result.stdout;
}

function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

export async function extractStandaloneHistory(options) {
  const source = path.resolve(options.source);
  const target = path.resolve(options.target);
  const sourceRoot = git(source, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(source, ["rev-parse", "HEAD"]).trim();
  if (!samePath(source, sourceRoot) || options.sourceRef !== head) {
    throw new Error("Source must be the clean repository root at the requested HEAD.");
  }
  if (git(source, ["status", "--porcelain"]) !== "") {
    throw new Error("Source repository must have a clean tracked and untracked state.");
  }
  if (fs.existsSync(target)) {
    throw new Error("Target path already exists.");
  }
  run("git", ["clone", "--no-checkout", "--no-local", source, target]);
  git(target, ["remote", "remove", "origin"]);
}
```

Compare Windows paths case-insensitively and reject any target within the source. Retain a failed target for diagnosis; never delete it automatically.

- [ ] **Step 5: Implement deterministic history rewriting**

Enumerate with:

```powershell
git rev-list --reverse --topo-order <source-ref> -- <allowlisted-paths>
```

For each commit, read allowlisted entries with `git ls-tree -rz`, populate an isolated `GIT_INDEX_FILE`, write the filtered tree, prune duplicate trees, parse raw metadata/message with `git cat-file commit`, and create the replacement with `git commit-tree` and the previous retained commit as parent.

```js
const commitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: metadata.author.name,
  GIT_AUTHOR_EMAIL: metadata.author.email,
  GIT_AUTHOR_DATE: metadata.author.timestamp + " " + metadata.author.timezone,
  GIT_COMMITTER_NAME: metadata.committer.name,
  GIT_COMMITTER_EMAIL: metadata.committer.email,
  GIT_COMMITTER_DATE:
    metadata.committer.timestamp + " " + metadata.committer.timezone,
};
```

Update `refs/heads/master`, delete other local refs/tags, check out `master`, and verify every final path is allowlisted.

- [ ] **Step 6: Emit provenance**

Return schema version 1, fixed source repository/branch, `sourceCommit`, source-to-target commit mapping with author/committer dates, and per-file Git blob plus SHA-256. Assert target blob/digest equality before returning.

```ts
interface ExtractionReport {
  readonly schemaVersion: 1;
  readonly sourceRepository: "kpkhxlgy0/unity-debugger-vscode";
  readonly sourceBranch: "feature/unity-debugger-pure-mcp";
  readonly sourceCommit: string;
  readonly retainedCommits: readonly {
    readonly source: string;
    readonly target: string;
    readonly subject: string;
    readonly author: string;
    readonly authorDate: string;
    readonly committer: string;
    readonly committerDate: string;
  }[];
  readonly content: Readonly<Record<string, {
    readonly gitBlob: string;
    readonly sha256: string;
  }>>;
}
```

The CLI accepts exactly:

```powershell
node scripts/extract-mcp-history.mjs --source <absolute-source> --source-ref <40-hex-commit> --target <absolute-target>
```

Reject missing, duplicate, unknown, relative, or malformed arguments. Never accept force/overwrite.

- [ ] **Step 7: Run tests**

```powershell
node --test tests/build/extract-mcp-history.test.mjs
npm run test:build
git diff --check
```

Expected: PASS; fixture sources are unchanged and targets have no remote.

- [ ] **Step 8: Commit**

```powershell
git add scripts/extract-mcp-history.mjs tests/build/extract-mcp-history.test.mjs
git commit -m "build: add audited MCP history extractor"
```

### Task 2: Create the filtered repository and record provenance

**Repositories:** Both agreed local paths

**Files:**
- Generate in target: `docs/repository-split-provenance.json`
- Existing in target: allowlisted final-tree content

**Interfaces:**
- Consumes: Task 1 extractor and clean source HEAD.
- Produces: filtered target `master`, `codex/standalone-repository`, and provenance.

- [ ] **Step 1: Validate exact source state**

```powershell
$splitSourceCommit = git rev-parse HEAD
git status --short --branch
git branch --show-current
Test-Path -LiteralPath 'D:/Unity/unity-debugger-pure-mcp'
```

Expected: source branch is correct, tracked state clean, target `False`.

- [ ] **Step 2: Extract once**

```powershell
node scripts/extract-mcp-history.mjs --source 'D:/Unity/unity-debugger-vscode' --source-ref $splitSourceCommit --target 'D:/Unity/unity-debugger-pure-mcp' | Set-Content -LiteralPath 'D:/Unity/unity-debugger-pure-mcp/docs/repository-split-provenance.json' -Encoding utf8
```

`Set-Content` is allowed only for this generated report. Source/config edits use `apply_patch`.

- [ ] **Step 3: Verify history and exclusions**

Run target `git log --reverse`, `git remote -v`, and `git ls-tree -r --name-only HEAD`. Require companion design/scaffold/bridge/tools/server/provider/package/hardening/split/extractor commits, no debugger-only API implementation commit, only allowlisted paths, valid commit/hash fields, and no remote.

- [ ] **Step 4: Create the implementation branch and stage provenance**

```powershell
git -C 'D:/Unity/unity-debugger-pure-mcp' switch -c codex/standalone-repository
git -C 'D:/Unity/unity-debugger-pure-mcp' add docs/repository-split-provenance.json
```

Do not commit yet. The approved design requires one normalization commit after the filtered history; Task 5 commits provenance together with the final standalone layout.

- [ ] **Step 5: Recheck source immutability**

Require source `HEAD` equals `$splitSourceCommit` and status remains clean.

### Task 3: Normalize standalone source, tests, and npm workspace

**Repository:** `D:/Unity/unity-debugger-pure-mcp`

**Files:**
- Move: `mcp-extension/src/` to `src/`
- Move: `mcp-extension` package/config/docs/notices/inventory files to root
- Move: `mcp-server/` to `server/`
- Move: `tests/mcp-extension/` to `tests/extension/`
- Move: `tests/mcp-server/` to `tests/server/`
- Modify: `package.json`, `tsconfig.json`, `server/tsconfig.json`, `server/sea-config.json`
- Modify: `server/src/bridgeClient.ts`, `server/src/toolCatalog.ts`
- Modify: path-dependent imports under `tests/extension/`, `tests/server/`, `tests/integration/`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`
- Generate: `package-lock.json`
- Create: `vitest.config.ts`, `.gitignore`

**Interfaces:**
- Consumes: filtered tree and provenance.
- Produces: root extension package and private server workspace without old paths.

- [ ] **Step 1: Rewrite scaffold test for final layout**

```js
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.equal(manifest.name, "unity-debugger-pure-mcp");
assert.deepEqual(manifest.workspaces, ["server"]);
assert.deepEqual(manifest.extensionDependencies, ["kpk.unity-debugger-pure"]);
assert.equal(manifest.engines.vscode, "^1.101.0");
assert.equal(manifest.devDependencies["@types/vscode"], "1.101.0");
assert.equal(fs.existsSync("src/extension.ts"), true);
assert.equal(fs.existsSync("server/src/server.ts"), true);
assert.equal(fs.existsSync("mcp-extension"), false);
assert.equal(fs.existsSync("mcp-server"), false);
```

Also assert only `server/package.json` declares MCP SDK and Zod.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/build/mcp-companion-scaffold.test.mjs`

Expected: FAIL because normalized root paths do not exist.

- [ ] **Step 3: Perform mechanical Git moves**

Use `git mv`; verify old directories are empty before removing them; never copy and retain duplicates.

Create `.gitignore` with:

```text
node_modules/
dist/
coverage/
*.tsbuildinfo
```

Extend the scaffold test to assert these generated/build paths are ignored and that source, tests, scripts, documentation, inventory, and workflows remain tracked.

- [ ] **Step 4: Define root manifest**

Keep extension contributions. Set `workspaces: ["server"]`, new repository links, and:

```json
{
  "scripts": {
    "build:extension": "node esbuild.mjs",
    "build:server": "npm run build -w unity-debugger-pure-mcp-server",
    "typecheck:extension": "tsc -p tsconfig.json",
    "typecheck:server": "tsc -p server/tsconfig.json",
    "typecheck": "npm run typecheck:extension && npm run typecheck:server",
    "test:build": "node --test tests/build/*.test.mjs",
    "test:extension": "vitest run tests/extension",
    "test:server": "vitest run tests/server",
    "test:integration": "vitest run tests/integration",
    "test": "npm run test:build && npm run test:extension && npm run test:server && npm run test:integration"
  }
}
```

Exact devDependencies: `@types/node 26.1.1`, `@types/vscode 1.101.0`, `@vscode/vsce 3.9.2`, `adm-zip 0.6.0`, `esbuild 0.28.1`, `typescript 7.0.2`, `vitest 4.1.10`.

- [ ] **Step 5: Define TypeScript and Vitest boundaries**

Root TypeScript includes `src`, extension tests, integration tests, Vitest config, and esbuild with ES2022/Bundler/strict/noEmit/verbatimModuleSyntax and Node/VS Code/Vitest globals. Server extends root, uses only Node types, and includes `../tests/server`. Vitest includes extension, server, and integration tests with existing timeouts.

- [ ] **Step 6: Rewrite only path-dependent references**

Map `../../mcp-extension/src/` to `../../src/`, `../../mcp-server/src/` to `../../server/src/`, `mcp-server/dist` to `server/dist`, `mcp-extension/dist` to `dist`, and both old test directory names to the new names.

Do not change tool names, provider IDs, pipe prefixes, errors, schemas, annotations, cancellation, budgets, or opaque references.

- [ ] **Step 7: Generate lockfile and run checks**

```powershell
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
node --test tests/build/mcp-companion-scaffold.test.mjs
npm run typecheck
npm run test:extension
npm run test:server
npm run build:server
npm run test:integration
rg -n "mcp-extension|mcp-server|unity-debugger-vscode|extension/src/publicApi" src server tests scripts package.json tsconfig.json vitest.config.ts
git diff --check
```

Expected: tests PASS; no old path import, old repository URL, or debugger-internal import.

- [ ] **Step 8: Review the source-workspace checkpoint**

```powershell
git status --short
git diff --check
```

Expected: only intended standalone normalization paths are changed. Do not commit until packaging, documentation, and workflow normalization also pass.

### Task 4: Adapt SEA build, VSIX packaging, and runtime inventory

**Repository:** `D:/Unity/unity-debugger-pure-mcp`

**Files:**
- Modify: `scripts/build-mcp-bridge.mjs`
- Modify: `scripts/verify-mcp-vsix.mjs`
- Modify: `server/sea-config.json`
- Modify: `package.json`, `.vscodeignore`, `runtime-inventory.json`
- Modify: `tests/package/mcp-vsix.test.mjs`
- Modify: `tests/integration/mcpCompanion.integration.test.ts`

**Interfaces:**
- Consumes: normalized extension/server from Task 3.
- Produces: `dist/extension.cjs`, `dist/mcp-bridge.exe`, and the audited `dist/unity-debugger-pure-mcp-0.1.0.vsix`.

- [ ] **Step 1: Change package tests to standalone paths**

Require:

```js
const artifactPath = path.join(
  repositoryRoot,
  "dist",
  "unity-debugger-pure-mcp-0.1.0.vsix",
);
const inventoryPath = path.join(repositoryRoot, "runtime-inventory.json");
const executablePath = path.join(repositoryRoot, "dist", "mcp-bridge.exe");
```

The package test invokes `npm run package`, proves packaging does not rewrite inventory content or mtime, and retains unsafe ZIP, duplicate path, Adapter/Mono, AMD64, extension dependency, and standalone-executable cases.

- [ ] **Step 2: Run package tests and verify failure**

Run:

```powershell
node --test tests/package/mcp-smoke-stdout.test.mjs tests/package/mcp-vsix.test.mjs
```

Expected: FAIL because standalone build/package paths are not complete.

- [ ] **Step 3: Rewrite SEA and verifier paths**

`server/sea-config.json`:

```json
{
  "main": "server/dist/server.cjs",
  "mainFormat": "commonjs",
  "output": "dist/mcp-bridge.exe",
  "useSnapshot": false,
  "useCodeCache": false
}
```

`scripts/build-mcp-bridge.mjs` must output to root `dist`, run `server/esbuild.mjs`, invoke `process.execPath --build-sea server/sea-config.json`, verify AMD64, smoke-test before inventory comparison, print the candidate SHA-256 on mismatch, and preserve all bounded process/socket cleanup.

`scripts/verify-mcp-vsix.mjs` reads root `runtime-inventory.json`. Do not loosen the 11-file allowlist or forbidden-path checks.

Replace `.vscodeignore` with these production exclusions:

```text
.git/**
.github/**
.vscode/**
docs/**
scripts/**
server/**
src/**
tests/**
node_modules/**
dist/*.map
```

- [ ] **Step 4: Add standalone package commands**

```json
{
  "build:bridge": "node scripts/build-mcp-bridge.mjs",
  "build": "npm run build:extension && npm run build:bridge",
  "verify:vsix": "node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix",
  "package:vsix": "vsce package --no-dependencies --out dist/unity-debugger-pure-mcp-0.1.0.vsix",
  "package": "npm run build && npm run package:vsix && npm run verify:vsix",
  "test:package": "node --test tests/package/*.test.mjs"
}
```

Do not invoke `test:package` from `npm test`, because the package test invokes `npm run package`.

- [ ] **Step 5: Require the old inventory to reject the candidate**

```powershell
node --version
npm run build
```

Expected: Node is `v26.5.0`; candidate passes AMD64/smoke, then fails against the old inventory and prints one 64-hex digest.

- [ ] **Step 6: Review and update inventory**

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath 'dist/mcp-bridge.exe').Hash.ToLowerInvariant()
```

Require equality with the build-reported digest. Use `apply_patch` to change only `runtime-inventory.json` SHA-256; retain `nodeVersion: v26.5.0`.

- [ ] **Step 7: Run package/process verification**

```powershell
npm run build
npm run test:integration
npm run package
node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix
node --test tests/package/mcp-smoke-stdout.test.mjs tests/package/mcp-vsix.test.mjs
```

Expected: PASS; inventory does not change during packaging; VSIX contains exactly allowlisted production files and no Adapter/Mono.

- [ ] **Step 8: Review the artifact-production checkpoint**

```powershell
git status --short
git diff --check
```

Expected: package, SEA, verifier, inventory, and path changes are present and verified. Do not commit until Task 5 completes the one approved normalization commit.

### Task 5: Add repository documentation, workflows, and boundary audits

**Repository:** `D:/Unity/unity-debugger-pure-mcp`

**Files:**
- Modify: `package.json`, `README.md`, `SECURITY.md`, `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `tests/build/repository-boundary.test.mjs`
- Create: `tests/build/workflows.test.mjs`

**Interfaces:**
- Consumes: standalone package and verifier.
- Produces: remote-ready metadata and regression tests forbidding renewed source coupling.

- [ ] **Step 1: Write failing boundary tests**

```js
test("standalone repository has only the public debugger dependency", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(
    manifest.repository.url,
    "https://github.com/kpkhxlgy0/unity-debugger-pure-mcp.git",
  );
  assert.deepEqual(manifest.extensionDependencies, ["kpk.unity-debugger-pure"]);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.workspaces, ["server"]);
});

test("source imports never cross into the debugger repository", () => {
  const imported = collectRelativeImports(["src", "server", "tests"]);
  assert.equal(
    imported.some((value) =>
      value.includes("unity-debugger-vscode") ||
      value.includes("extension/src/publicApi") ||
      value.includes("adapter/"),
    ),
    false,
  );
});

function collectRelativeImports(roots) {
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
```

Also assert no old workspace directory exists and no tracked file names the old GitHub URL.

- [ ] **Step 2: Write failing workflow tests**

Parse YAML with `js-yaml 4.3.0`. Assert CI runs on pull requests/pushes with Windows, Node 26.5.0, `npm ci`, typecheck, tests, and package. Assert release runs only on `v*` tags, verifies tag/manifest equality, repeats tests/package/direct verifier, writes a SHA-256 sidecar, and creates a GitHub release with only VSIX/sidecar. Reject registry publication and remote configuration.

- [ ] **Step 3: Run and verify failure**

Run:

```powershell
node --test tests/build/repository-boundary.test.mjs tests/build/workflows.test.mjs
```

Expected: FAIL because workflows and final metadata/docs are absent.

- [ ] **Step 4: Update documentation and links**

Use:

- repository: `https://github.com/kpkhxlgy0/unity-debugger-pure-mcp.git`
- bugs: `https://github.com/kpkhxlgy0/unity-debugger-pure-mcp/issues`
- homepage: `https://github.com/kpkhxlgy0/unity-debugger-pure-mcp#readme`
- new repository Security Advisories page in `SECURITY.md`

README covers both-extension installation, API v1, 19 tool groups, safe versus explicit evaluation, VS Code lifetime, current-user pipe, no TCP/telemetry, and no Adapter/Mono. Remove monorepo wording.

- [ ] **Step 5: Add CI and future release workflows**

CI core:

```yaml
jobs:
  validate:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26.5.0
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run package
```

Release repeats validation from a tag, derives expected tag from `package.json` rather than hard-coding a future version, creates the sidecar with `Get-FileHash`, and passes only those two assets to `gh release create`. Do not add registry publishing or credentials.

- [ ] **Step 6: Run checks**

```powershell
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
node --test tests/build/repository-boundary.test.mjs tests/build/workflows.test.mjs
npm run test:build
npm run typecheck
npm test
git diff --check
```

Expected: PASS; no old repository URL or internal debugger import.

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "build: normalize standalone MCP repository"
```

This is the single post-filter normalization commit required by the approved design. It includes the provenance report plus Tasks 3–5 source, package, documentation, and workflow changes.

### Task 6: Complete the independent-repository release gate

**Repository:** `D:/Unity/unity-debugger-pure-mcp`

**Files:** Verify only.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: proof authorizing source cleanup.

- [ ] **Step 1: Require branch, no remote, and clean state**

Run `git branch --show-current`, `git remote -v`, and `git status --short --branch`.

Expected: `codex/standalone-repository`, no remote, no tracked/untracked change except ignored `dist`.

- [ ] **Step 2: Run fresh dependency/type gate**

```powershell
node --version
npm ci
npm run typecheck
```

Expected: Node `v26.5.0`, PASS.

- [ ] **Step 3: Run every suite**

```powershell
npm run test:build
npm run test:extension
npm run test:server
npm run build:server
npm run test:integration
node --test tests/package/mcp-smoke-stdout.test.mjs
```

Expected: PASS, including cancellation, response budget, socket preservation, opaque generations, lifecycle cleanup, and real named-pipe child process.

- [ ] **Step 4: Build and audit twice**

Record inventory content/mtime, then:

```powershell
npm run package
node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix
node --test tests/package/mcp-vsix.test.mjs
```

Expected: PASS; inventory unchanged; both audits report the same SEA digest.

- [ ] **Step 5: Record artifact/history evidence**

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'dist/unity-debugger-pure-mcp-0.1.0.vsix'
Get-FileHash -Algorithm SHA256 -LiteralPath 'dist/mcp-bridge.exe'
git log --reverse --format='%H%x09%an%x09%ae%x09%aI%x09%s'
git status --short --branch
```

Compare SEA hash with inventory and retained metadata with provenance.

- [ ] **Step 6: Enforce cleanup gate**

Proceed only if every command passes. Otherwise stop with target path/failing command and do not alter companion files in the debugger repository.

### Task 7: Remove companion ownership from the debugger repository

**Repository:** `D:/Unity/unity-debugger-vscode`

**Files:**
- Create: `tests/build/repository-boundary.test.mjs`
- Modify: `package.json`, `package-lock.json`, `vitest.config.ts`, `README.md`
- Remove: `mcp-extension/`, `mcp-server/`
- Remove: `scripts/build-mcp-bridge.mjs`, `scripts/mcp-smoke-stdout.mjs`, `scripts/verify-mcp-vsix.mjs`, `scripts/extract-mcp-history.mjs`
- Remove: `tests/build/mcp-companion-scaffold.test.mjs`, `tests/build/extract-mcp-history.test.mjs`
- Remove: `tests/integration/mcpCompanion.integration.test.ts`
- Remove: `tests/mcp-extension/`, `tests/mcp-server/`
- Remove: `tests/package/mcp-smoke-stdout.test.mjs`, `tests/package/mcp-vsix.test.mjs`
- Remove companion design/plan files named in `COMPANION_PATHS`
- Keep: `docs/superpowers/plans/2026-07-30-mcp-debugger-public-api.md`
- Keep: `extension/src/publicApi.ts`, `publicApiTypes.ts`, `attachRequestRegistry.ts`, and their tests

**Interfaces:**
- Consumes: Task 6 success.
- Produces: debugger-only version `0.2.0` exporting API v1.

- [ ] **Step 1: Write failing boundary test**

```js
test("debugger exports API v1 without owning MCP", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(manifest.name, "unity-debugger-pure");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.workspaces, undefined);
  assert.equal(manifest.scripts["build:mcp-extension"], undefined);
  assert.equal(manifest.scripts["build:mcp-server"], undefined);
  assert.equal(manifest.scripts["build:mcp-bridge"], undefined);
  assert.equal(manifest.scripts["test:mcp"], undefined);
  assert.equal(manifest.scripts["package:mcp"], undefined);
  assert.equal(fs.existsSync("extension/src/publicApi.ts"), true);
  assert.equal(fs.existsSync("mcp-extension"), false);
  assert.equal(fs.existsSync("mcp-server"), false);
});
```

Also assert `scripts/verify-vsix.mjs` still rejects `mcp-bridge.exe`, and the root manifest has no MCP SDK or provider contribution.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/build/repository-boundary.test.mjs`

Expected: FAIL because companion workspaces remain.

- [ ] **Step 3: Remove only listed companion paths**

Before recursive removal, resolve every absolute target and assert it begins with `D:/Unity/unity-debugger-vscode/` and is not the repository root. Never remove public API files or base tests.

- [ ] **Step 4: Simplify npm/test boundaries**

Remove workspaces and MCP build/typecheck/test/package scripts. Set `typecheck` to `tsc -p tsconfig.json`. Retain all base version 0.2.0 build, Adapter, extension, integration, package, third-party, VSIX, and release commands. Remove companion Vitest roots.

```powershell
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

Expected: lockfile has no companion workspace, MCP SDK, or Zod.

- [ ] **Step 5: Update debugger documentation**

Keep the API v1/separately installed companion statement and link it to `https://github.com/kpkhxlgy0/unity-debugger-pure-mcp`. Do not imply bundling, ordinary-debugger dependency, or publication.

- [ ] **Step 6: Run focused checks**

```powershell
node --test tests/build/repository-boundary.test.mjs
npx vitest run tests/extension/publicApi.test.ts tests/extension/attachRequestRegistry.test.ts tests/extension/debugConfigurationProvider.test.ts
npm run typecheck
npm run test:build
rg -n "mcp-extension|mcp-server|build:mcp|test:mcp|package:mcp" package.json package-lock.json vitest.config.ts scripts tests docs README.md
```

Expected: PASS. Remaining matches are limited to base package rejection/release checklist defenses or the external product link.

- [ ] **Step 7: Run complete debugger verification**

```powershell
npm test
npm run package
node scripts/verify-vsix.mjs dist/unity-debugger-pure-0.2.0.vsix
git diff --check
```

Expected: PASS; debugger VSIX contains Adapter and no MCP bridge.

- [ ] **Step 8: Commit**

Review `git diff --name-status` against the exact list, then:

```powershell
git add -A
git commit -m "build: extract MCP companion repository"
```

### Task 8: Run the final dual-repository gate

**Repositories:** Both agreed local paths

**Files:** Verify only.

**Interfaces:**
- Consumes: standalone repository and debugger cleanup.
- Produces: final branch, commit, artifact, history, and clean-state evidence.

- [ ] **Step 1: Verify identities and branches**

Target must resolve to `D:/Unity/unity-debugger-pure-mcp`, use `codex/standalone-repository`, and have no remote. Source must resolve to `D:/Unity/unity-debugger-vscode`, remain on `feature/unity-debugger-pure-mcp`, and retain its original `origin`.

- [ ] **Step 2: Re-run standalone proof**

```powershell
npm ci
npm run typecheck
npm test
npm run package
node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix
```

Expected: PASS.

- [ ] **Step 3: Re-run debugger proof**

```powershell
npm ci
npm run typecheck
npm test
npm run package
node scripts/verify-vsix.mjs dist/unity-debugger-pure-0.2.0.vsix
```

Expected: PASS.

- [ ] **Step 4: Confirm package separation**

Inspect both manifests and archives: companion depends exactly on debugger and contains MCP bridge/no Adapter; debugger has no companion dependency and contains Adapter/no MCP bridge; neither source tree imports the other local repository.

- [ ] **Step 5: Confirm history and clean states**

```powershell
git -C 'D:/Unity/unity-debugger-pure-mcp' status --short --branch
git -C 'D:/Unity/unity-debugger-vscode' status --short --branch
git -C 'D:/Unity/unity-debugger-pure-mcp' log -5 --oneline
git -C 'D:/Unity/unity-debugger-vscode' log -5 --oneline
```

Expected: clean; target ends in standalone commits on filtered history; source ends in one cleanup commit while retaining API v1 history.

- [ ] **Step 6: Report final evidence**

Report both paths, branches, HEADs, provenance source commit, retained commit count, companion VSIX/SEA SHA-256, debugger VSIX SHA-256, all verification results, no target remote, unchanged source origin, and no GitHub/registry/Editor/Computer Use action.

Do not merge, push, create a pull request, configure a remote, or delete either branch without a new explicit request.
