# Unity Debugger Pure MCP PyPI Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex start the existing VSIX-bundled Unity debugger MCP bridge through a pinned `uvx` command, without machine-specific paths, environment variables, or a second debugger implementation.

**Architecture:** The companion Extension Host publishes one current-user live-registration record after its named-pipe Host is listening. A small standard-library Python launcher discovers and validates the one record containing the current Codex project root, then replaces itself with the audited `mcp-bridge.exe` in a new registry mode. Registry mode retains the existing MCP server and 19-tool catalog, reconnects only before a later call after VS Code reload, and never replays an interrupted call. VS Code's native MCP provider remains on the existing direct mode.

**Tech Stack:** TypeScript 7, Node.js 26.5.0 SEA, VS Code 1.101 extension API, MCP TypeScript SDK 1.30.0, Windows named pipes, Python 3.10+ standard library, uv 0.12.0, uv_build, wheel 0.47.0, Vitest, Node test runner, Python unittest.

> **Release supersession (2026-07-31):** The coupled GitHub release step in
> Task 7 and the publication steps in Task 8 are retained as historical
> implementation evidence but are no longer operative. The approved
> independent companion/launcher release specification and
> `2026-07-31-independent-release-workflows.md` replace them.

## Global Constraints

- Implement product code, tests, launcher packaging, and release changes only in `D:\Unity\unity-debugger-pure-mcp`.
- Do not modify `D:\Unity\unity-debugger-vscode`; debugger public API v1 is already the required boundary.
- Do not add the bridge executable, Node.js, Adapter, Mono assemblies, an MCP implementation, or third-party runtime dependencies to the PyPI package.
- Preserve the existing VS Code provider's direct arguments byte-for-byte: `--pipe`, `--token`, and repeated `--workspace` values.
- Never put a live pipe token in registry-mode process arguments, stdout, stderr, logs, tests, or committed fixtures. Deterministic fake 32-byte tokens are allowed only in isolated protocol fixtures.
- Keep MCP stdout protocol-only. Before `exec`, the Python launcher may write only sanitized failures to stderr.
- Treat registration schema 1, bridge protocol 1, a 15-second heartbeat, a 45-second stale threshold, and a 1 MiB bridge frame limit as fixed compatibility constants.
- Every path comparison must use native real-path canonicalization and case-insensitive Windows comparison. Tests must cover spaces, non-ASCII paths, junction/symlink escape, and different drives.
- The Python sources are pure Python, but the reviewed wheel is intentionally retagged `py3-none-win_amd64` because this launcher is a Windows x64 product. Verify both the filename tag and the wheel's `WHEEL` metadata after retagging.
- Do not publish to TestPyPI or PyPI, create a remote, write credentials, or edit MyGame configuration until the explicit publication gate in Task 8.
- Do not use Computer Use for protocol validation. For MyGame/Unity validation, first follow `docs/agent-rules/unity-mcp-validation.md`: call Unity MCP `debug_request_context`, verify the active MyGame instance, and use Unity MCP for Editor-visible checks when possible.
- Use exact Node.js `v26.5.0` whenever building or verifying the SEA. A different patch version is a hard failure, not a substitute.
- Keep the working tree clean between tasks. Commit each completed MCP-repository task with the message shown below. Do not commit the consuming MyGame configuration without separate explicit user authorization.

---

## Task 1: Define and validate live-registration schema v1

**Files:**

- Create: `src/external/liveHostRegistration.ts`
- Create: `tests/fixtures/live-host-registration-v1.json`
- Create: `tests/extension/liveHostRegistration.test.ts`
- Modify: `src/tools/errors.ts`
- Modify: `tests/extension/bridgeProtocol.test.ts`

### Contract to implement

The TypeScript module must have no `vscode` import so the Extension Host and bundled server can share it:

```ts
export const LIVE_HOST_SCHEMA_VERSION = 1 as const;
export const LIVE_HOST_HEARTBEAT_MS = 15_000;
export const LIVE_HOST_STALE_MS = 45_000;
export const LIVE_HOST_MAX_RECORD_BYTES = 65_536;

export interface LiveHostRegistrationV1 {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly ownerPid: number;
  readonly updatedAt: string;
  readonly workspaceRoots: readonly string[];
  readonly bridge: {
    readonly version: string;
    readonly protocolVersion: 1;
    readonly extensionRoot: string;
    readonly executable: string;
    readonly sha256: string;
  };
  readonly pipe: {
    readonly name: string;
    readonly token: string;
  };
}

export function parseLiveHostRegistration(
  bytes: Buffer,
): LiveHostRegistrationV1;

export function resolveRuntimeRegistryRoot(localAppData: string): string;
export function canonicalPathContains(root: string, candidate: string): boolean;
```

Parsing is exact and rejects extra keys. Bound the record to 64 KiB, roots to 32, paths to 4096 UTF-16 code units, pipe names to 512, versions to 64, UUID text to 36, and tokens to exactly 32 decoded bytes / 43 base64url characters. Require a lowercase 64-character SHA-256 digest and an ISO-8601 UTC timestamp ending in `Z`.

Add a stable `ambiguousBridgeError()` factory to the already-listed `AMBIGUOUS_BRIDGE` code in `src/tools/errors.ts`:

```ts
export function ambiguousBridgeError(): StructuredToolError {
  return Object.freeze({
    code: "AMBIGUOUS_BRIDGE",
    message: "More than one live debugger bridge matches this workspace.",
    retryable: false,
    currentState: "multiple_bridges",
    action: "Close the extra VS Code window and retry the request.",
  });
}
```

### TDD steps

- [ ] Add the sanitized fixture with `C:\\fixture\\project`, a fake pipe, and a fake token; never use a real username, installed extension path, or live token.
- [ ] Write RED tests for exact parsing, unknown keys, malformed UTF-8/JSON, oversized input, invalid UUID/PID/timestamp/root/path/hash/pipe/token, and deeply nested input.
- [ ] Write RED path tests for root equality, descendants, sibling prefixes, `..`, case folding, other drives, spaces, and non-ASCII text.
- [ ] Write a RED test requiring `ambiguousBridgeError()` to pass `STRUCTURED_TOOL_ERROR_SCHEMA`.
- [ ] Run:

  ```powershell
  npm exec -- vitest run tests/extension/liveHostRegistration.test.ts tests/extension/bridgeProtocol.test.ts
  ```

  Expected RED: the new module/export does not exist.

- [ ] Implement only the schema, parser, runtime-root resolver, containment helper, and error factory.
- [ ] Re-run the focused tests and `npm run typecheck`.
- [ ] Run the existing bridge protocol tests to prove no wire-frame change.
- [ ] Commit:

  ```powershell
  git add src/external/liveHostRegistration.ts src/tools/errors.ts tests/fixtures/live-host-registration-v1.json tests/extension/liveHostRegistration.test.ts tests/extension/bridgeProtocol.test.ts
  git commit -m "feat: define live MCP host registration"
  ```

## Task 2: Publish and clean up the live Extension Host registration

**Files:**

- Create: `src/external/liveHostRegistrationPublisher.ts`
- Create: `tests/extension/liveHostRegistrationPublisher.test.ts`
- Modify: `src/extension.ts`
- Modify: `tests/extension/extension.test.ts`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`

### Publisher boundary

```ts
export interface LiveHostWorkspaceSnapshot {
  readonly trusted: boolean;
  readonly roots: readonly string[];
}

export interface LiveHostRegistrationPublisherOptions {
  readonly localAppData: string;
  readonly ownerPid: number;
  readonly extensionRoot: string;
  readonly bridgeExecutable: string;
  readonly bridgeVersion: string;
  readonly bridgeSha256: string;
  readonly descriptor: BridgeDescriptor;
  readonly workspace: () => LiveHostWorkspaceSnapshot;
  readonly clock?: LiveHostPublisherClock;
  readonly randomUUID?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class LiveHostRegistrationPublisher {
  constructor(options: LiveHostRegistrationPublisherOptions);
  start(): Promise<void>;
  close(): Promise<void>;
}
```

`start()` performs one reconciliation only after `BridgeHost.listen()` has returned, then schedules 15-second reconciliations. Each reconciliation re-reads trust and workspace roots: it atomically creates/refreshes the owned record only when trusted with at least one canonical root, otherwise it removes the owned record. Stale foreign records are pruned only when older than 45 seconds and the owner PID is confirmed absent. `close()` is idempotent, clears its timer, waits for an in-progress write, and deletes only its owned record.

Production activation must read `runtime-inventory.json`, require exactly `nodeVersion` and `sha256`, hash the actual bridge once, and refuse activation if the bytes do not match the reviewed SHA. Add this injectable composition boundary:

```ts
interface LiveHostPublisherLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

createLiveHostRegistrationPublisher(
  descriptor: BridgeDescriptor,
): Promise<LiveHostPublisherLike>;
```

The production implementation derives `LOCALAPPDATA`, `process.pid`, `context.extensionUri.fsPath`, `context.asAbsolutePath("dist/mcp-bridge.exe")`, extension version, and the reviewed inventory internally. No path is configurable by the consuming project.

### TDD steps

- [ ] Write real temporary-directory RED tests for atomic initial write, exact JSON, 15-second refresh, trusted→untrusted removal, rootless suppression, canonical roots, idempotent close, same-instance cleanup, and concurrent close/write.
- [ ] Add stale-pruning RED tests covering dead owner, live owner, unreadable/malformed record, and a foreign fresh record.
- [ ] Add extension-composition RED tests proving the order:

  ```text
  activate debugger -> register lifecycle -> listen host -> start publisher -> register provider
  dispose provider -> close publisher -> close host -> dispose lifecycle
  ```

- [ ] Add failure tests proving publisher creation/start failure closes the Host and never registers the provider.
- [ ] Run:

  ```powershell
  npm exec -- vitest run tests/extension/liveHostRegistrationPublisher.test.ts tests/extension/extension.test.ts
  ```

  Expected RED: missing publisher and composition boundary.

- [ ] Implement atomic same-directory temp write/rename, heartbeat, trust/root reconciliation, PID-safe pruning, and cleanup. Do not log registration contents.
- [ ] Integrate it after `host.listen()` without changing `createMcpProvider()` or its direct arguments.
- [ ] Add scaffold assertions that `runtime-inventory.json` remains packaged and the new publisher has no dependency on the server workspace.
- [ ] Run focused tests, `npm run typecheck`, and `npm run test:extension`.
- [ ] Commit:

  ```powershell
  git add src/external/liveHostRegistrationPublisher.ts src/extension.ts tests/extension/liveHostRegistrationPublisher.test.ts tests/extension/extension.test.ts tests/build/mcp-companion-scaffold.test.mjs
  git commit -m "feat: publish live MCP host registrations"
  ```

## Task 3: Add registry discovery and a reconnecting bridge client

**Files:**

- Create: `server/src/liveHostRegistry.ts`
- Create: `server/src/registryBridgeClient.ts`
- Create: `tests/server/liveHostRegistry.test.ts`
- Create: `tests/server/registryBridgeClient.test.ts`
- Modify: `server/src/bridgeClient.ts`
- Modify: `tests/server/bridgeClient.test.ts`

### Registry and client boundaries

```ts
export interface LiveHostRegistryOptions {
  readonly runtimeRoot: string;
  readonly clientRoot: string;
  readonly runningExecutable: string;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class LiveHostRegistry {
  constructor(options: LiveHostRegistryOptions);
  locate(): Promise<BridgeDescriptor>;
}

export class RegistryBridgeClient implements BridgeToolCaller {
  static connect(registry: LiveHostRegistry): Promise<RegistryBridgeClient>;
  callTool(name: ToolName, input: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
}
```

`LiveHostRegistry` must canonicalize the current Windows `%LOCALAPPDATA%` runtime root, `clientRoot`, and `runningExecutable`; reject a supplied registry path that is not exactly the well-known v1 root; inspect bounded `.json` files only; and accept exactly one live registration whose canonical workspace contains the client root. It rechecks owner liveness, heartbeat age, protocol, regular-file status, SHA-256, `<extensionRoot>/dist/mcp-bridge.exe` equality, and equality between that registered executable and the currently running SEA before returning a descriptor.

Expose a read-only `ready` getter on `BridgeClient`. `RegistryBridgeClient` owns one underlying direct client and one shared in-progress reconnect operation. A call that begins while the old client is already closed may locate and connect once. A call sent on a client that fails during the request returns that failure and only clears the cached client; it must not replay the request. The next separate call may reconnect.

### TDD steps

- [ ] Write registry RED tests for one match, no match, ambiguity, stale/dead registrations, malformed files, other workspaces, nested client roots, path substitution, running-executable mismatch, SHA mismatch, protocol mismatch, and an unexpected registry root.
- [ ] Write reconnect RED tests for initial connection, shared concurrent reconnect, later-call recovery, one locate attempt per disconnected call, cancellation during reconnect, close during reconnect, and no replay after a sent mutation loses its socket.
- [ ] Use a fake `BridgeClient` factory in unit tests; separately preserve the existing real named-pipe `BridgeClient` tests.
- [ ] Run:

  ```powershell
  npm exec -- vitest run tests/server/liveHostRegistry.test.ts tests/server/registryBridgeClient.test.ts tests/server/bridgeClient.test.ts
  ```

  Expected RED: registry modules and `BridgeClient.ready` are absent.

- [ ] Implement the locator and reconnecting wrapper. Map multiple valid matches to `ambiguousBridgeError()` and all missing/integrity failures to the existing sanitized `bridgeUnavailableError()`.
- [ ] Re-run focused tests and `npm run typecheck:server`.
- [ ] Commit:

  ```powershell
  git add server/src/liveHostRegistry.ts server/src/registryBridgeClient.ts server/src/bridgeClient.ts tests/server/liveHostRegistry.test.ts tests/server/registryBridgeClient.test.ts tests/server/bridgeClient.test.ts
  git commit -m "feat: reconnect bridge through live registry"
  ```

## Task 4: Add mutually exclusive direct and registry bridge CLI modes

**Files:**

- Modify: `server/src/server.ts`
- Modify: `tests/server/stdioServer.test.ts`
- Modify: `scripts/build-mcp-bridge.mjs`
- Modify: `tests/package/mcp-smoke-stdout.test.mjs`
- Modify: `runtime-inventory.json`

### CLI union

Replace the single run options shape with a discriminated union:

```ts
export type ServerCliOptions =
  | Readonly<{
      mode: "direct";
      pipeName: string;
      token: string;
      workspaceRoots: readonly string[];
    }>
  | Readonly<{
      mode: "registry";
      runtimeRoot: string;
      clientRoot: string;
    }>;
```

Accepted forms are exactly:

```text
mcp-bridge --pipe <pipe> --token <token> [--workspace <root>]...
mcp-bridge --registry <runtime-root> --client-root <canonical-root>
```

Reject duplicates, unknown flags, empty values, overlong paths, direct/registry mixing, `--workspace` in registry mode, and `--registry` without `--client-root`. Help and diagnostics go to stderr only.

### TDD steps

- [ ] Extend argument RED tests for the full direct/registry matrix and assert that the existing direct parsed object and provider-generated arguments remain unchanged.
- [ ] Add run-server RED tests injecting direct and registry client factories, checking cleanup on stdin EOF, MCP close, startup error, and cancellation.
- [ ] Add a registry-mode SEA smoke harness that writes a sanitized temporary registration, performs initialize/tools-list, and proves 19 tools without putting the token in child argv.
- [ ] Run:

  ```powershell
  npm exec -- vitest run tests/server/stdioServer.test.ts
  node --test tests/package/mcp-smoke-stdout.test.mjs
  ```

  Expected RED: `--registry` is rejected as an invalid flag.

- [ ] Update `runServer()` to construct `BridgeClient` for direct mode and `RegistryBridgeClient` for registry mode behind a common `BridgeToolCaller & { close(): void }` boundary.
- [ ] Keep the current direct SEA smoke test and add registry smoke rather than replacing it.
- [ ] Run focused tests, server typecheck, and `npm run build:bridge` with exact Node `v26.5.0`. If the SEA bytes changed, first capture the expected inventory failure and candidate hash, independently verify AMD64 plus direct/registry smoke behavior, update only `runtime-inventory.json.sha256`, and rebuild until the reviewed-inventory check passes. Never stage the generated executable.
- [ ] Commit source, tests, and the reviewed inventory:

  ```powershell
  git add server/src/server.ts scripts/build-mcp-bridge.mjs tests/server/stdioServer.test.ts tests/package/mcp-smoke-stdout.test.mjs runtime-inventory.json
  git commit -m "feat: add registry mode to MCP bridge"
  ```

## Task 5: Implement the pure-Python `uvx` launcher

**Files:**

- Create: `launcher/pyproject.toml`
- Create: `launcher/uv.lock`
- Create: `launcher/README.md`
- Create: `launcher/LICENSE.txt`
- Create: `launcher/src/unity_debugger_pure_mcp_launcher/__init__.py`
- Create: `launcher/src/unity_debugger_pure_mcp_launcher/__main__.py`
- Create: `launcher/src/unity_debugger_pure_mcp_launcher/discovery.py`
- Create: `launcher/src/unity_debugger_pure_mcp_launcher/model.py`
- Create: `launcher/tests/test_discovery.py`
- Create: `launcher/tests/test_main.py`
- Modify: `.gitignore`

### Package metadata

```toml
[build-system]
requires = ["uv_build>=0.12.0,<0.13.0"]
build-backend = "uv_build"

[project]
name = "unity-debugger-pure-mcp"
version = "0.1.0"
description = "Launcher for the Unity Debugger Pure MCP companion."
readme = "README.md"
requires-python = ">=3.10"
dependencies = []
license = { file = "LICENSE.txt" }

[project.scripts]
unity-debugger-pure-mcp = "unity_debugger_pure_mcp_launcher.__main__:main"

[tool.uv.build-backend]
module-name = "unity_debugger_pure_mcp_launcher"
module-root = "src"
```

Add Windows and Python classifiers plus repository URLs. Copy the repository MIT license into `launcher/LICENSE.txt` and test that its bytes remain identical to root `LICENSE.txt`.

### Python boundaries

```py
@dataclass(frozen=True)
class LaunchSelection:
    runtime_root: str
    client_root: str
    bridge_executable: str

def discover(
    cwd: str,
    environ: Mapping[str, str],
    *,
    now: datetime | None = None,
    process_alive: Callable[[int], bool] = windows_process_alive,
) -> LaunchSelection: ...

def exec_bridge(selection: LaunchSelection) -> NoReturn:
    os.execv(selection.bridge_executable, [
        selection.bridge_executable,
        "--registry", selection.runtime_root,
        "--client-root", selection.client_root,
    ])
```

Use `ctypes` with `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `GetExitCodeProcess`, `STILL_ACTIVE`, and `CloseHandle` for a non-destructive Windows PID probe. Bound each file before reading, validate exact JSON keys and types independently of TypeScript, use `os.path.realpath/normcase/commonpath`, require a regular bridge file at exactly `<extensionRoot>\dist\mcp-bridge.exe`, and stream SHA-256 in bounded chunks.

`main()` rejects arguments and non-Windows platforms, returns stable exit codes, and emits only one of these sanitized stderr classes: Windows required, no live companion, ambiguous companion, integrity failure, or incompatible protocol. It never prints caught exception text. A successful `os.execv` never returns.

### TDD steps

- [ ] Write RED `unittest` cases for metadata, entry point, runtime-root resolution, record bounds/schema, timestamp/liveness, containment, ambiguity, path equality, regular-file/SHA checks, and exact `os.execv` argv.
- [ ] Cover spaces/non-ASCII, case differences, junction escape, other drive, missing `LOCALAPPDATA`, future timestamps, and error redaction. Plant secret-looking token/path values and assert they never occur in captured stderr.
- [ ] Run:

  ```powershell
  uv run --project launcher --python 3.10 python -m unittest discover -s launcher/tests -v
  ```

  Expected RED: `launcher/pyproject.toml` and package modules are absent.

- [ ] Implement the smallest standard-library launcher; do not add runtime dependencies or an MCP parser.
- [ ] Generate and lock build requirements:

  ```powershell
  uv lock --project launcher
  uv run --project launcher --locked --python 3.10 python -m unittest discover -s launcher/tests -v
  ```

- [ ] Add `.venv/`, Python cache, and launcher build outputs to `.gitignore`; keep all launcher source and lock files visible.
- [ ] Commit:

  ```powershell
  git add .gitignore launcher
  git commit -m "feat: add uvx launcher for external MCP clients"
  ```

## Task 6: Prove real subprocess, reload, and dual-client behavior

**Files:**

- Create: `tests/integration/externalLauncher.integration.test.ts`
- Create: `tests/integration/dualClient.integration.test.ts`
- Modify: `tests/integration/mcpCompanion.integration.test.ts`
- Modify: `vitest.config.ts`

### Test architecture

Use the real `BridgeHost`, real registry-mode bundled server, real MCP stdio transport, and the Python launcher process. Tests may create only ordinary temporary runtime directories and named pipes; they must not clone/copy/open a Unity project or start Unity/Tuanjie.

The external-launcher test must:

1. create a temp workspace with spaces and non-ASCII text;
2. start a real `BridgeHost` with a deterministic fake tool handler;
3. write one schema-v1 record under a temp `%LOCALAPPDATA%`;
4. start the launcher from local source with that workspace as cwd;
5. initialize MCP and assert exactly the same `TOOL_NAMES` set as direct mode;
6. call a read tool and a mutation through the real pipe;
7. close the first Host, assert the interrupted call is not replayed, publish a second descriptor, and prove the next call reconnects; and
8. close VS Code/Host and assert a later call returns structured `BRIDGE_UNAVAILABLE` while MCP stdio remains well-formed.

The dual-client test must start one direct-mode bridge and one registry-mode bridge against the same Host. Drive both into one `SessionCommandQueue`, assert writes do not overlap, disconnect one bridge without terminating the session, and prove a state change invalidates opaque references observed by both clients.

### TDD steps

- [ ] Add the integration tests first and run:

  ```powershell
  npm exec -- vitest run tests/integration/externalLauncher.integration.test.ts tests/integration/dualClient.integration.test.ts
  ```

  Expected RED: launcher/registry subprocess helpers are not yet wired for the scenarios.

- [ ] Use the production CLI/environment boundaries and real subprocesses; do not add a second production code path solely for the integration tests.
- [ ] Preserve and re-run the existing `mcpCompanion.integration.test.ts` direct-provider session unchanged.
- [ ] Ensure every child, socket, timer, temp record, and named pipe is closed in `finally`; assert no `mcp-bridge.exe` child remains after the suite.
- [ ] Run `npm run test:integration`, both TypeScript typechecks, and all extension/server tests.
- [ ] Commit:

  ```powershell
  git add tests/integration vitest.config.ts
  git commit -m "test: cover external and dual MCP clients"
  ```

## Task 7: Build and audit launcher artifacts, VSIX, and CI assets

> The coupled release-workflow instruction in this task is superseded by the
> independent release plan referenced above.

**Files:**

- Create: `scripts/build-launcher.mjs`
- Create: `launcher/scripts/verify_artifacts.py`
- Create: `launcher/tests/test_artifacts.py`
- Create: `tests/package/launcher-package.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.vscodeignore`
- Modify: `tests/package/mcp-vsix.test.mjs`
- Modify: `tests/build/mcp-companion-scaffold.test.mjs`
- Modify: `tests/build/repository-boundary.test.mjs`
- Modify: `tests/build/workflows.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

### Build commands

Add root scripts with these responsibilities:

```json
{
  "test:launcher": "uv run --project launcher --locked --python 3.10 python -m unittest discover -s launcher/tests -v",
  "build:launcher": "node scripts/build-launcher.mjs",
  "verify:launcher": "uv run --project launcher --locked --python 3.10 python launcher/scripts/verify_artifacts.py dist/launcher"
}
```

Update `test` to include `test:launcher`. Update `package` to build the extension/SEA and launcher, package the VSIX, then run both independent verifiers. Keep `package:vsix` separately callable.

`build-launcher.mjs` must:

1. require Windows x64 and `uv 0.12.0`;
2. run `uv build launcher --out-dir dist/launcher --clear`;
3. require exactly one `py3-none-any` wheel and one sdist from the build;
4. run `uvx --from wheel==0.47.0 wheel tags --remove --platform-tag=win_amd64 <wheel>` without a shell; and
5. require the final pair to be exactly `unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl` and `unity_debugger_pure_mcp-0.1.0.tar.gz`.

The independent Python verifier must inspect ZIP/tar members without extraction, reject unsafe/duplicate/case-colliding paths, and enforce:

- wheel `Tag: py3-none-win_amd64`, `Root-Is-Purelib: true`, exact console entry point, Python `>=3.10`, zero dependencies, and strict launcher/metadata/license file allowlist;
- sdist strict source/metadata/license/docs allowlist;
- no `.exe`, `.dll`, `.node`, VSIX, Adapter, Mono, Node bundle, source map, cache, token, pipe name, absolute drive path, username, or build output; and
- wheel `RECORD` hashes validate before the artifact is accepted.

### TDD and audit steps

- [ ] Write RED artifact tests for missing/extra files, traversal, duplicate case, tampered `RECORD`, wrong platform tag, dependency injection, embedded executable, raw path/token strings, and sdist symlink/special entries.
- [ ] Add a subprocess test that installs the local wheel through:

  ```powershell
  uvx --from .\dist\launcher\unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl unity-debugger-pure-mcp
  ```

  against the temporary real registration/Host harness and verifies initialize plus 19 tools.
- [ ] Run launcher tests first and observe RED because build/verifier scripts do not exist.
- [ ] Implement the scripts and root package commands. Add `launcher/**` and `dist/launcher/**` to `.vscodeignore` so neither Python sources nor artifacts enter the VSIX.
- [ ] Update VSIX tests to require the same existing 11-file allowlist, proving registration support is bundled only inside `extension.cjs` and no Python artifact is present.
- [ ] Pin CI to Windows, Node 26.5.0, Python 3.10, and uv 0.12.0 using `astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b # v8.1.0` with `version: "0.12.0"` and `python-version: "3.10"`. CI runs typecheck, all tests, package, launcher verifier, and VSIX verifier.
- [ ] Extend the GitHub release workflow to attach the audited wheel and sdist beside the VSIX and checksum files. Do **not** add a PyPI upload step yet.
- [ ] Rebuild the SEA under exact Node 26.5.0 and require the bytes to match Task 4's reviewed inventory. An unexpected hash change is a blocker requiring root-cause analysis; do not silently refresh the inventory during packaging.
- [ ] Run the full release gate:

  ```powershell
  npm ci
  npm run typecheck
  npm test
  npm run package
  npm run test:package
  npm run verify:launcher
  npm run verify:vsix
  ```

- [ ] Inspect `git diff` to ensure no generated `.exe`, wheel, sdist, VSIX, environment, cache, or secret is staged.
- [ ] Commit:

  ```powershell
  git add package.json package-lock.json .vscodeignore scripts/build-launcher.mjs launcher/scripts/verify_artifacts.py launcher/tests/test_artifacts.py tests/package tests/build .github/workflows
  git commit -m "build: package audited PyPI launcher artifacts"
  ```

## Task 8: Document, publish behind authorization, and configure MyGame

> The publication instructions in this task are superseded by the independent
> `companion-v<version>` and `launcher-v<version>` authorization gates. The
> documentation and post-publication MyGame validation evidence remain useful.

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`
- Modify: `docs/superpowers/specs/2026-07-30-unity-debugger-pure-mcp-companion-design.md`
- Modify: `docs/superpowers/plans/2026-07-30-mcp-external-bridge-release.md`
- Conditionally modify after public release: `D:\Unity\TuanjieHub\Projects\MyGame\.codex\config.toml`

### Documentation changes

Document two distinct launch paths:

```text
VS Code Agent -> native provider -> bridge direct mode
Codex -> pinned uvx launcher -> bridge registry mode
```

Explain prerequisites (Windows x64, VS Code 1.101+, debugger 0.2.0, companion 0.1.0, uv, trusted workspace), initial-start behavior, reload reconnection, sanitized errors, 19-tool parity, and the recommendation that only one Agent issue control mutations at a time. Mark the old global-storage installer design as superseded rather than implementing it.

### Documentation TDD and commit

- [ ] Add build tests that require the README command to use an exact `==0.1.0` pin and reject usernames, absolute extension paths, environment-variable shims, PowerShell, `--pipe`, and `--token`.
- [ ] Update docs and changelog; run `node --test tests/build/*.test.mjs`.
- [ ] Run the full release gate again from committed source inputs.
- [ ] Commit MCP-repository docs:

  ```powershell
  git add README.md CHANGELOG.md SECURITY.md docs tests/build
  git commit -m "docs: explain external uvx MCP setup"
  ```

### Mandatory publication stop

- [ ] **STOP and request explicit user authorization** before any TestPyPI/PyPI upload, Git remote creation, tag, push, release, token use, or Trusted Publisher setup.
- [ ] Confirm `unity-debugger-pure-mcp` is still available on PyPI. If unavailable, stop for a naming decision; do not silently rename.
- [ ] With authorization, publish the exact already-audited wheel and sdist. Prefer PyPI Trusted Publishing once the repository remote exists. If publishing manually, accept only a project-scoped API token supplied through the process environment and never print or persist it.
- [ ] Test the exact public artifact from a clean uv cache:

  ```powershell
  uvx --refresh --from unity-debugger-pure-mcp==0.1.0 unity-debugger-pure-mcp
  ```

  Run it only while the MyGame VS Code window and companion are live, and verify initialize plus all 19 tools.

### Project configuration after public verification

- [ ] Only after the public smoke succeeds, preserve the existing `unityMCP` and `feishu` tables and append to `D:\Unity\TuanjieHub\Projects\MyGame\.codex\config.toml`:

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

- [ ] Do not add an environment table for this server. Confirm the file contains no username, absolute bridge/extension path, token, pipe, PowerShell, or PATH modification.
- [ ] Do not commit the MyGame config unless the user separately and explicitly says to commit.
- [ ] Tell the user to restart the Codex task so project MCP configuration is reloaded. A VS Code restart is unnecessary if the correct VSIX is already active; after installing/upgrading the VSIX, use one VS Code `Reload Window` first.

### Real acceptance

- [ ] Verify existing Unity MCP first with `debug_request_context`; `session_state.active_instance` must identify MyGame. If Unity MCP is unavailable, ask whether the user wants to open the Editor before falling back.
- [ ] Verify VS Code Agent still lists the 19 tools in direct mode.
- [ ] In the restarted Codex task, verify the same 19 `unity_debug_*` tools appear from the pinned public launcher.
- [ ] Use MCP calls—not Computer Use—to list targets, attach, query status, set a breakpoint, wait for stop, take a snapshot, inspect variables, evaluate safely, step/continue, remove the breakpoint, and disconnect.
- [ ] If a GUI-only action is required to execute the selected code path, first try the existing Unity MCP Editor controls. Ask for Computer Use permission only if Unity MCP cannot trigger or inspect that action.
- [ ] Connect both VS Code Agent and Codex to one session, prove serialized control and cross-client stale-reference behavior, reload VS Code and prove a later Codex call reconnects, then close VS Code and verify `BRIDGE_UNAVAILABLE`.
- [ ] Record the active MyGame instance, MCP port when relevant, package/VSIX versions, public wheel hash, test commands, and any acceptance gap. Do not record tokens, pipes, expressions, variable values, or user paths.

## Final Verification Checklist

- [ ] `git diff --check` succeeds and the MCP repository working tree is clean.
- [ ] `npm ci`, both TypeScript checks, Python launcher tests, all Vitest/Node tests, real named-pipe integration, package tests, and both artifact verifiers succeed.
- [ ] SEA was built by exact Node `v26.5.0`, is AMD64, passes direct and registry stdout smoke tests, and matches reviewed inventory.
- [ ] VSIX retains the existing strict 11-file allowlist and contains no Python artifacts.
- [ ] Wheel and sdist contain only audited launcher materials; wheel is `py3-none-win_amd64`; public console entry point is exactly `unity-debugger-pure-mcp`.
- [ ] Direct provider arguments are unchanged; registry arguments contain no token.
- [ ] Initial no-host, ambiguity, stale host, reload, later reconnect, no replay, cancellation, frame/result budget, and multiple-client tests pass.
- [ ] Debugger repository has no diff.
- [ ] MyGame receives only the pinned project config after public verification, and only with separate commit authorization.
- [ ] No PyPI upload, remote mutation, push, tag, or release happened without explicit authorization.
