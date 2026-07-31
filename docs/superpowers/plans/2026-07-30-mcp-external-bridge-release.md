# Unity Debugger Pure MCP External Bridge and Release Implementation Plan

> **Superseded external-launcher design:** The `globalStorageUri` installer,
> `.cmd` launcher, version pointer, and configuration-renderer tasks in this
> historical plan must not be implemented. The approved replacement is the
> version-pinned PyPI/`uvx` launcher and live-registration architecture in
> `2026-07-31-unity-debugger-pure-mcp-pypi-launcher.md`. This file is retained
> only as implementation history for the companion core and its release gates.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, upgrade-safe external MCP bridge installation path for Codex, Claude-compatible clients, and generic stdio clients; prove reconnect, workspace isolation, packaging, and the complete real-Editor flow before releasing the two dependent VSIXes.

**Architecture:** Each companion extension window publishes a short-lived authenticated descriptor beneath its `globalStorageUri`. The external stdio server is installed only by an explicit command into versioned storage behind a stable launcher and resolves a live VS Code window by canonical workspace roots on every connection or reconnect. Configuration renderers display/copy scoped snippets but never edit third-party settings. Release gates cover descriptor security, bridge upgrades, dual-client serialization, package inventories, and user-confirmed acceptance in the existing `MyGame` Editor and its VS Code window.

**Tech Stack:** TypeScript 7.0.2, VS Code Extension API ^1.101.0, Node.js 26.5.0, `@modelcontextprotocol/sdk` 1.30.0, Zod 4.4.3, Vitest 4.1.10, Node test runner, esbuild 0.28.1, Node single-executable applications, VSCE 3.9.2.

## Global Constraints

- Prerequisites: the public-API and companion-core plans are complete and their full simulated/package gates pass.
- VS Code must be running for debugging. The external bridge may initialize while VS Code is closed, but every debugger tool then returns `BRIDGE_UNAVAILABLE`; it never launches VS Code, an Editor, or `UnityDebuggerPure.exe`.
- Normal companion activation may create/update live descriptor files only. It must not install an external executable, launcher, or third-party configuration.
- Only `Unity Debugger Pure MCP: Install/Update External MCP Bridge` may write executable material into `globalStorageUri/external/`.
- Persistent layout is `external/run-unity-debugger-pure-mcp.cmd`, `external/current.json`, `external/versions/<version>/mcp-bridge.exe`, and `external/bridges/<bridgeId>.json`.
- `current.json` is the single atomic version pointer. Third-party configuration points only to the stable launcher, never a VSIX directory or a versioned executable.
- Live descriptors refresh every 15 seconds, become stale after 45 seconds, and are removed on companion deactivation. Capability tokens and raw paths never enter logs.
- External allowlisted workspace roots are canonical roots captured when the snippet is generated. MCP client roots may narrow but never expand that set.
- Zero matching windows returns `BRIDGE_UNAVAILABLE`; more than one matching live window returns `AMBIGUOUS_BRIDGE`. Never select the first match.
- An external process reconnects using a newly read descriptor after pipe closure or token rotation. It does not cache capability tokens beyond one connection attempt.
- A bridge/client exit never stops the VS Code debug session. Multiple built-in and external clients share the companion's existing per-session command queue.
- Codex, Claude-compatible, and generic snippets are displayed or copied only; do not modify their configuration files automatically.
- stdout remains MCP framing only. Launcher, locator, and installer diagnostics are sanitized and use stderr or the companion output channel.
- Real acceptance uses only `H:\workspace\Unity\Tuanjie\Projects\MyGame` and the VS Code window opened from it. Do not create or launch another Editor project or VS Code profile.
- Before the real acceptance Computer Use session, obtain a fresh explicit user confirmation. Close Computer Use immediately after the specific interaction.

---

## File Structure

### Live descriptor and external server discovery

- `mcp-extension/src/bridge/liveBridgeDirectory.ts` — descriptor publication, heartbeat, pruning, and deactivation cleanup.
- `mcp-extension/src/bridge/protocol.ts` — versioned descriptor schema shared by the extension and server bundle.
- `mcp-extension/src/extension.ts` — start/stop the descriptor publisher after the pipe host.
- `mcp-server/src/bridgeLocator.ts` — canonical-root filtering and unambiguous live-window selection.
- `mcp-server/src/rootPolicy.ts` — configured allowlist plus optional MCP Roots narrowing.
- `mcp-server/src/bridgeClient.ts` — direct mode for VS Code and reconnecting registry mode for external clients.
- `mcp-server/src/server.ts` — mutually exclusive direct/registry argument modes and deferred bridge failures.

### Explicit installer and configuration UX

- `mcp-extension/src/externalStorage.ts` — stable persistent paths and atomic pointer writes.
- `mcp-extension/src/externalBridgeInstaller.ts` — verified versioned install/update operation.
- `mcp-extension/src/configSnippets.ts` — deterministic generic, Codex TOML, and Claude JSON rendering.
- `mcp-extension/src/commands.ts` — install/update, show, and copy commands.
- `mcp-extension/assets/run-unity-debugger-pure-mcp.cmd` — quiet stable launcher template.
- `mcp-extension/package.json` — command contributions and packaged asset.
- `mcp-extension/README.md`, `mcp-extension/SECURITY.md` — external setup, trust, and lifecycle documentation.

### Tests and release evidence

- `tests/mcp-extension/liveBridgeDirectory.test.ts`
- `tests/mcp-extension/externalBridgeInstaller.test.ts`
- `tests/mcp-extension/configSnippets.test.ts`
- `tests/mcp-extension/commands.test.ts`
- `tests/mcp-server/bridgeLocator.test.ts`
- `tests/mcp-server/rootPolicy.test.ts`
- `tests/integration/mcpExternalBridge.integration.test.ts`
- `tests/integration/mcpDualClient.integration.test.ts`
- `tests/package/mcp-vsix.test.mjs`
- `scripts/verify-mcp-vsix.mjs`
- `docs/mcp-real-editor-acceptance.md`
- `docs/release-checklist.md`

## Task 1: Publish live window descriptors and reconnect external servers

**Files:**
- Create: `mcp-extension/src/bridge/liveBridgeDirectory.ts`
- Create: `mcp-server/src/bridgeLocator.ts`
- Create: `mcp-server/src/rootPolicy.ts`
- Modify: `mcp-extension/src/bridge/protocol.ts`
- Modify: `mcp-extension/src/extension.ts`
- Modify: `mcp-server/src/bridgeClient.ts`
- Modify: `mcp-server/src/server.ts`
- Test: `tests/mcp-extension/liveBridgeDirectory.test.ts`
- Test: `tests/mcp-server/bridgeLocator.test.ts`
- Test: `tests/mcp-server/rootPolicy.test.ts`

**Interfaces:**
- Consumes: live `BridgeHost` descriptor, canonical VS Code workspace roots, `globalStorageUri`, MCP client Roots, and the structured bridge errors from the core plan.
- Produces: `LiveBridgeDirectory.start/stop`, `BridgeLocator.locate`, `RootPolicy.effectiveRoots`, and external registry-mode `ToolBridge.callTool`.

- [ ] **Step 1: Write failing descriptor heartbeat and cleanup tests**

Use an injected filesystem, clock, timer scheduler, and process-liveness probe.
Assert the first descriptor is written before `start()` resolves, a heartbeat
rewrites `updatedAt` at 15,000 ms, `stop()` removes only its own descriptor, and
activation pruning removes a descriptor only when it is older than 45,000 ms
and its owner PID is no longer alive.

The stable descriptor shape is:

```ts
export interface LiveBridgeDescriptor {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly bridgeId: string;
  readonly ownerPid: number;
  readonly windowId: string;
  readonly pipeName: string;
  readonly token: string;
  readonly workspaceRoots: readonly string[];
  readonly extensionVersion: string;
  readonly updatedAt: number;
}
```

Require a UUID `bridgeId`, a non-empty `windowId`, a 32-byte base64url token,
only `\\.\pipe\` pipe names, unique canonical roots, and no additional JSON
properties.

- [ ] **Step 2: Write failing locator and workspace-policy tests**

Create descriptors for two live windows and assert:

```ts
await expect(locator.locate(["H:\\A"])).resolves.toMatchObject({
  bridgeId: "bridge-a",
});
await expect(locator.locate(["H:\\missing"])).rejects.toMatchObject({
  code: "BRIDGE_UNAVAILABLE",
});
await expect(locator.locate(["H:\\shared"])).rejects.toMatchObject({
  code: "AMBIGUOUS_BRIDGE",
});
```

Also assert malformed JSON, a symlink/reparse-point descriptor, timestamps
more than 45,000 ms old, dead owners, protocol mismatches, duplicate roots, and
descriptors outside the configured registry directory are ignored. Tests must
prove that no ignored descriptor's token is included in an error or diagnostic.

`RootPolicy` has this exact boundary:

```ts
export interface RootPolicy {
  effectiveRoots(clientRoots?: readonly string[]): readonly string[];
}

export function createRootPolicy(
  allowedRoots: readonly string[],
  canonicalize: (value: string) => string,
): RootPolicy;
```

An absent client root list returns the configured allowlist; supplied roots are
intersected with that allowlist; a supplied root outside it returns
`WORKSPACE_NOT_ALLOWED` instead of silently broadening access.

- [ ] **Step 3: Run the focused tests and verify missing modules**

Run:

```powershell
npx vitest run tests/mcp-extension/liveBridgeDirectory.test.ts tests/mcp-server/bridgeLocator.test.ts tests/mcp-server/rootPolicy.test.ts
```

Expected: FAIL because the directory, locator, and root-policy modules do not
exist.

- [ ] **Step 4: Implement atomic descriptor publication**

`LiveBridgeDirectory.start()` creates only the `external/bridges` directory,
prunes eligible stale/dead files, writes `<bridgeId>.json` through a same-
directory temporary file plus rename, and starts one 15-second interval. The
JSON file is one line and mode `0o600`; Windows ACLs inherit from the current-
user VS Code global storage directory. Never use a broad cleanup glob outside
the resolved `bridges` directory.

Use a stable window ID stored in `context.workspaceState` for the current
window and `process.pid` for liveness. Update roots on workspace-folder change
by publishing a complete replacement descriptor with the same bridge ID and a
fresh timestamp/token from the active `BridgeHost`.

- [ ] **Step 5: Implement strict locator selection**

`BridgeLocator` opens only direct `.json` children after `lstat`, rejects
reparse points, caps each file at 64 KiB, validates with strict Zod, checks
freshness and owner liveness, then compares case-insensitive resolved Windows
roots. A descriptor matches only when it contains every effective root. It
returns exactly one match or a structured `BRIDGE_UNAVAILABLE`/
`AMBIGUOUS_BRIDGE` error.

- [ ] **Step 6: Add external registry mode and reconnection**

Extend server arguments with exactly one of:

```text
--pipe <name> --token <base64url> --workspace <root>...
--registry <directory> --allow-root <root>...
```

Reject mixed modes, zero allow roots in registry mode, unknown arguments, and
relative registry paths. Keep direct mode unchanged for the built-in VS Code
provider.

Define one server-side boundary:

```ts
export interface ToolBridge {
  callTool(name: ToolName, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}
```

Registry mode calls `locate()` before the first request and after any socket
close/authentication failure, reads the selected token only for that attempt,
and retries the connection once. If no window is available, MCP initialization
and `tools/list` remain available while the tool result is a structured
`BRIDGE_UNAVAILABLE`. Never start an Adapter or child VS Code process.

- [ ] **Step 7: Integrate MCP Roots as a narrowing signal**

When the MCP client advertises Roots, request them initially and after the SDK
Roots-list-changed notification. Convert file URIs to local Windows paths,
reject non-file schemes, and update `RootPolicy`. Do not disconnect an already
running debug session when roots narrow; subsequent calls must resolve only an
allowed matching window.

- [ ] **Step 8: Wire descriptor lifecycle into companion activation**

Start publication only after `BridgeHost.listen()` succeeds. Register workspace
folder change handling and push the publisher into `context.subscriptions`.
During deactivation, stop heartbeats, remove this window's descriptor, and then
close the pipe. Failure to remove a file is sanitized and must not block pipe
closure.

- [ ] **Step 9: Run transport, registry, and full core regressions**

Run:

```powershell
npx vitest run tests/mcp-extension/liveBridgeDirectory.test.ts tests/mcp-server/bridgeLocator.test.ts tests/mcp-server/rootPolicy.test.ts tests/mcp-server/bridgeClient.test.ts
npm run test:mcp
```

Expected: PASS; built-in direct mode and external registry mode both preserve
stdout purity.

- [ ] **Step 10: Commit the live registry slice**

```powershell
git add mcp-extension/src/bridge mcp-extension/src/extension.ts mcp-server/src tests/mcp-extension/liveBridgeDirectory.test.ts tests/mcp-server/bridgeLocator.test.ts tests/mcp-server/rootPolicy.test.ts
git commit -m "feat: reconnect external MCP clients to live windows"
```

## Task 2: Add the explicit versioned bridge installer and stable launcher

**Files:**
- Create: `mcp-extension/src/externalStorage.ts`
- Create: `mcp-extension/src/externalBridgeInstaller.ts`
- Create: `mcp-extension/assets/run-unity-debugger-pure-mcp.cmd`
- Modify: `mcp-extension/package.json`
- Modify: `mcp-extension/.vscodeignore`
- Modify: `mcp-extension/src/extension.ts`
- Test: `tests/mcp-extension/externalBridgeInstaller.test.ts`

**Interfaces:**
- Consumes: packaged `dist/mcp-bridge.exe`, `runtime-inventory.json`, `context.globalStorageUri`, and an explicit VS Code command invocation.
- Produces: `ExternalStoragePaths`, `ExternalBridgeInstaller.install`, stable launcher/current pointer, and `InstallResult`.

- [ ] **Step 1: Write failing storage-layout and installer tests**

Use a temporary path containing spaces and assert:

```ts
const result = await installer.install({
  extensionVersion: "0.1.0",
  executable: packagedBridge,
  expectedSha256: bridgeSha256,
});

expect(result).toEqual({
  installedVersion: "0.1.0",
  launcher: path.join(storageRoot, "external", "run-unity-debugger-pure-mcp.cmd"),
  registry: path.join(storageRoot, "external", "bridges"),
  changed: true,
});
```

Verify exact content/hash of `versions/0.1.0/mcp-bridge.exe`, a valid one-line
`current.json`, and a launcher that emits no stdout before replacing itself
with the bridge. A repeated same-version/same-hash install returns
`changed: false`. Same version with another hash fails closed. An update to
0.1.1 changes only the pointer; a spawned 0.1.0 process remains runnable.

Inject a failure before pointer replacement and assert the prior pointer and
launcher remain usable and no partial version directory is selected.

- [ ] **Step 2: Run the installer test and verify missing implementation**

Run: `npx vitest run tests/mcp-extension/externalBridgeInstaller.test.ts`

Expected: FAIL because the storage/installer modules and launcher asset do not
exist.

- [ ] **Step 3: Define exact persistent paths and pointer schema**

```ts
export interface ExternalStoragePaths {
  readonly root: string;
  readonly launcher: string;
  readonly current: string;
  readonly versions: string;
  readonly bridges: string;
}

export interface CurrentBridgePointer {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly executable: `versions/${string}/mcp-bridge.exe`;
  readonly sha256: string;
}
```

Resolve every child from `context.globalStorageUri.fsPath/external`, reject
traversal and separators in versions, and verify final paths remain inside the
external root before creating, copying, renaming, or deleting anything.

- [ ] **Step 4: Add the quiet stable launcher**

The committed `.cmd` template reads the one-line `current.json`, extracts the
validated semver, and executes only:

```bat
@echo off
setlocal
set "MCP_EXTERNAL_ROOT=%~dp0"
for /f "usebackq tokens=2 delims=:, " %%V in (`findstr /c:"\"version\"" "%MCP_EXTERNAL_ROOT%current.json"`) do set "MCP_VERSION=%%~V"
if not defined MCP_VERSION exit /b 2
"%MCP_EXTERNAL_ROOT%versions\%MCP_VERSION%\mcp-bridge.exe" --registry "%MCP_EXTERNAL_ROOT%bridges" %*
exit /b %ERRORLEVEL%
```

Installer validation permits only strict `major.minor.patch` version text, so
the parsed value cannot introduce metacharacters or a path escape. The launcher
uses no `echo`, does not parse tokens, and forwards stdio unchanged.

- [ ] **Step 5: Implement verified staged installation**

Before copying, SHA-256 the packaged executable and compare it with the
committed inventory. Copy into a unique staging directory inside `versions`,
flush/close it, hash the copy, and rename the complete directory to its final
version. Write a same-directory temporary `current.json`, flush it, and rename
over the prior pointer. Copy the launcher only after verifying its committed
content. Never delete a previous version during install/update.

Expose no install call from activation. Register only the command handler; the
handler performs installation when the user invokes it.

- [ ] **Step 6: Add manifest/package boundaries**

Contribute exactly:

```json
{
  "command": "unity-debugger-pure-mcp.installExternalBridge",
  "title": "Unity Debugger Pure MCP: Install/Update External MCP Bridge"
}
```

Package the launcher asset and runtime inventory, but do not package a second
Adapter or Mono file. Activation without invoking the command must leave
`external/versions`, `current.json`, and the launcher absent.

- [ ] **Step 7: Run installer and package regressions**

Run:

```powershell
npx vitest run tests/mcp-extension/externalBridgeInstaller.test.ts
npm run build:mcp-extension
npm run package:mcp
```

Expected: PASS from a path containing spaces and with Node removed from the
bridge smoke-test `PATH`.

- [ ] **Step 8: Commit the explicit installer**

```powershell
git add mcp-extension/src/externalStorage.ts mcp-extension/src/externalBridgeInstaller.ts mcp-extension/assets mcp-extension/package.json mcp-extension/.vscodeignore mcp-extension/src/extension.ts tests/mcp-extension/externalBridgeInstaller.test.ts
git commit -m "feat: install versioned external MCP bridge"
```

## Task 3: Render scoped Codex, Claude-compatible, and generic configurations

**Files:**
- Create: `mcp-extension/src/configSnippets.ts`
- Create: `mcp-extension/src/commands.ts`
- Modify: `mcp-extension/src/extension.ts`
- Modify: `mcp-extension/package.json`
- Modify: `mcp-extension/README.md`
- Modify: `mcp-extension/SECURITY.md`
- Test: `tests/mcp-extension/configSnippets.test.ts`
- Test: `tests/mcp-extension/commands.test.ts`

**Interfaces:**
- Consumes: successful `InstallResult`, current canonical workspace roots, VS Code clipboard/document APIs, and explicit command invocations.
- Produces: `renderCodexToml`, `renderClaudeJson`, `renderGenericStdio`, install/show/copy command handlers, and user-facing setup documentation.

- [ ] **Step 1: Write failing deterministic renderer tests**

For launcher `H:\\User Data\\run-unity-debugger-pure-mcp.cmd` and root
`H:\\workspace\\MyGame`, require the Codex renderer to produce:

```toml
[mcp_servers.unity_debugger_pure]
command = "H:\\User Data\\run-unity-debugger-pure-mcp.cmd"
args = ["--allow-root", "H:\\workspace\\MyGame"]
startup_timeout_sec = 10
tool_timeout_sec = 65
```

Require the Claude-compatible renderer to parse as:

```json
{
  "mcpServers": {
    "unity-debugger-pure": {
      "command": "H:\\User Data\\run-unity-debugger-pure-mcp.cmd",
      "args": ["--allow-root", "H:\\workspace\\MyGame"]
    }
  }
}
```

Add escaping cases for spaces, quotes, non-ASCII names, two workspace roots,
case-insensitive duplicates, and control-character rejection. The generic
renderer returns `{ command, args, env: {} }`, not shell text.

- [ ] **Step 2: Write failing command-side-effect tests**

Assert normal activation does not call `installer.install`, write the clipboard,
or open a document. Invoking install calls the installer once, then opens a
read-only untitled Markdown document containing all three snippets and the
scoped roots. Copy commands write exactly one selected snippet only after a
successful install/current-pointer check.

If no workspace is open, no snippet is generated and the command shows:
`Open the Unity project workspace before configuring an external MCP client.`

- [ ] **Step 3: Run renderer/command tests and verify missing modules**

Run: `npx vitest run tests/mcp-extension/configSnippets.test.ts tests/mcp-extension/commands.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement canonical root capture and escaping**

Read roots only from `vscode.workspace.workspaceFolders`, resolve and deduplicate
them with Windows case-insensitive comparison, then freeze the array used by all
renderers. Render TOML basic strings with JSON-compatible escaping and JSON
through `JSON.stringify(value, null, 2)`. Never accept roots from an arbitrary
text input or tool call.

Every snippet invokes the stable launcher with repeated `--allow-root` pairs.
Do not embed a pipe name, token, versioned executable, VSIX path, Adapter path,
environment secret, or current debug session ID.

- [ ] **Step 5: Implement explicit setup commands**

Register:

- `unity-debugger-pure-mcp.installExternalBridge` — install/update and show all snippets;
- `unity-debugger-pure-mcp.showExternalConfig` — verify an installed pointer and show snippets;
- `unity-debugger-pure-mcp.copyCodexConfig` — copy only Codex TOML;
- `unity-debugger-pure-mcp.copyClaudeConfig` — copy only Claude-compatible JSON.

No command locates or edits a Codex/Claude settings file. Confirm the installed
bridge hash before rendering. Sanitize errors to version, error code, and next
action without exposing global-storage paths or tokens.

- [ ] **Step 6: Document external lifecycle clearly**

Document that VS Code and the companion must remain running; close/reopen causes
automatic descriptor/token refresh; a configured root cannot access another
workspace; `BRIDGE_UNAVAILABLE` means open the correct VS Code window; and
`AMBIGUOUS_BRIDGE` means close duplicate windows or use a narrower root set.
Explain that disabling the companion leaves installed versioned bridge files
in global storage but they cannot control a debugger without a live descriptor.

- [ ] **Step 7: Run command, activation, and security regressions**

Run:

```powershell
npx vitest run tests/mcp-extension/configSnippets.test.ts tests/mcp-extension/commands.test.ts tests/mcp-extension/extension.test.ts
npm run test:mcp-extension
```

Expected: PASS with no automatic external-client configuration writes.

- [ ] **Step 8: Commit external configuration UX**

```powershell
git add mcp-extension/src/configSnippets.ts mcp-extension/src/commands.ts mcp-extension/src/extension.ts mcp-extension/package.json mcp-extension/README.md mcp-extension/SECURITY.md tests/mcp-extension/configSnippets.test.ts tests/mcp-extension/commands.test.ts
git commit -m "feat: render scoped external MCP configurations"
```

## Task 4: Prove external reconnect, upgrades, and dual-client serialization

**Files:**
- Create: `tests/integration/mcpExternalBridge.integration.test.ts`
- Create: `tests/integration/mcpDualClient.integration.test.ts`
- Modify: `tests/package/mcp-vsix.test.mjs`
- Modify: `scripts/verify-mcp-vsix.mjs`
- Modify: `mcp-extension/runtime-inventory.json`
- Modify: `mcp-extension/README.md`
- Modify: `mcp-extension/CHANGELOG.md`
- Modify: `mcp-extension/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: packaged SEA bridge, fake live-window descriptors/pipes, fake VS Code debug sessions, and companion VSIX.
- Produces: subprocess-level proof of external behavior and a release-grade companion artifact audit.

- [ ] **Step 1: Write the failing external subprocess integration test**

Install into a temporary global-storage path containing spaces, launch the
stable `.cmd` with Node absent from `PATH`, and connect through the MCP SDK.
Exercise:

1. initialize and list all 19 tools with no live descriptor;
2. call status and receive `BRIDGE_UNAVAILABLE`;
3. publish one fake live window and attach through its real named pipe;
4. rotate pipe/token/descriptor and prove the same MCP process reconnects;
5. remove the descriptor and prove no Adapter or VS Code child process starts;
6. publish two matching descriptors and receive `AMBIGUOUS_BRIDGE`; and
7. narrow MCP Roots, reject an outside root, and reconnect to the remaining match.

Capture stdout as MCP protocol bytes and stderr separately. Assert no token,
expression, variable value, or raw workspace path appears on stderr.

- [ ] **Step 2: Write the failing dual-client serialization test**

Start one direct-mode built-in MCP server and one registry-mode external server
against the same fake companion/VS Code session. Hold a `continue` request open,
issue `variables` and `step` from the other client, then release. Assert the
single extension-side `SessionCommandQueue` determines the same stable order on
three repeated runs, stale references are rejected, and neither client exit
calls `stopDebugging`.

- [ ] **Step 3: Extend package audit failures first**

Require the companion VSIX to contain exactly one SEA executable, the launcher
asset, `runtime-inventory.json`, documentation/notices, and extension bundle.
Reject:

- an executable whose SHA-256 differs from inventory;
- absolute, `..`, ADS, case-colliding, or reserved-device ZIP paths;
- Adapter/Mono files or strings in packaged paths;
- a launcher that points to a VSIX/version directory directly;
- unpinned MCP SDK/Zod dependencies; and
- an activation path that calls the external installer.

- [ ] **Step 4: Run the new tests and verify the intended failures**

Run:

```powershell
npx vitest run tests/integration/mcpExternalBridge.integration.test.ts tests/integration/mcpDualClient.integration.test.ts
node --test tests/package/mcp-vsix.test.mjs
```

Expected: FAIL until reconnect, package, and inventory integration is complete.

- [ ] **Step 5: Implement only the integration fixes exposed by the tests**

Keep retry bounded to one locator refresh per tool call, preserve the original
structured error if reconnect still fails, and ensure a new call can recover.
Do not add a background process, polling TCP listener, Adapter spawn, or session
termination behavior.

Regenerate `runtime-inventory.json` only with the pinned Node 26.5.0 build and
review the diff: expected fields are bridge version, Node version, file size,
and lowercase SHA-256. No local absolute build path belongs in the inventory.

- [ ] **Step 6: Run all automated release gates**

Run:

```powershell
npm ci
npm run verify:third-party
npm test
npm run test:mcp
npx vitest run tests/integration/mcpExternalBridge.integration.test.ts tests/integration/mcpDualClient.integration.test.ts
npm run package
npm run package:mcp
node --test tests/package/*.test.mjs
```

Expected: PASS. Inspect both VSIX inventories and confirm only
`unity-debugger-pure-0.2.0.vsix` contains the Adapter/Mono runtime.

- [ ] **Step 7: Commit automated external/release proof**

```powershell
git add tests/integration/mcpExternalBridge.integration.test.ts tests/integration/mcpDualClient.integration.test.ts tests/package/mcp-vsix.test.mjs scripts/verify-mcp-vsix.mjs mcp-extension/runtime-inventory.json mcp-extension/README.md mcp-extension/CHANGELOG.md mcp-extension/THIRD_PARTY_NOTICES.md
git commit -m "test: verify external MCP bridge release"
```

## Task 5: Perform the constrained real-Editor acceptance and finalize release evidence

**Files:**
- Create: `docs/mcp-real-editor-acceptance.md`
- Modify: `docs/release-checklist.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `mcp-extension/README.md`
- Modify: `mcp-extension/CHANGELOG.md`

**Interfaces:**
- Consumes: both audited VSIXes, the already-running `MyGame` Editor, the VS Code window opened from `MyGame`, and a proven-reachable existing `MyGame/DevTools` code path.
- Produces: recorded acceptance evidence, final install/use instructions, and release readiness decision.

- [ ] **Step 1: Record the clean automated baseline**

Run `git status --short`, record both VSIX SHA-256 values, Node version, package
audit results, and the exact commit in `docs/mcp-real-editor-acceptance.md`.
Do not mark real-Editor items complete yet.

- [ ] **Step 2: Verify the required existing applications without launching them**

Use read-only process/window checks to confirm:

- the existing Tuanjie/Unity Editor has
  `H:\workspace\Unity\Tuanjie\Projects\MyGame` open; and
- the VS Code instance was opened from that same `MyGame` workspace.

If either is absent, stop and ask the user to open it. Do not launch another
Editor, project, VS Code instance, profile, or Extension Development Host.

- [ ] **Step 3: Prove breakpoint reachability before Computer Use**

Inspect existing `MyGame/DevTools` scripts, active-scene/prefab attachments,
bootstrap/call-site references, and any already observed runtime behavior.
Record the exact method and line plus concrete reachability evidence. If no
candidate is proven reachable, stop and ask the user for a reachable action;
do not treat a future missed breakpoint as a debugger failure.

- [ ] **Step 4: Pause for fresh explicit Computer Use confirmation**

Tell the user exactly which MyGame/Tuanjie/VS Code interactions will be
performed and ask for confirmation. Do not start Computer Use until the user
explicitly confirms at this point, even if they confirmed an earlier session.

- [ ] **Step 5: Run and immediately close the first focused Computer Use session**

In only the existing MyGame VS Code/Editor windows:

1. install the audited debugger 0.2.0 VSIX and companion 0.1.0 VSIX;
2. verify the built-in MCP server appears;
3. start a visible MCP attach and confirm the normal debug UI/session;
4. add source and conditional breakpoints at the proven-reachable line;
5. trigger that known path and verify breakpoint/UI synchronization;
6. exercise pause, continue, step in/over/out, threads, stack, scopes,
   bounded variables, snapshot, safe evaluation, explicit evaluation, and
   exception policy;
7. trigger Domain Reload and verify state/reference invalidation plus breakpoint
   recovery;
8. invoke the explicit external installer, use the generated scoped snippet,
   and run built-in plus external calls concurrently against the same session;
9. disable the companion and verify ordinary debugger use still works; and
10. re-enable the companion, then close the relevant VS Code window.

Close Computer Use immediately after the VS Code window closes. From the shell,
verify the already-running external client returns `BRIDGE_UNAVAILABLE` and
does not launch VS Code or an Adapter.

- [ ] **Step 6: Have the user reopen MyGame VS Code, then reconfirm Computer Use**

Ask the user to reopen VS Code from the existing MyGame Editor/project; do not
launch it yourself. Verify the correct window with read-only checks. Then state
the reconnect interaction and obtain a new explicit confirmation before
starting a second Computer Use session.

- [ ] **Step 7: Verify reconnect and immediately close Computer Use again**

In the reopened MyGame window, verify the companion publishes a new pipe/token,
the same external client reconnects through the stable registry, and ordinary
debugger plus MCP attach still work. Close Computer Use immediately afterward.

- [ ] **Step 8: Record evidence and resolve failures correctly**

For each item, record pass/fail, exact tool/result state, event sequence, and a
sanitized screenshot/log reference. Never record capability tokens,
expressions, source content, variable values, or raw private paths beyond the
approved MyGame path. A missed breakpoint without the Step 3 reachability proof
is inconclusive, not a debugger failure.

If acceptance exposes a bug, stop release finalization and use
`superpowers:systematic-debugging`, then rerun the smallest automated regression
and only the affected user-confirmed Editor interaction.

- [ ] **Step 9: Finalize documentation and release checklist**

Document installation order, dependency behavior, VS Code-running requirement,
external bridge explicit install/update, Codex/Claude-compatible snippets,
safe/explicit evaluation, trust/allowlist errors, uninstall leftovers, and how
to remove `globalStorageUri/external/` after all external clients are stopped.

Mark the release ready only when all automated gates and every required real-
Editor acceptance item pass.

- [ ] **Step 10: Run final verification and commit evidence**

Run:

```powershell
npm test
npm run test:mcp
npm run package
npm run package:mcp
git status --short
```

Expected: all tests and audits PASS; only intentional documentation evidence is
uncommitted before this commit.

```powershell
git add docs/mcp-real-editor-acceptance.md docs/release-checklist.md README.md CHANGELOG.md mcp-extension/README.md mcp-extension/CHANGELOG.md
git commit -m "docs: record MCP companion acceptance"
```

## Completion Gate

The feature is complete only when:

- The companion remains an independent extension depending on `kpk.unity-debugger-pure`; it does not contain or launch the Adapter.
- Built-in direct mode and external registry mode expose the same 19 strict tools.
- External installation occurs only through the explicit command and writes only beneath the companion's `globalStorageUri/external/`.
- The stable launcher survives companion upgrades and selects the atomically pointed version while already-running older bridges finish naturally.
- Descriptor heartbeat, expiry, owner liveness, token rotation, ambiguous windows, and VS Code-closed behavior are proven by subprocess tests.
- Configured roots and MCP Roots can only narrow access; arbitrary executable, host, port, pipe, token, and workspace inputs remain impossible.
- Codex, Claude-compatible, and generic configurations are displayed/copied but never installed into third-party settings automatically.
- Built-in and external clients share one VS Code debug session and one serialized command queue; client exit never terminates that session.
- Both VSIX inventories/hashes pass, the SEA works without Node on `PATH`, and stdout contains only MCP protocol data.
- Real acceptance used only the existing MyGame Editor and its VS Code window, with proven breakpoint reachability and fresh Computer Use confirmation.
- Disabling the companion preserves ordinary debugger operation, and closing VS Code makes external tools fail closed with `BRIDGE_UNAVAILABLE`.
