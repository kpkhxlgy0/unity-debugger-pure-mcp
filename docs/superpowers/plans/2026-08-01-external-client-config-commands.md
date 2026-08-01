# External Client Configuration Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two opt-in VS Code commands that safely configure the selected project for external Codex or Claude Code access to Unity Debugger Pure MCP.

**Architecture:** Keep client configuration separate from debugger/MCP runtime state. A shared versioned launcher descriptor and atomic workspace-file boundary feed format-specific Codex TOML and Claude JSON editors; a command controller maps their classified states to explicit user actions. Codex ownership is stored in a marker-delimited block, while Claude ownership uses a content fingerprint in VS Code `workspaceState` because strict `.mcp.json` cannot carry private metadata.

**Tech Stack:** TypeScript 7, VS Code extension API 1.101+, Node.js 26.5.0, Vitest 4, `smol-toml` 1.7.1, `jsonc-parser` 3.3.1, VSCE 3.9.2, Windows x64.

## Global Constraints

- Ship this feature in companion 0.1.1; do not bump the private server or public launcher from 0.1.0.
- Register exactly `unityDebuggerPureMcp.configureCodex` and `unityDebuggerPureMcp.configureClaudeCode`.
- Do not configure either client during activation and do not add a setting, checkbox, status-bar item, or activation notification.
- Write only `.codex/config.toml` or `.mcp.json` beneath an explicitly selected trusted local workspace root.
- Use server name `unity_debugger_pure` and launcher invocation `uvx --from unity-debugger-pure-mcp==0.1.0 unity-debugger-pure-mcp`.
- Do not spawn Codex, Claude, a shell, or user-supplied commands.
- Never write bridge pipe names, capability tokens, user names, or absolute launcher paths.
- Never overwrite a same-name configuration that is not canonical and explicitly managed.
- Preserve unrelated configuration and refuse files larger than 256 KiB UTF-8.
- Keep the companion VSIX at exactly 12 allowlisted files; bundle parser libraries into `dist/extension.cjs` and do not package `node_modules`.
- Use exact dependency versions and update lockfile and `THIRD_PARTY_NOTICES.md`.
- Do not commit implementation changes, push, tag, publish, or change the final MyGame configuration state without explicit authorization.

---

## File Map

### New production files

- `src/external/config/externalLauncherDescriptor.ts` — one canonical server name, launcher pin, arguments, state/action types, and editor interface.
- `src/external/config/atomicWorkspaceFile.ts` — canonical-root enforcement, bounded snapshot reads, revision checks, same-directory temporary writes, and atomic replacement.
- `src/external/config/codexProjectConfigEditor.ts` — TOML classification and marker-owned byte edits.
- `src/external/config/claudeProjectConfigEditor.ts` — minimal `.mcp.json` property edits and fingerprint-backed ownership.
- `src/external/config/externalClientCommands.ts` — workspace selection and user-action controller with a production VS Code adapter.

### New test files

- `tests/extension/atomicWorkspaceFile.test.ts`
- `tests/extension/codexProjectConfigEditor.test.ts`
- `tests/extension/claudeProjectConfigEditor.test.ts`
- `tests/extension/externalClientCommands.test.ts`

### Modified files

- `src/extension.ts` — register the command controller in the existing reverse-cleanup lifecycle.
- `tests/extension/extension.test.ts` — prove registration and cleanup composition.
- `package.json` and `package-lock.json` — command contributions and exact bundled parser dependencies.
- `tests/build/mcp-companion-scaffold.test.mjs` — manifest/dependency/version boundary.
- `README.md`, `CHANGELOG.md`, and `THIRD_PARTY_NOTICES.md` — command usage, 0.1.1 notes, and licenses.
- `tests/package/mcp-vsix.test.mjs` and `scripts/verify-mcp-vsix.mjs` — retain the existing exact archive boundary; only assertions needed to prove no unpacked parser dependencies may change.

---

### Task 1: Shared launcher contract and atomic workspace file

**Files:**
- Create: `src/external/config/externalLauncherDescriptor.ts`
- Create: `src/external/config/atomicWorkspaceFile.ts`
- Create: `tests/extension/atomicWorkspaceFile.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`

**Interfaces:**
- Produces: `EXTERNAL_MCP_SERVER_NAME`, `EXTERNAL_LAUNCHER_VERSION`, `EXTERNAL_LAUNCHER_ARGS`, `ExternalClientKind`, `ExternalConfigState`, `ExternalConfigAction`, `ExternalConfigInspection`, `ProjectConfigEditor`, `WorkspaceFileSnapshot`, and `AtomicWorkspaceFile`.
- Consumes: Node `fs/promises`, `path`, and `crypto`; no VS Code API.

- [ ] **Step 1: Add RED tests for the descriptor and exact dependencies**

Update `tests/build/mcp-companion-scaffold.test.mjs` to require root development dependencies and command-independent version separation:

```js
assert.equal(manifest.devDependencies["smol-toml"], "1.7.1");
assert.equal(manifest.devDependencies["jsonc-parser"], "3.3.1");
assert.equal(lock.packages["node_modules/smol-toml"].version, "1.7.1");
assert.equal(lock.packages["node_modules/jsonc-parser"].version, "3.3.1");
assert.equal(lock.packages.server.version, "0.1.0");
assert.match(launcher, /^version = "0\.1\.0"$/m);
```

Create a descriptor test in `tests/extension/atomicWorkspaceFile.test.ts` with literal expectations:

```ts
expect(EXTERNAL_MCP_SERVER_NAME).toBe("unity_debugger_pure");
expect(EXTERNAL_LAUNCHER_VERSION).toBe("0.1.0");
expect(EXTERNAL_LAUNCHER_ARGS).toEqual([
  "--from",
  "unity-debugger-pure-mcp==0.1.0",
  "unity-debugger-pure-mcp",
]);
expect(JSON.stringify(EXTERNAL_LAUNCHER_ARGS)).not.toMatch(
  /Admin|Users|pipe|token|AppData/i,
);
```

- [ ] **Step 2: Run the descriptor/dependency tests and verify RED**

Run:

```powershell
node --test tests/build/mcp-companion-scaffold.test.mjs
npx vitest run tests/extension/atomicWorkspaceFile.test.ts
```

Expected: FAIL because the dependencies, descriptor module, and file boundary do not exist.

- [ ] **Step 3: Add exact bundled parser dependencies and the shared types**

Add exact root `devDependencies`:

```json
"jsonc-parser": "3.3.1",
"smol-toml": "1.7.1"
```

Regenerate only the lockfile identity with Node 26.5.0 first on `PATH`:

```powershell
npm install --package-lock-only --ignore-scripts
```

Create `externalLauncherDescriptor.ts` with these public contracts:

```ts
export const EXTERNAL_MCP_SERVER_NAME = "unity_debugger_pure";
export const EXTERNAL_LAUNCHER_VERSION = "0.1.0";
export const EXTERNAL_LAUNCHER_ARGS = Object.freeze([
  "--from",
  `unity-debugger-pure-mcp==${EXTERNAL_LAUNCHER_VERSION}`,
  "unity-debugger-pure-mcp",
]);

export const RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS = Object.freeze([
  EXTERNAL_LAUNCHER_VERSION,
]);

export type ExternalClientKind = "codex" | "claude";
export type ExternalConfigRelativePath =
  | ".codex/config.toml"
  | ".mcp.json";
export type ExternalConfigState =
  | "absent"
  | "managed-current"
  | "managed-outdated"
  | "compatible-unmanaged"
  | "conflict";
export type ExternalConfigAction = "configure" | "adopt" | "update" | "remove";

export interface ExternalConfigInspection {
  readonly client: ExternalClientKind;
  readonly state: ExternalConfigState;
  readonly filePath: string;
  readonly revision: string | null;
  readonly detectedLauncherVersion?: string;
}

export interface ProjectConfigEditor {
  inspect(): Promise<ExternalConfigInspection>;
  apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection>;
}
```

Update `THIRD_PARTY_NOTICES.md` to name `smol-toml 1.7.1` (BSD-3-Clause)
and `jsonc-parser 3.3.1` (MIT) as code bundled into the VS Code extension.

- [ ] **Step 4: Add RED real-filesystem tests for the atomic boundary**

Use a new temporary directory for each test. Cover literal behaviors:

```ts
const file = await AtomicWorkspaceFile.create({
  workspaceRoot: root,
  relativePath: ".codex/config.toml",
});
const absent = await file.read();
expect(absent).toMatchObject({ exists: false, revision: null });
await file.replace(absent, Buffer.from("first\r\n", "utf8"));
const first = await file.read();
expect(first.bytes.toString("utf8")).toBe("first\r\n");
expect(first.newline).toBe("\r\n");
await fs.writeFile(path.join(root, ".codex", "config.toml"), "other\n");
await expect(file.replace(first, Buffer.from("stale\n")))
  .rejects.toMatchObject({ code: "CONFIG_CHANGED" });
```

Add separate tests for:

- 256 KiB accepted and 256 KiB + 1 byte rejected;
- UTF-8 BOM and newline detection;
- traversal relative paths rejected at construction;
- a file symlink and parent junction escaping the root rejected;
- same-directory temporary name creation and cleanup after write/rename failure;
- a stale absent snapshot rejected if another process creates the file;
- public error text containing none of the file bytes or target path.

- [ ] **Step 5: Run the atomic boundary tests and verify RED**

Run:

```powershell
npx vitest run tests/extension/atomicWorkspaceFile.test.ts
```

Expected: descriptor assertions pass; filesystem tests fail because
`AtomicWorkspaceFile` is missing.

- [ ] **Step 6: Implement the minimum atomic boundary**

Create these exact exports:

```ts
export const MAX_EXTERNAL_CONFIG_BYTES = 256 * 1024;

export interface WorkspaceFileSnapshot {
  readonly exists: boolean;
  readonly bytes: Buffer;
  readonly revision: string | null;
  readonly bom: boolean;
  readonly newline: "\n" | "\r\n";
}

export class ExternalConfigFileError extends Error {
  public constructor(
    public readonly code:
      | "CONFIG_NOT_ALLOWED"
      | "CONFIG_TOO_LARGE"
      | "CONFIG_CHANGED"
      | "CONFIG_WRITE_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export class AtomicWorkspaceFile {
  public static async create(options: {
    readonly workspaceRoot: string;
    readonly relativePath: ExternalConfigRelativePath;
  }): Promise<AtomicWorkspaceFile>;

  public get filePath(): string;
  public get workspaceIdentity(): string;
  public read(): Promise<WorkspaceFileSnapshot>;
  public replace(
    expected: WorkspaceFileSnapshot,
    nextBytes: Buffer,
  ): Promise<void>;
}
```

Implementation requirements:

- canonicalize the workspace root once and expose only its SHA-256-based,
  lower-case `workspaceIdentity`, never the raw root;
- accept only the `ExternalConfigRelativePath` union at the type boundary and
  still reject absolute or traversal input at runtime;
- inspect every existing path component with `lstat` and `realpath` before
  read and again immediately before replace;
- compute revisions with SHA-256 over exact bytes;
- create missing parents only after containment checks;
- use a randomized hidden temporary file in the target directory with `wx`;
- flush, close, rename with replacement semantics, and clean up in `finally`;
- return fixed public messages with no path or content.

- [ ] **Step 7: Verify GREEN for Task 1**

Run:

```powershell
npx vitest run tests/extension/atomicWorkspaceFile.test.ts
node --test tests/build/mcp-companion-scaffold.test.mjs
npm run typecheck
git diff --check
```

Expected: all pass; launcher/server versions remain 0.1.0.

- [ ] **Step 8: Commit after explicit authorization**

```powershell
git add package.json package-lock.json THIRD_PARTY_NOTICES.md `
  src/external/config/externalLauncherDescriptor.ts `
  src/external/config/atomicWorkspaceFile.ts `
  tests/extension/atomicWorkspaceFile.test.ts `
  tests/build/mcp-companion-scaffold.test.mjs
git commit -m "feat: add external config file boundary"
```

---

### Task 2: Codex project TOML editor

**Files:**
- Create: `src/external/config/codexProjectConfigEditor.ts`
- Create: `tests/extension/codexProjectConfigEditor.test.ts`

**Interfaces:**
- Consumes: `AtomicWorkspaceFile`, `WorkspaceFileSnapshot`, shared descriptor constants and editor/state/action types from Task 1, and `parse` from `smol-toml`.
- Produces: `CODEX_CONFIG_RELATIVE_PATH`, `CodexProjectConfigEditor`, canonical BEGIN/END markers, and byte-preserving TOML actions.

- [ ] **Step 1: Write RED classification tests with hand-authored TOML fixtures**

Create real temporary projects and assert:

```ts
const editor = await CodexProjectConfigEditor.create(root);
await expect(editor.inspect()).resolves.toMatchObject({
  client: "codex",
  state: "absent",
  filePath: path.join(root, ".codex", "config.toml"),
});
```

Use literal files for these states:

- a manual canonical table without markers -> `compatible-unmanaged`;
- the exact marker block -> `managed-current`;
- the exact recognized launcher-version set contains only public `0.1.0` in
  this release, so a marker block pinned to any other version -> `conflict`;
- `command = "other"`, extra environment, incomplete markers, duplicate target,
  or malformed TOML -> `conflict`;
- marker-looking lines inside TOML multiline strings do not establish ownership.

- [ ] **Step 2: Run classification tests and verify RED**

Run:

```powershell
npx vitest run tests/extension/codexProjectConfigEditor.test.ts
```

Expected: FAIL because the editor module is missing.

- [ ] **Step 3: Implement canonical generation and classification**

Create:

```ts
export const CODEX_CONFIG_RELATIVE_PATH = ".codex/config.toml";
export const CODEX_MANAGED_BEGIN = "# BEGIN Unity Debugger Pure MCP";
export const CODEX_MANAGED_END = "# END Unity Debugger Pure MCP";

export class CodexProjectConfigEditor implements ProjectConfigEditor {
  public static async create(workspaceRoot: string): Promise<CodexProjectConfigEditor>;
  public inspect(): Promise<ExternalConfigInspection>;
  public apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection>;
}
```

Parse the full text with `smol-toml` for semantic validation. Use a small
line-state scanner that ignores basic/literal multiline strings when locating
table headers and marker comments. Classify only literal `command`, `args`,
timeouts, `enabled`, and `required` values; reject unknown target-table keys.
Keep the `managed-outdated` branch and guarded `update` implementation for a
future descriptor that explicitly adds an older public launcher version, but
do not treat an unpublished or arbitrary semantic version as recognized.

- [ ] **Step 4: Write RED action tests**

Add tests proving:

```ts
const absent = await editor.inspect();
await editor.apply("configure", absent);
expect(await fs.readFile(configPath, "utf8")).toBe(EXPECTED_MANAGED_TOML);

const manual = await editor.inspect();
await editor.apply("adopt", manual);
expect(await fs.readFile(configPath, "utf8")).toBe(
  `${UNRELATED_PREFIX}\n${EXPECTED_MANAGED_TOML}`,
);

const managed = await editor.inspect();
await editor.apply("remove", managed);
expect(await fs.readFile(configPath, "utf8")).toBe(UNRELATED_PREFIX);
```

Cover CRLF/BOM retention, no-final-newline input, update of only the managed
block, wrong action rejection, stale revision rejection, and an unchanged
unrelated prefix/suffix byte comparison.

- [ ] **Step 5: Run action tests and verify RED**

Run the same focused Vitest command. Expected: classification passes and action
cases fail because `apply` is incomplete.

- [ ] **Step 6: Implement the four guarded actions**

- `configure` is valid only for `absent` and appends exactly one canonical
  block with the source newline convention;
- `adopt` is valid only for `compatible-unmanaged` and replaces only the
  canonical target table bytes with a marker-delimited block;
- `update` is valid only for `managed-outdated` and replaces only owned bytes;
- `remove` is valid only for managed states and removes only owned bytes,
  normalizing at most the adjacent separator newline;
- every action re-inspects and requires the exact expected revision/state
  before calling `AtomicWorkspaceFile.replace`.

- [ ] **Step 7: Verify GREEN for Task 2**

Run:

```powershell
npx vitest run tests/extension/atomicWorkspaceFile.test.ts `
  tests/extension/codexProjectConfigEditor.test.ts
npm run typecheck:extension
git diff --check
```

- [ ] **Step 8: Commit after explicit authorization**

```powershell
git add src/external/config/codexProjectConfigEditor.ts `
  tests/extension/codexProjectConfigEditor.test.ts
git commit -m "feat: edit project Codex MCP configuration"
```

---

### Task 3: Claude Code JSON editor and ownership fingerprint

**Files:**
- Create: `src/external/config/claudeProjectConfigEditor.ts`
- Create: `tests/extension/claudeProjectConfigEditor.test.ts`

**Interfaces:**
- Consumes: Task 1 file/descriptor contracts and `parse`, `modify`, and `applyEdits` from `jsonc-parser`.
- Produces: `CLAUDE_CONFIG_RELATIVE_PATH`, `ClaudeOwnershipStore`, `ClaudeOwnershipRecord`, and `ClaudeProjectConfigEditor`.

- [ ] **Step 1: Write RED classification and ownership tests**

Define a real in-memory ownership store only in the test file and use real
temporary `.mcp.json` files. Require:

- missing file/entry -> `absent`;
- structurally canonical entry with no record -> `compatible-unmanaged`;
- canonical entry with matching record -> `managed-current`;
- any launcher pin outside the explicit recognized set (currently only
  `0.1.0`) -> `conflict`, even when an old ownership record matches;
- changed object or stale fingerprint -> `conflict`;
- wrong command, extra server fields, non-object `mcpServers`, comments,
  trailing commas, duplicate JSON properties, or invalid JSON -> `conflict`.

Use these interfaces in tests:

```ts
export interface ClaudeOwnershipRecord {
  readonly schemaVersion: 1;
  readonly workspaceIdentity: string;
  readonly serverFingerprint: string;
  readonly launcherVersion: string;
}

export interface ClaudeOwnershipStore {
  get(workspaceIdentity: string): Promise<ClaudeOwnershipRecord | undefined>;
  update(
    workspaceIdentity: string,
    value: ClaudeOwnershipRecord | undefined,
  ): Promise<void>;
}
```

- [ ] **Step 2: Run classification tests and verify RED**

Run:

```powershell
npx vitest run tests/extension/claudeProjectConfigEditor.test.ts
```

Expected: FAIL because the editor and ownership interfaces are missing.

- [ ] **Step 3: Implement strict JSON classification and fingerprints**

Create:

```ts
export const CLAUDE_CONFIG_RELATIVE_PATH = ".mcp.json";

export class ClaudeProjectConfigEditor implements ProjectConfigEditor {
  public static async create(options: {
    readonly workspaceRoot: string;
    readonly ownership: ClaudeOwnershipStore;
  }): Promise<ClaudeProjectConfigEditor>;
  public inspect(): Promise<ExternalConfigInspection>;
  public apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection>;
}
```

Parse with comments and trailing commas disallowed. Detect duplicate object keys
from the JSON syntax tree before using semantic values. The canonical server
object contains exactly `command`, `args`, and `env`; fingerprint a stable
key-sorted serialization with SHA-256. Reuse the `workspaceIdentity` exposed by
`AtomicWorkspaceFile`; never put the raw root in workspace state.

- [ ] **Step 4: Write RED minimal-edit action tests**

Require literal output for absent files, but for existing files assert exact
prefix/suffix and unrelated server bytes remain unchanged after `configure`,
`adopt`, `update`, and `remove`. Include:

- two-space and four-space indentation;
- LF/CRLF and final-newline retention;
- root objects with unrelated properties before and after `mcpServers`;
- removal retaining other MCP servers;
- adoption changing no file bytes while creating an ownership record;
- ownership-store failure leaving file and prior record unchanged;
- file-write failure not publishing a new ownership record;
- stale revision/action rejection;
- removal clearing ownership only after the file replacement succeeds.

- [ ] **Step 5: Run action tests and verify RED**

Run the focused Claude editor test. Expected: classification tests pass and
minimal edit/ownership ordering cases fail.

- [ ] **Step 6: Implement property-level edits and ordered ownership changes**

Use `jsonc-parser.modify` and `applyEdits` with formatting options derived from
the snapshot. Do not stringify the full document. Re-inspect immediately before
every action. For `adopt`, re-read and verify the revision/fingerprint before
updating workspace state without changing the file. For other actions, update
workspace ownership only after the file replacement succeeds.

- [ ] **Step 7: Verify GREEN for Task 3**

Run:

```powershell
npx vitest run tests/extension/atomicWorkspaceFile.test.ts `
  tests/extension/codexProjectConfigEditor.test.ts `
  tests/extension/claudeProjectConfigEditor.test.ts
npm run typecheck:extension
git diff --check
```

- [ ] **Step 8: Commit after explicit authorization**

```powershell
git add src/external/config/claudeProjectConfigEditor.ts `
  tests/extension/claudeProjectConfigEditor.test.ts
git commit -m "feat: edit project Claude MCP configuration"
```

---

### Task 4: Command controller and VS Code interaction

**Files:**
- Create: `src/external/config/externalClientCommands.ts`
- Create: `tests/extension/externalClientCommands.test.ts`

**Interfaces:**
- Consumes: both `ProjectConfigEditor` implementations and the Claude ownership store interface.
- Produces: command IDs, `ExternalClientCommandsBoundary`, `registerExternalClientCommands`, and `createVscodeExternalClientCommands`.

- [ ] **Step 1: Write RED command-state tests**

Use a strict fake boundary whose editor returns literal inspections. Define:

```ts
export const CONFIGURE_CODEX_COMMAND = "unityDebuggerPureMcp.configureCodex";
export const CONFIGURE_CLAUDE_COMMAND = "unityDebuggerPureMcp.configureClaudeCode";

export interface ExternalWorkspaceFolder {
  readonly name: string;
  readonly scheme: string;
  readonly fsPath: string;
}

export interface ExternalClientCommandsBoundary {
  isWorkspaceTrusted(): boolean;
  workspaceFolders(): readonly ExternalWorkspaceFolder[];
  pickWorkspace(
    folders: readonly ExternalWorkspaceFolder[],
  ): Promise<ExternalWorkspaceFolder | undefined>;
  createEditor(
    client: ExternalClientKind,
    root: string,
  ): Promise<ProjectConfigEditor>;
  chooseAction(options: {
    readonly client: ExternalClientKind;
    readonly inspection: ExternalConfigInspection;
    readonly actions: readonly (ExternalConfigAction | "open")[];
  }): Promise<ExternalConfigAction | "open" | undefined>;
  showSuccess(client: ExternalClientKind, filePath: string): Promise<void>;
  showError(message: string): Promise<void>;
  openConfiguration(filePath: string): Promise<void>;
  registerCommand(id: string, handler: () => Promise<void>): { dispose(): void };
}
```

Test real controller behavior rather than checking mock existence:

- neither command writes during registration;
- untrusted/no-folder/remote-root states call no editor;
- one root is used directly and multiple roots require the returned selection;
- cancelled selection/action has no side effect;
- each inspection state exposes only the approved actions;
- `apply` receives the exact inspection revision and selected action;
- conflict exposes only `open`;
- sanitized errors never include a fake token, configuration content, or path;
- both command disposables are released exactly once.

- [ ] **Step 2: Run controller tests and verify RED**

Run:

```powershell
npx vitest run tests/extension/externalClientCommands.test.ts
```

Expected: FAIL because the command controller is missing.

- [ ] **Step 3: Implement the client-neutral controller**

Implement:

```ts
export function registerExternalClientCommands(
  boundary: ExternalClientCommandsBoundary,
): { dispose(): void };
```

Map states exactly:

```ts
const actionsByState = {
  absent: ["configure"],
  "managed-current": ["remove", "open"],
  "managed-outdated": ["update", "remove", "open"],
  "compatible-unmanaged": ["adopt", "open"],
  conflict: ["open"],
} as const;
```

Validate trust and workspace selection again immediately before `apply` so a
trust/root change while a prompt is open fails closed.

- [ ] **Step 4: Write RED production-adapter tests**

Add narrow tests for the adapter exposed as:

```ts
export function createVscodeExternalClientCommands(
  context: vscode.ExtensionContext,
): { dispose(): void };
```

With the existing `vscode` module fake, require command registration, local
URI conversion, Quick Pick labels, modal action labels, `workspaceState`
get/update ordering, and `openTextDocument`/`showTextDocument` for the exact
target. Do not mock the editors; use temporary workspace folders for at least
one Codex configure and one Claude configure adapter test.

- [ ] **Step 5: Run adapter tests and verify RED**

Run the focused command test. Expected: controller cases pass; VS Code adapter
cases fail until production wiring exists.

- [ ] **Step 6: Implement the production VS Code adapter**

- Map `vscode.workspace.workspaceFolders` to immutable local candidates.
- Use `vscode.window.showWorkspaceFolderPick` or a Quick Pick with exact folder
  name and path detail for multi-root workspaces.
- Use modal information/warning messages for mutating actions.
- Implement a namespaced `workspaceState` record map under
  `externalClientConfigOwnership.v1`.
- Use fixed, content-free error messages and log no configuration bytes.
- Open the exact selected workspace file only after containment succeeds.

- [ ] **Step 7: Verify GREEN for Task 4**

Run:

```powershell
npx vitest run tests/extension/externalClientCommands.test.ts `
  tests/extension/codexProjectConfigEditor.test.ts `
  tests/extension/claudeProjectConfigEditor.test.ts
npm run typecheck:extension
git diff --check
```

- [ ] **Step 8: Commit after explicit authorization**

```powershell
git add src/external/config/externalClientCommands.ts `
  tests/extension/externalClientCommands.test.ts
git commit -m "feat: add external client configuration commands"
```

---

### Task 5: Extension composition, manifest, documentation, and package boundary

**Files:**
- Modify: `src/extension.ts`
- Modify: `tests/extension/extension.test.ts`
- Modify: `package.json`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify if necessary: `scripts/verify-mcp-vsix.mjs`
- Modify if necessary: `tests/package/mcp-vsix.test.mjs`

**Interfaces:**
- Consumes: `createVscodeExternalClientCommands(context)` from Task 4.
- Produces: two command-palette entries whose registration participates in existing reverse-order activation cleanup.

- [ ] **Step 1: Write RED manifest tests**

Require exact contributions:

```js
assert.deepEqual(manifest.contributes.commands, [
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
]);
assert.deepEqual(manifest.activationEvents, ["onStartupFinished"]);
```

Also assert there is no `contributes.configuration`, status-bar contribution,
or client-config activation event.

- [ ] **Step 2: Write RED composition tests**

Extend `ExtensionCompositionBoundary` with:

```ts
registerExternalClientCommands(): vscode.Disposable;
```

Update the existing lifecycle test's literal log to require command
registration after debugger API activation and before bridge listen. Require
reverse cleanup to dispose commands after bridge/publisher/provider and before
older debug listeners. Add a failure case where command registration throws and
no pipe/provider is created.

- [ ] **Step 3: Run build/composition tests and verify RED**

Run:

```powershell
node --test tests/build/mcp-companion-scaffold.test.mjs
npx vitest run tests/extension/extension.test.ts
```

Expected: manifest and boundary assertions fail because commands are not wired.

- [ ] **Step 4: Wire manifest and activation lifecycle**

Add the two `contributes.commands` records to `package.json`. In
`activateWithDependencies`, register one `onceDisposable` command controller in
`lifecycleDisposables`. In `productionBoundary(context)`, return
`createVscodeExternalClientCommands(context)`.

Do not change bridge start order, MCP provider purity, session state, protocol,
or `activationEvents: ["onStartupFinished"]`.

- [ ] **Step 5: Update README and changelog**

README must:

- put the two commands before the manual snippets;
- state that installation does not write client configuration;
- retain the existing manual Codex snippet and add an exact manual Claude
  `.mcp.json` snippet as fallback;
- retain the launcher pin at exactly 0.1.0;
- explain that Codex/Claude need a new session and Claude retains its trust
  prompt.

Add a 0.1.1 changelog bullet for the two opt-in project commands. Do not add a
launcher 0.1.1 entry.

- [ ] **Step 6: Verify the compiled/package boundary**

Run:

```powershell
npm run typecheck
npm run build:extension
node --test tests/build/*.test.mjs
npx vitest run tests/extension
npm run package:companion
npm run test:package:companion
```

Require:

- exactly 12 VSIX files;
- no `node_modules`, parser source, source map, Python, launcher, Adapter, or
  Mono path;
- manifest version 0.1.1 and the existing icon;
- bundled extension contains the config implementation;
- SEA hash still matches `runtime-inventory.json`.

If the verifier/package test already enforces these behaviors, do not add
source-text assertions or redundant allowlist branches.

- [ ] **Step 7: Verify GREEN for Task 5**

Run:

```powershell
npm test
npm run package
npm run test:package
git diff --check
```

Expected: all build, extension, server, integration, launcher, SEA, VSIX, and
artifact tests pass; only known vendored warnings may remain in the separate
debugger build.

- [ ] **Step 8: Commit after explicit authorization**

```powershell
git add src/extension.ts tests/extension/extension.test.ts package.json `
  tests/build/mcp-companion-scaffold.test.mjs README.md CHANGELOG.md `
  scripts/verify-mcp-vsix.mjs tests/package/mcp-vsix.test.mjs
git commit -m "feat: integrate project MCP configuration commands"
```

Stage only files actually changed by Task 5.

---

### Task 6: MyGame real acceptance and 0.1.1 release gate

**Files:**
- Generated/ignored: `dist/unity-debugger-pure-mcp-0.1.1.vsix`
- Generated/ignored: `D:/Unity/unity-debugger-vscode/dist/unity-debugger-pure-0.2.0.vsix`
- User-approved project config only: `D:/Unity/TuanjieHub/Projects/MyGame/.codex/config.toml`
- User-approved project config only: `D:/Unity/TuanjieHub/Projects/MyGame/.mcp.json`

**Interfaces:**
- Consumes: audited companion 0.1.1, debugger 0.2.0 API v1, public launcher 0.1.0, VS Code command handlers, and the MyGame Unity/Tuanjie instance.
- Produces: final release-readiness evidence; no automatic commit, push, tag, or publication.

- [ ] **Step 1: Run fresh automated gates with exact Node 26.5.0**

From the companion repository:

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

Confirm `runtime-inventory.json` did not change during packaging.

- [ ] **Step 2: Rebuild and audit debugger 0.2.0**

From `D:/Unity/unity-debugger-vscode`:

```powershell
& $node260 $npm260 ci
dotnet restore UnityDebugger.sln --locked-mode
& $node260 $npm260 run typecheck
& $node260 $npm260 test
& $node260 $npm260 run package
& $node260 $npm260 run verify:vsix
```

- [ ] **Step 3: Install exact VSIX files and reload once**

```powershell
code --install-extension D:\Unity\unity-debugger-vscode\dist\unity-debugger-pure-0.2.0.vsix --force
code --install-extension D:\Unity\unity-debugger-pure-mcp\dist\unity-debugger-pure-mcp-0.1.1.vsix --force
```

Ask the user to reload the VS Code window opened from MyGame, unless they
separately authorize Computer Use for that UI operation. Verify a live bridge
registration appears under the current user's local application-data registry
without reading or printing its token.

- [ ] **Step 4: Validate command behavior in MyGame**

Before any Unity operation, call Unity MCP `debug_request_context` and require
the active instance to be `MyGame@c3cd500d` or its newly reported exact MyGame
identity; record the reported port.

Run **Configure Codex**:

- recognize the existing unmarked canonical entry as compatible-unmanaged;
- choose **Adopt Management**;
- verify other TOML tables remain byte-identical;
- start a new Codex session and list exactly 19 `unity_debug_*` tools.

Run **Configure Claude Code**:

- create or adopt `.mcp.json`;
- accept Claude Code's own project trust prompt manually;
- start a new Claude Code session and list the same 19 tools.

Do not use Computer Use unless separately authorized.

- [ ] **Step 5: Validate reversible ownership**

For each command:

1. choose **Remove** only after managed ownership is visible;
2. verify only `unity_debugger_pure` is removed and unrelated content remains;
3. run the command again and restore the user's requested final configuration;
4. verify no temporary config file remains.

Do not commit MyGame configuration without explicit authorization.

- [ ] **Step 6: Exercise one real debugger flow from Codex**

Using the newly discovered tools against the verified MyGame instance:

1. `unity_debug_list_targets`;
2. `unity_debug_attach` using only the returned target reference;
3. `unity_debug_status` and `unity_debug_pause`;
4. `unity_debug_wait_for_event` for `stopped`;
5. `unity_debug_snapshot`, threads, stack trace, scopes, and variables using
   only opaque references;
6. one side-effect-free `unity_debug_evaluate_safe`;
7. `unity_debug_continue` and `unity_debug_disconnect`.

Require no raw DAP IDs, no bridge/config tokens, and no unexpected Unity
Console errors or warnings.

- [ ] **Step 7: Record exact artifacts and repository state**

```powershell
Get-FileHash D:\Unity\unity-debugger-vscode\dist\unity-debugger-pure-0.2.0.vsix -Algorithm SHA256
Get-FileHash D:\Unity\unity-debugger-pure-mcp\dist\unity-debugger-pure-mcp-0.1.1.vsix -Algorithm SHA256
git -C D:\Unity\unity-debugger-pure-mcp status --short
git -C D:\Unity\unity-debugger-vscode status --short
git -C D:\Unity\TuanjieHub\Projects\MyGame status --short
```

Report intended changes separately for all three repositories/config roots.

- [ ] **Step 8: Request final code review and release authorizations**

Review the complete companion diff for path traversal, ownership bypass,
broad deletion, TOCTOU, token leakage, activation cleanup, and package drift.
Resolve any Critical or Important finding and repeat Steps 1–7.

Then request explicit authorization separately for:

1. committing any remaining implementation changes;
2. pushing debugger 0.2.0 and companion 0.1.1 branches;
3. publishing debugger 0.2.0 first;
4. publishing companion 0.1.1 only after debugger 0.2.0 is publicly verified.

Do not create `launcher-v0.1.1` or republish PyPI.
