# Unity Debugger Pure MCP Companion Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package `kpk.unity-debugger-pure-mcp`, a separate dependent VS Code extension that exposes one visible Unity Debugger Pure session through a complete, safety-graded local stdio MCP tool surface.

**Architecture:** The companion validates `UnityDebuggerPureApiV1`, tracks DAP traffic with `DebugAdapterTracker`, and serializes all tool calls through a per-session dispatcher. A separate TypeScript MCP process communicates with the extension over an authenticated Windows named pipe; it never discovers Editors or starts the Adapter itself. VS Code's MCP definition provider launches the packaged bridge executable with the current pipe descriptor and workspace allowlist.

**Tech Stack:** TypeScript 7.0.2, VS Code Extension API ^1.101.0, Node.js 26.5.0, `@modelcontextprotocol/sdk` 1.30.0, Zod 4.4.3, Vitest 4.1.10, esbuild 0.28.1, Node single-executable applications, VSCE 3.9.2.

## Global Constraints

- Prerequisite: the public-API plan is complete and `kpk.unity-debugger-pure` 0.2.0 exports `UnityDebuggerPureApiV1` with `apiVersion: 1`.
- The companion manifest ID is exactly `kpk.unity-debugger-pure-mcp`, version 0.1.0, with `extensionDependencies: ["kpk.unity-debugger-pure"]`.
- The companion and MCP server remain under root directories `mcp-extension/` and `mcp-server/`; do not merge MCP code into `extension/` or `adapter/`.
- The companion contains no C# Adapter executable, Mono debugger assembly, arbitrary host/port option, telemetry, or listening TCP port.
- VS Code must be running; no tool may launch `UnityDebuggerPure.exe` directly.
- Named-pipe authentication uses a random 256-bit token, a five-second hello deadline, `readableAll: false`, `writableAll: false`, and a 1 MiB frame ceiling.
- Inspection references are opaque, scoped to one session and stop generation, and invalidated on continue, step, reload, termination, or the next stop.
- Snapshot limits are 20 frames, 100 top-level variables, one expansion level, and 4,096 characters per display value.
- Event buffers retain 256 normalized events; output text is capped at 64 KiB; waits default to 30 seconds and cannot exceed 60 seconds.
- Safe evaluation must use DAP context `hover`; explicit evaluation must require literal `allowSideEffects: true` and use DAP context `repl`.
- Read-only MCP annotations are hints only; all safety rules must also be enforced in code.
- stdout of the MCP process is MCP framing only; diagnostics use stderr or sanitized local logs.
- Do not perform real Editor or Computer Use testing in this plan; that belongs to the external/release plan and requires fresh user confirmation.

---

## File Structure

### Package/build files

- `mcp-extension/package.json` — companion VSIX manifest and scripts.
- `mcp-extension/tsconfig.json` — extension-only TypeScript configuration.
- `mcp-extension/esbuild.mjs` — extension-host bundle.
- `mcp-extension/.vscodeignore` — strict companion package allowlist support.
- `mcp-server/package.json` — pinned MCP/Zod dependencies and server scripts.
- `mcp-server/tsconfig.json` — MCP server TypeScript configuration.
- `mcp-server/esbuild.mjs` — one-file production server bundle.
- `mcp-server/sea-config.json` — pinned Windows x64 SEA output.
- `mcp-extension/runtime-inventory.json` — pinned Node/SEA size and SHA-256 release inventory.

### Companion extension source

- `mcp-extension/src/extension.ts` — composition root only.
- `mcp-extension/src/dependencyAdapter.ts` — validate and call debugger API v1.
- `mcp-extension/src/mcpProvider.ts` — VS Code MCP definition provider.
- `mcp-extension/src/bridge/protocol.ts` — shared frame schemas and tool name union.
- `mcp-extension/src/bridge/framing.ts` — 4-byte length framing.
- `mcp-extension/src/bridge/bridgeHost.ts` — authenticated named-pipe server.
- `mcp-extension/src/debug/sessionRegistry.ts` — Unity Debugger Pure session selection.
- `mcp-extension/src/debug/stateProjector.ts` — DAP event to normalized state/event mapping.
- `mcp-extension/src/debug/commandQueue.ts` — per-session read/write serialization.
- `mcp-extension/src/debug/referenceStore.ts` — opaque generation-bound handles.
- `mcp-extension/src/debug/eventBuffer.ts` — sequenced ring and waiters.
- `mcp-extension/src/debug/dapGateway.ts` — typed `customRequest` façade.
- `mcp-extension/src/debug/breakpointRegistry.ts` — MCP breakpoint ownership/UI sync.
- `mcp-extension/src/tools/errors.ts` — stable structured error model.
- `mcp-extension/src/tools/schemas.ts` — Zod inputs/outputs and limits.
- `mcp-extension/src/tools/toolDispatcher.ts` — complete tool implementation.

### MCP server source

- `mcp-server/src/bridgeClient.ts` — named-pipe handshake/call client.
- `mcp-server/src/toolCatalog.ts` — tool registration, schemas, annotations.
- `mcp-server/src/server.ts` — stdio entry point and stdout discipline.

### Tests

- `tests/mcp-extension/**/*.test.ts` — extension-side units.
- `tests/mcp-server/**/*.test.ts` — MCP SDK/server units.
- `tests/integration/mcpCompanion.integration.test.ts` — simulated end-to-end tool flow.
- `tests/build/mcp-companion-scaffold.test.mjs` — manifests/dependency boundaries.
- `tests/package/mcp-vsix.test.mjs` — companion VSIX audit entry.
- `scripts/verify-mcp-vsix.mjs` — companion package allowlist and PE audit.

## Task 1: Establish workspace packages and companion identity

**Files:**
- Create: `mcp-extension/package.json`
- Create: `mcp-extension/tsconfig.json`
- Create: `mcp-extension/esbuild.mjs`
- Create: `mcp-extension/.vscodeignore`
- Create: `mcp-extension/src/extension.ts`
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/esbuild.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `.vscodeignore`
- Test: `tests/build/mcp-companion-scaffold.test.mjs`

**Interfaces:**
- Consumes: root Node 26.5.0 toolchain and debugger extension ID.
- Produces: npm workspaces `unity-debugger-pure-mcp` and `unity-debugger-pure-mcp-server`, build/test commands, and an independently packageable companion manifest.

- [ ] **Step 1: Write the failing manifest/build contract test**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("MCP companion is a separate dependent Windows extension", () => {
  const manifest = JSON.parse(
    fs.readFileSync("mcp-extension/package.json", "utf8"),
  );
  assert.equal(manifest.publisher, "kpk");
  assert.equal(manifest.name, "unity-debugger-pure-mcp");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.engines.vscode, "^1.101.0");
  assert.deepEqual(manifest.extensionDependencies, [
    "kpk.unity-debugger-pure",
  ]);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.deepEqual(manifest.os, ["win32"]);
  assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [
    {
      id: "unity-debugger-pure-mcp.server",
      label: "Unity Debugger Pure MCP",
    },
  ]);
});

test("debugger VSIX excludes companion workspaces", () => {
  const ignore = fs.readFileSync(".vscodeignore", "utf8");
  assert.match(ignore, /^mcp-extension\/\*\*$/m);
  assert.match(ignore, /^mcp-server\/\*\*$/m);
});
```

- [ ] **Step 2: Run the test and verify missing-manifest failure**

Run: `node --test tests/build/mcp-companion-scaffold.test.mjs`

Expected: FAIL with `ENOENT` for `mcp-extension/package.json`.

- [ ] **Step 3: Add npm workspaces and pinned production dependencies**

Add to root `package.json`:

```json
{
  "workspaces": ["mcp-extension", "mcp-server"],
  "scripts": {
    "build:mcp-extension": "npm run build -w unity-debugger-pure-mcp",
    "build:mcp-server": "npm run build -w unity-debugger-pure-mcp-server",
    "test:mcp-extension": "vitest run tests/mcp-extension",
    "test:mcp-server": "vitest run tests/mcp-server",
    "test:mcp": "npm run test:mcp-extension && npm run test:mcp-server"
  }
}
```

Create `mcp-server/package.json` with exact dependencies:

```json
{
  "name": "unity-debugger-pure-mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "zod": "4.4.3"
  },
  "scripts": {
    "build": "node esbuild.mjs"
  }
}
```

- [ ] **Step 4: Create the companion manifest**

Use exactly this functional core; documentation fields can mirror the existing
repository URLs:

```json
{
  "name": "unity-debugger-pure-mcp",
  "displayName": "Unity Debugger Pure MCP",
  "description": "MCP companion for Unity Debugger Pure debug sessions in VS Code.",
  "publisher": "kpk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "vscode": "^1.101.0" },
  "extensionKind": ["workspace"],
  "os": ["win32"],
  "main": "./dist/extension.cjs",
  "extensionDependencies": ["kpk.unity-debugger-pure"],
  "contributes": {
    "mcpServerDefinitionProviders": [
      {
        "id": "unity-debugger-pure-mcp.server",
        "label": "Unity Debugger Pure MCP"
      }
    ]
  },
  "scripts": {
    "build": "node esbuild.mjs"
  }
}
```

- [ ] **Step 5: Add isolated TypeScript/build configurations**

Both workspace `tsconfig.json` files extend `../tsconfig.json`, override
`include`, and preserve strict/noEmit settings. `mcp-extension/esbuild.mjs`
bundles `src/extension.ts` to `dist/extension.cjs` with `vscode` external;
`mcp-server/esbuild.mjs` bundles `src/server.ts` and all runtime dependencies to
`dist/server.cjs` with no externals.

Initial `mcp-extension/src/extension.ts`:

```ts
import type * as vscode from "vscode";

export function activate(_context: vscode.ExtensionContext): void {}
export function deactivate(): void {}
```

- [ ] **Step 6: Expand root type/test discovery and base VSIX exclusions**

Add `mcp-extension/src/**/*.ts`, `mcp-server/src/**/*.ts`,
`tests/mcp-extension/**/*.ts`, and `tests/mcp-server/**/*.ts` to the root
TypeScript include. Add both test trees to Vitest. Add exact
`mcp-extension/**` and `mcp-server/**` exclusions to the debugger `.vscodeignore`.

- [ ] **Step 7: Install and verify the workspace lockfile**

Run:

```powershell
npm install --package-lock-only
npm ci
npm run test:build
npm run build:mcp-extension
```

Expected: workspace packages resolve from the single root lockfile; build tests
and the empty companion bundle pass.

- [ ] **Step 8: Commit the monorepo scaffold**

```powershell
git add package.json package-lock.json tsconfig.json vitest.config.ts .vscodeignore mcp-extension mcp-server tests/build/mcp-companion-scaffold.test.mjs
git commit -m "build: scaffold MCP companion workspaces"
```

## Task 2: Implement authenticated framed named-pipe transport

**Files:**
- Create: `mcp-extension/src/bridge/protocol.ts`
- Create: `mcp-extension/src/bridge/framing.ts`
- Create: `mcp-extension/src/bridge/bridgeHost.ts`
- Create: `mcp-extension/src/tools/errors.ts`
- Create: `mcp-server/src/bridgeClient.ts`
- Test: `tests/mcp-extension/bridgeProtocol.test.ts`
- Test: `tests/mcp-extension/bridgeHost.test.ts`
- Test: `tests/mcp-server/bridgeClient.test.ts`

**Interfaces:**
- Consumes: Node `net`, `crypto`, and Zod 4.4.3.
- Produces: `BridgeDescriptor`, `BridgeHost.listen`, `BridgeClient.connect`, `BridgeClient.callTool`, `encodeFrame`, and `FrameDecoder.push`.

- [ ] **Step 1: Write failing framing and schema tests**

```ts
it("decodes split and coalesced length-prefixed frames", () => {
  const decoder = new FrameDecoder(1_048_576);
  const first = encodeFrame({ type: "hello", protocolVersion: 1, token: "x" });
  const second = encodeFrame({
    type: "request",
    id: "1",
    method: "callTool",
    params: { name: "unity_debug_status", input: {} },
  });
  expect(decoder.push(first.subarray(0, 3))).toEqual([]);
  expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toHaveLength(2);
});

it("rejects a declared frame larger than 1 MiB", () => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(1_048_577);
  expect(() => new FrameDecoder(1_048_576).push(bytes)).toThrow(
    "Bridge frame exceeds 1048576 bytes.",
  );
});
```

Add a real Windows named-pipe test that verifies a wrong token is disconnected,
a correct 32-byte base64url token receives `helloAck`, and no unauthenticated
request reaches the handler.

- [ ] **Step 2: Run transport tests and verify missing modules**

Run: `npx vitest run tests/mcp-extension/bridgeProtocol.test.ts tests/mcp-extension/bridgeHost.test.ts tests/mcp-server/bridgeClient.test.ts`

Expected: FAIL because bridge modules do not exist.

- [ ] **Step 3: Define the exact shared frame contract**

```ts
export const TOOL_NAMES = [
  "unity_debug_list_targets",
  "unity_debug_attach",
  "unity_debug_status",
  "unity_debug_disconnect",
  "unity_debug_list_breakpoints",
  "unity_debug_add_breakpoint",
  "unity_debug_remove_breakpoint",
  "unity_debug_set_exception_breakpoints",
  "unity_debug_threads",
  "unity_debug_stack_trace",
  "unity_debug_scopes",
  "unity_debug_variables",
  "unity_debug_snapshot",
  "unity_debug_evaluate_safe",
  "unity_debug_evaluate_explicit",
  "unity_debug_pause",
  "unity_debug_continue",
  "unity_debug_step",
  "unity_debug_wait_for_event",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolErrorCode =
  | "BRIDGE_UNAVAILABLE"
  | "AMBIGUOUS_BRIDGE"
  | "INCOMPATIBLE_DEBUGGER_API"
  | "WORKSPACE_NOT_ALLOWED"
  | "WORKSPACE_UNTRUSTED"
  | "NO_TARGET"
  | "AMBIGUOUS_TARGET"
  | "TARGET_EXPIRED"
  | "ATTACH_FAILED"
  | "SESSION_UNTRACKED"
  | "NOT_ATTACHED"
  | "NOT_STOPPED"
  | "STALE_REFERENCE"
  | "RELOADING"
  | "SIDE_EFFECTS_NOT_ALLOWED"
  | "DAP_FAILURE"
  | "TIMEOUT"
  | "CANCELLED";

export interface StructuredToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentState: string;
  readonly action: string;
}

export type ClientFrame =
  | { readonly type: "hello"; readonly protocolVersion: 1; readonly token: string }
  | {
      readonly type: "request";
      readonly id: string;
      readonly method: "callTool";
      readonly params: { readonly name: ToolName; readonly input: unknown };
    };

export type ServerFrame =
  | { readonly type: "helloAck"; readonly protocolVersion: 1 }
  | { readonly type: "response"; readonly id: string; readonly result: unknown }
  | { readonly type: "response"; readonly id: string; readonly error: StructuredToolError };
```

Use Zod discriminated unions to validate every decoded frame before dispatch.
Put the error types in `mcp-extension/src/tools/errors.ts`; import them into
`protocol.ts`. Bundle the same source module into both builds through esbuild,
so `mcp-server` does not copy or redefine the wire contract.

- [ ] **Step 4: Implement 4-byte little-endian framing**

`encodeFrame` serializes one JSON object, rejects payloads above 1 MiB, and
prefixes `Buffer.writeUInt32LE`. `FrameDecoder` retains partial bytes, loops over
coalesced frames, and parses UTF-8 JSON only after the complete declared length
arrives.

- [ ] **Step 5: Implement `BridgeHost` security and lifecycle**

The constructor accepts injected `createServer`, `randomBytes`, clock, and tool
handler for tests. Production descriptor creation is:

```ts
const token = randomBytes(32).toString("base64url");
const pipeName = `\\\\.\\pipe\\unity-debugger-pure-mcp-${randomUUID()}`;
```

Listen with:

```ts
server.listen({
  path: pipeName,
  readableAll: false,
  writableAll: false,
});
```

Each socket gets a five-second hello timer, a fresh decoder, and a connection
ID. After authentication, requests are validated and forwarded; responses keep
the same ID. Closing the host clears timers, destroys sockets, and removes no
files because Windows owns the named-pipe lifetime.

- [ ] **Step 6: Implement persistent `BridgeClient`**

`BridgeClient.connect(descriptor)` connects, sends hello, waits for `helloAck`,
then correlates responses by request ID. `callTool(name, input, signal)` rejects
pending calls on socket close and sends no request before authentication.

- [ ] **Step 7: Run transport tests and type-check both workspaces**

Run:

```powershell
npx vitest run tests/mcp-extension/bridgeProtocol.test.ts tests/mcp-extension/bridgeHost.test.ts tests/mcp-server/bridgeClient.test.ts
npx tsc --noEmit
```

Expected: PASS including wrong-token, hello-timeout, oversize, split-frame,
coalesced-frame, cancellation, and disconnect cases.

- [ ] **Step 8: Commit the IPC protocol**

```powershell
git add mcp-extension/src/bridge mcp-server/src/bridgeClient.ts tests/mcp-extension/bridgeProtocol.test.ts tests/mcp-extension/bridgeHost.test.ts tests/mcp-server/bridgeClient.test.ts
git commit -m "feat: add authenticated MCP bridge transport"
```

## Task 3: Validate the debugger dependency and track VS Code sessions

**Files:**
- Create: `mcp-extension/src/dependencyAdapter.ts`
- Create: `mcp-extension/src/debug/sessionRegistry.ts`
- Create: `mcp-extension/src/debug/stateProjector.ts`
- Test: `tests/mcp-extension/dependencyAdapter.test.ts`
- Test: `tests/mcp-extension/sessionRegistry.test.ts`
- Test: `tests/mcp-extension/stateProjector.test.ts`

**Interfaces:**
- Consumes: `UnityDebuggerPureApiV1` structural contract from the prerequisite plan and VS Code debug lifecycle/tracker APIs.
- Produces: `DependencyAdapter.activate`, `SessionRegistry.register/remove/select`, `StateProjector.acceptAdapterMessage`, and normalized `DebugSessionState`.

- [ ] **Step 1: Write failing dependency validation tests**

```ts
it("accepts only API version 1 from the exact dependency", async () => {
  const extension = {
    activate: vi.fn(async () => ({
      apiVersion: 1,
      extensionVersion: "0.2.0",
      debugType: "unity-debugger-pure",
      discoverTargets: vi.fn(),
      startAttach: vi.fn(),
    })),
  };
  const adapter = new DependencyAdapter(() => extension);
  await expect(adapter.activate()).resolves.toMatchObject({ apiVersion: 1 });
});

it.each([undefined, { apiVersion: 2 }, { apiVersion: 1, debugType: "other" }])(
  "rejects incompatible dependency API %#",
  async (api) => {
    const adapter = new DependencyAdapter(() => ({
      activate: async () => api,
    }));
    await expect(adapter.activate()).rejects.toMatchObject({
      code: "INCOMPATIBLE_DEBUGGER_API",
    });
  },
);
```

- [ ] **Step 2: Write failing session/projector tests**

Cover exact type filtering, opaque MCP session refs, ambiguity, untracked
pre-existing sessions, and these DAP event transitions:

```ts
projector.acceptAdapterMessage({
  type: "event",
  event: "stopped",
  body: { reason: "breakpoint", threadId: 7 },
});
expect(projector.snapshot()).toMatchObject({
  phase: "stopped",
  stopGeneration: 1,
  reason: "breakpoint",
  threadId: 7,
});

projector.acceptAdapterMessage({ type: "event", event: "continued", body: {} });
expect(projector.snapshot()).toMatchObject({ phase: "running" });
```

Also normalize existing Adapter output lines for Domain Reload start/progress/
completion until a dedicated DAP event exists.

- [ ] **Step 3: Run focused tests and verify missing implementations**

Run: `npx vitest run tests/mcp-extension/dependencyAdapter.test.ts tests/mcp-extension/sessionRegistry.test.ts tests/mcp-extension/stateProjector.test.ts`

Expected: FAIL because the three modules do not exist.

- [ ] **Step 4: Implement structural API validation without importing debugger internals**

`DependencyAdapter` retrieves only `kpk.unity-debugger-pure`, calls
`activate()`, validates literal `apiVersion === 1`, exact debug type, string
extension version, and two function members. It exposes `discoverTargets` and
`startAttach` by delegation and converts failures to `StructuredToolError`.

- [ ] **Step 5: Implement session registration and selection**

`SessionRegistry` stores `vscode.DebugSession` only when
`session.type === "unity-debugger-pure"`. It creates random opaque `sessionRef`
values, indexes by VS Code session ID, and returns:

- the explicit live ref when supplied;
- the single live session when no ref is supplied;
- `NOT_ATTACHED` when none exists; or
- `AMBIGUOUS_TARGET` when more than one exists.

Sessions observed before tracker registration carry `tracked: false`; inspection
returns `SESSION_UNTRACKED` until the user restarts that session.

- [ ] **Step 6: Implement normalized state projection**

Use the closed union:

```ts
export type DebugPhase =
  | "starting"
  | "running"
  | "stopped"
  | "reloading"
  | "terminated";

export interface DebugSessionState {
  readonly phase: DebugPhase;
  readonly stopGeneration: number;
  readonly eventSequence: number;
  readonly reason?: string;
  readonly threadId?: number;
}
```

Increment generation on each stopped event and invalidate it on every transition
out of stopped. Preserve no raw variable/source data in the projector.

- [ ] **Step 7: Run the dependency/session tests**

Run: `npx vitest run tests/mcp-extension/dependencyAdapter.test.ts tests/mcp-extension/sessionRegistry.test.ts tests/mcp-extension/stateProjector.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit dependency and session tracking**

```powershell
git add mcp-extension/src/dependencyAdapter.ts mcp-extension/src/debug/sessionRegistry.ts mcp-extension/src/debug/stateProjector.ts tests/mcp-extension/dependencyAdapter.test.ts tests/mcp-extension/sessionRegistry.test.ts tests/mcp-extension/stateProjector.test.ts
git commit -m "feat: track debugger sessions for MCP"
```

## Task 4: Add command serialization, opaque references, and event waiting

**Files:**
- Create: `mcp-extension/src/debug/commandQueue.ts`
- Create: `mcp-extension/src/debug/referenceStore.ts`
- Create: `mcp-extension/src/debug/eventBuffer.ts`
- Test: `tests/mcp-extension/commandQueue.test.ts`
- Test: `tests/mcp-extension/referenceStore.test.ts`
- Test: `tests/mcp-extension/eventBuffer.test.ts`

**Interfaces:**
- Consumes: session ID, stop generation, normalized event kinds.
- Produces: `SessionCommandQueue.read/write`, `ReferenceStore.create/resolve/invalidate`, and `EventBuffer.append/waitFor`.

- [ ] **Step 1: Write failing concurrency/reference/event tests**

```ts
it("never overlaps a write with reads from another MCP client", async () => {
  function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  const queue = new SessionCommandQueue();
  const order: string[] = [];
  const release = deferred<void>();
  const first = queue.write("session-1", async () => {
    order.push("write-start");
    await release.promise;
    order.push("write-end");
  });
  const second = queue.read("session-1", async () => order.push("read"));
  await Promise.resolve();
  expect(order).toEqual(["write-start"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["write-start", "write-end", "read"]);
});

it("rejects a reference after generation invalidation", () => {
  const store = new ReferenceStore(() => "ref-1");
  const ref = store.create("session-1", 3, "frame", 42);
  expect(store.resolve(ref, "session-1", 3, "frame")).toBe(42);
  store.invalidate("session-1");
  expect(() => store.resolve(ref, "session-1", 3, "frame")).toThrowError(
    expect.objectContaining({ code: "STALE_REFERENCE" }),
  );
});
```

Add fake-clock event tests for 256-item eviction, `afterSequence`, kind filters,
30-second default, 60-second maximum, cancellation, and no lost event between
the initial scan and waiter registration.

- [ ] **Step 2: Run the tests and verify missing modules**

Run: `npx vitest run tests/mcp-extension/commandQueue.test.ts tests/mcp-extension/referenceStore.test.ts tests/mcp-extension/eventBuffer.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement per-session reader/writer serialization**

Use one promise tail per session. Reads may share a read batch only when no
writer is pending; writes wait for the active read batch and become an exclusive
tail. Remove an idle session queue so terminated sessions cannot leak memory.

- [ ] **Step 4: Implement random opaque references**

Each record stores `{sessionId, generation, kind, value}` behind a 128-bit
base64url ID. `resolve` checks all three identity fields. `invalidate(sessionId)`
deletes every record for that session. Raw DAP IDs never cross the bridge.

- [ ] **Step 5: Implement the exact event ring**

`append` increments one sequence, truncates output to 65,536 bytes, keeps only
the newest 256 records, and resolves matching waiters. `waitFor` first scans the
ring, then registers a waiter, then scans again before returning control to
close the race. Clamp timeout to `[0, 60_000]`, default `30_000`.

- [ ] **Step 6: Run primitives tests and leak checks**

Run: `npx vitest run tests/mcp-extension/commandQueue.test.ts tests/mcp-extension/referenceStore.test.ts tests/mcp-extension/eventBuffer.test.ts --reporter=verbose`

Expected: PASS with fake timers fully drained and no pending handles.

- [ ] **Step 7: Commit state primitives**

```powershell
git add mcp-extension/src/debug/commandQueue.ts mcp-extension/src/debug/referenceStore.ts mcp-extension/src/debug/eventBuffer.ts tests/mcp-extension/commandQueue.test.ts tests/mcp-extension/referenceStore.test.ts tests/mcp-extension/eventBuffer.test.ts
git commit -m "feat: add MCP debug state primitives"
```

## Task 5: Implement lifecycle, breakpoint ownership, and error contracts

**Files:**
- Modify: `mcp-extension/src/tools/errors.ts`
- Create: `mcp-extension/src/tools/schemas.ts`
- Create: `mcp-extension/src/debug/breakpointRegistry.ts`
- Create: `mcp-extension/src/tools/toolDispatcher.ts`
- Test: `tests/mcp-extension/breakpointRegistry.test.ts`
- Test: `tests/mcp-extension/lifecycleTools.test.ts`

**Interfaces:**
- Consumes: `DependencyAdapter`, `SessionRegistry`, VS Code breakpoint/debug APIs, command queue, and Zod.
- Produces: stable `StructuredToolError`, lifecycle tools, and MCP-owned breakpoint tools.

- [ ] **Step 1: Write failing lifecycle/error tests**

Cover `list_targets`, reuse of one matching session, API-started attach, default
disconnect preserving VS Code, explicit termination, workspace trust, and error
shape:

```ts
await expect(dispatcher.call("unity_debug_status", {})).resolves.toEqual({
  session: null,
  state: "not-attached",
  eventSequence: 0,
});

await expect(
  dispatcher.call("unity_debug_disconnect", {
    sessionRef: "session-1",
    terminateSession: true,
  }),
).resolves.toMatchObject({ terminated: true });
expect(stopDebugging).toHaveBeenCalledWith(vscodeSession);
```

Every expected error must equal:

```ts
{
  code: "WORKSPACE_UNTRUSTED",
  message: "Trust this workspace before controlling the debugger.",
  retryable: false,
  currentState: "not-attached",
  action: "Use Workspace: Manage Workspace Trust, then retry.",
}
```

- [ ] **Step 2: Write failing breakpoint ownership tests**

Create one pre-existing user `SourceBreakpoint`, add one MCP breakpoint, remove
the MCP ref, and assert `removeBreakpoints` receives only the MCP object. Simulate
`onDidChangeBreakpoints` removing it in the UI and assert the opaque ref becomes
`STALE_REFERENCE`/absent without touching user breakpoints.

- [ ] **Step 3: Run focused tests and verify missing modules**

Run: `npx vitest run tests/mcp-extension/lifecycleTools.test.ts tests/mcp-extension/breakpointRegistry.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the stable error factory and schemas**

Use the complete `ToolErrorCode` and `StructuredToolError` wire types created
in Task 2. Add typed factory functions that produce those shapes and never
include raw expressions, source text, or variable values.

All Zod objects use `.strict()`. Workspace roots are never tool inputs;
`targetId`, `sessionRef`, `breakpointRef`, and other refs are bounded strings.
Conditions use `.max(1024)` and positive 1-based lines.

- [ ] **Step 5: Implement lifecycle dispatch**

`ToolDispatcher.call(name, input, clientId)` parses by tool name, checks
`vscode.workspace.isTrusted`, and delegates:

- `list_targets`: current canonical VS Code workspace roots only;
- `attach`: reuse a matching live session or call dependency `startAttach`;
- `status`: normalized state without throwing when no session exists;
- `disconnect`: release the caller's selection; call `stopDebugging` only when
  `terminateSession === true`.

Store selections per authenticated bridge connection/client ID and remove them
on bridge disconnect.

- [ ] **Step 6: Implement breakpoint ownership**

Use `vscode.SourceBreakpoint` with exact URI/line/condition. Return a random
opaque ref mapped to that object. `list_breakpoints` returns user breakpoints as
read-only entries and MCP breakpoints with removable refs. `remove_breakpoint`
requires an owned ref. `set_exception_breakpoints` is serialized and forwards
only `none`, `uncaught`, or `all` to the active session.

- [ ] **Step 7: Run lifecycle/breakpoint tests**

Run: `npx vitest run tests/mcp-extension/lifecycleTools.test.ts tests/mcp-extension/breakpointRegistry.test.ts`

Expected: PASS, including user-breakpoint preservation and trust rejection.

- [ ] **Step 8: Commit lifecycle and breakpoints**

```powershell
git add mcp-extension/src/tools mcp-extension/src/debug/breakpointRegistry.ts tests/mcp-extension/lifecycleTools.test.ts tests/mcp-extension/breakpointRegistry.test.ts
git commit -m "feat: add MCP lifecycle and breakpoint tools"
```

## Task 6: Implement DAP inspection, evaluation, control, snapshot, and events

**Files:**
- Create: `mcp-extension/src/debug/dapGateway.ts`
- Modify: `mcp-extension/src/tools/schemas.ts`
- Modify: `mcp-extension/src/tools/toolDispatcher.ts`
- Test: `tests/mcp-extension/dapGateway.test.ts`
- Test: `tests/mcp-extension/inspectionTools.test.ts`
- Test: `tests/mcp-extension/controlTools.test.ts`
- Test: `tests/mcp-extension/eventTools.test.ts`

**Interfaces:**
- Consumes: DAP `customRequest`, state projector, queue, references, and event buffer.
- Produces: every inspection, evaluation, execution-control, snapshot, and wait tool from the design.

- [ ] **Step 1: Write failing typed DAP gateway tests**

Assert exact request names/bodies:

```ts
await gateway.stackTrace(session, 7, 0, 20);
expect(session.customRequest).toHaveBeenCalledWith("stackTrace", {
  threadId: 7,
  startFrame: 0,
  levels: 20,
});

await gateway.evaluateSafe(session, 42, "health");
expect(session.customRequest).toHaveBeenCalledWith("evaluate", {
  frameId: 42,
  expression: "health",
  context: "hover",
});

await gateway.evaluateExplicit(session, 42, "ApplyDamage()");
expect(session.customRequest).toHaveBeenCalledWith("evaluate", {
  frameId: 42,
  expression: "ApplyDamage()",
  context: "repl",
});
```

Cover threads, scopes, variables, pause, continue, stepIn, next, stepOut, and
malformed DAP response mapping to `DAP_FAILURE`.

- [ ] **Step 2: Write failing tool-policy tests**

Required cases:

- every inspection call rejects `running`, `reloading`, and stale generation;
- `evaluate_safe` accepts up to 4,096 characters and never chooses `repl`;
- `evaluate_explicit` rejects absent/false `allowSideEffects` with
  `SIDE_EFFECTS_NOT_ALLOWED`;
- each control call invalidates references before forwarding;
- snapshot returns no more than 20 frames/100 variables/one child level;
- values longer than 4,096 characters include `truncated: true`;
- wait returns the first matching sequence after `afterSequence`.

- [ ] **Step 3: Run the tests and verify missing DAP gateway/handlers**

Run: `npx vitest run tests/mcp-extension/dapGateway.test.ts tests/mcp-extension/inspectionTools.test.ts tests/mcp-extension/controlTools.test.ts tests/mcp-extension/eventTools.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the typed DAP gateway**

Define minimal local response interfaces rather than importing a new DAP
runtime package. Validate required arrays/IDs/strings before returning them.
Catch `customRequest` rejection and return one sanitized `DAP_FAILURE`; never
include raw expression or variable content in the error.

- [ ] **Step 5: Implement inspection and opaque reference translation**

For each tool, resolve the selected session and current stopped generation,
execute through `queue.read`, translate DAP IDs into `ReferenceStore` IDs, and
return structured results. `stack_trace` takes a DAP thread ID from the current
thread result but returns opaque frame refs. `scopes` accepts only frame refs;
`variables` accepts only variable refs.

- [ ] **Step 6: Implement bounded snapshot**

`snapshot` performs `threads -> stackTrace(20) -> scopes(first frame) ->
variables(first non-expensive scope, 100)` under one queued read and rechecks
generation between awaits. The returned variables are the single allowed
expansion level; nested values receive opaque child refs but are not recursively
expanded.

- [ ] **Step 7: Implement safe/explicit evaluation**

Both tools resolve an opaque frame ref. Safe always calls context `hover`.
Explicit schema requires:

```ts
z.object({
  sessionRef: z.string().optional(),
  frameRef: z.string(),
  expression: z.string().min(1).max(4096),
  allowSideEffects: z.literal(true),
}).strict()
```

- [ ] **Step 8: Implement control and event waits**

`pause` requires running. `continue` and `step` require stopped. Before continue/
step, mark the state transitioning and invalidate all references so another MCP
client cannot inspect stale state during the DAP round trip. `wait_for_event`
delegates to the event ring and never acquires the write queue.

- [ ] **Step 9: Run all extension-side MCP tests**

Run: `npm run test:mcp-extension`

Expected: PASS for every tool, limit, state, and error case.

- [ ] **Step 10: Commit the complete debugger tool dispatcher**

```powershell
git add mcp-extension/src/debug/dapGateway.ts mcp-extension/src/tools mcp-extension/src/debug tests/mcp-extension
git commit -m "feat: expose complete MCP debug controls"
```

## Task 7: Register MCP tools in the stdio server

**Files:**
- Create: `mcp-server/src/toolCatalog.ts`
- Create: `mcp-server/src/server.ts`
- Test: `tests/mcp-server/toolCatalog.test.ts`
- Test: `tests/mcp-server/stdioServer.test.ts`

**Interfaces:**
- Consumes: `BridgeClient.callTool`, shared `TOOL_NAMES`, Zod schemas, MCP SDK `McpServer`, and `StdioServerTransport`.
- Produces: `createUnityDebuggerMcpServer` and production stdio main.

- [ ] **Step 1: Write failing catalog and annotation tests**

Use the MCP SDK client with an in-memory transport to list tools. Assert all 19
names appear exactly once and key annotations are truthful:

```ts
expect(byName.get("unity_debug_status")?.annotations).toMatchObject({
  readOnlyHint: true,
  openWorldHint: false,
});
expect(byName.get("unity_debug_continue")?.annotations).toMatchObject({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});
expect(byName.get("unity_debug_evaluate_explicit")?.annotations).toMatchObject({
  readOnlyHint: false,
  destructiveHint: true,
});
```

Call one read tool and one failing tool and assert the bridge structured result
is returned as both `structuredContent` and a compact text summary, with
`isError: true` only for expected tool failures.

- [ ] **Step 2: Write the stdout-purity process test**

Spawn the bundled JS entry with a fake bridge descriptor, perform MCP
initialize/list-tools through stdin, and assert every stdout byte parses as MCP
framing while startup diagnostics appear only on stderr.

- [ ] **Step 3: Run server tests and verify missing catalog/main**

Run: `npm run test:mcp-server`

Expected: FAIL.

- [ ] **Step 4: Register every tool with exact schemas and annotations**

Build one descriptor table:

```ts
interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
}
```

Register each definition with `McpServer.registerTool`. The handler parses input,
calls the pipe once, validates output, and returns no unvalidated bridge value.

- [ ] **Step 5: Implement stdio startup without console output**

```ts
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const bridge = await BridgeClient.connect(options);
  const server = createUnityDebuggerMcpServer(bridge);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Unity Debugger Pure MCP failed: ${sanitize(error)}\n`,
  );
  process.exitCode = 1;
});
```

Do not call `console.log` anywhere in `mcp-server/`.

- [ ] **Step 6: Run server tests and production bundle**

Run:

```powershell
npm run test:mcp-server
npm run build:mcp-server
node mcp-server/dist/server.cjs --help 1>$null
```

Expected: tests PASS; bundle is one CJS file; help/diagnostics write no MCP-
invalid stdout during normal server operation.

- [ ] **Step 7: Commit the MCP server**

```powershell
git add mcp-server/src tests/mcp-server mcp-server/esbuild.mjs
git commit -m "feat: serve Unity debugger tools over MCP"
```

## Task 8: Compose the extension and register the VS Code MCP provider

**Files:**
- Create: `mcp-extension/src/mcpProvider.ts`
- Modify: `mcp-extension/src/extension.ts`
- Modify: `mcp-extension/esbuild.mjs`
- Test: `tests/mcp-extension/mcpProvider.test.ts`
- Test: `tests/mcp-extension/extension.test.ts`

**Interfaces:**
- Consumes: every companion component, packaged MCP server command, and VS Code `registerMcpServerDefinitionProvider`.
- Produces: a live bridge and one `McpStdioServerDefinition` per VS Code window.

- [ ] **Step 1: Write failing provider tests**

```ts
it("publishes one stdio server with the live pipe descriptor", async () => {
  const provider = createMcpProvider({
    executable: "H:\\extension\\dist\\mcp-bridge.exe",
    descriptor: {
      pipeName: "\\\\.\\pipe\\fixture",
      token: "token",
      workspaceRoots: ["H:\\MyGame"],
    },
    version: "0.1.0",
  });
  const [definition] = await provider.provideMcpServerDefinitions();
  expect(definition).toMatchObject({
    label: "Unity Debugger Pure MCP",
    command: "H:\\extension\\dist\\mcp-bridge.exe",
    version: "0.1.0",
  });
  expect(definition.args).toEqual([
    "--pipe", "\\\\.\\pipe\\fixture",
    "--token", "token",
    "--workspace", "H:\\MyGame",
  ]);
});
```

Also assert `resolveMcpServerDefinition` rejects when the debugger API is
incompatible, the workspace is untrusted, or the bridge executable is missing.

- [ ] **Step 2: Run provider/activation tests and verify missing composition**

Run: `npx vitest run tests/mcp-extension/mcpProvider.test.ts tests/mcp-extension/extension.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the definition provider**

Use the VS Code 1.101 positional constructor supported by the declared types:

```ts
new vscode.McpStdioServerDefinition(
  "Unity Debugger Pure MCP",
  executable,
  descriptorArgs,
  {},
  version,
);
```

Register with the exact contributed ID
`unity-debugger-pure-mcp.server`. Never prompt from
`provideMcpServerDefinitions`; validation that may show UI belongs in resolve.

- [ ] **Step 4: Compose activation in dependency order**

`activate` must:

1. validate Windows x64 and workspace trust capability;
2. activate debugger API v1;
3. construct session/state/queue/reference/event/breakpoint services;
4. register `onDidStartDebugSession`, `onDidTerminateDebugSession`,
   `onDidChangeBreakpoints`, and the debug adapter tracker factory;
5. start the named-pipe host;
6. register the MCP provider; and
7. push every disposable into `context.subscriptions`.

If any step fails, dispose already-created resources in reverse order and leave
no pipe or listener behind.

- [ ] **Step 5: Run activation/provider tests and companion build**

Run:

```powershell
npx vitest run tests/mcp-extension/mcpProvider.test.ts tests/mcp-extension/extension.test.ts
npm run build:mcp-extension
```

Expected: PASS; `mcp-extension/dist/extension.cjs` contains no `UnityDebuggerPure.exe` string or Mono assembly path.

- [ ] **Step 6: Commit extension composition**

```powershell
git add mcp-extension/src/mcpProvider.ts mcp-extension/src/extension.ts mcp-extension/esbuild.mjs tests/mcp-extension/mcpProvider.test.ts tests/mcp-extension/extension.test.ts
git commit -m "feat: register debugger MCP companion"
```

## Task 9: Build the bridge executable and audit the companion VSIX

**Files:**
- Create: `mcp-server/sea-config.json`
- Create: `scripts/build-mcp-bridge.mjs`
- Create: `scripts/verify-mcp-vsix.mjs`
- Create: `tests/package/mcp-vsix.test.mjs`
- Create: `mcp-extension/README.md`
- Create: `mcp-extension/CHANGELOG.md`
- Create: `mcp-extension/SECURITY.md`
- Create: `mcp-extension/THIRD_PARTY_NOTICES.md`
- Create: `mcp-extension/runtime-inventory.json`
- Modify: `mcp-extension/package.json`
- Modify: `package.json`
- Test: `tests/integration/mcpCompanion.integration.test.ts`

**Interfaces:**
- Consumes: bundled MCP server and complete companion extension.
- Produces: `mcp-extension/dist/mcp-bridge.exe`, audited companion VSIX, and simulated full-session proof.

- [ ] **Step 1: Write failing SEA and package audit tests**

The build test must require:

- AMD64 PE headers for `mcp-bridge.exe`;
- no dependency on `node` from `PATH`;
- no Adapter/Mono file anywhere in the companion VSIX;
- required files `dist/extension.cjs`, `dist/mcp-bridge.exe`, license/readme/
  notices, and manifest; and
- exact extension dependency on `kpk.unity-debugger-pure`.

```js
assert.equal(
  [...files.keys()].some((name) =>
    /UnityDebuggerPure\.exe|Mono\.Debugging|Mono\.Debugger/i.test(name),
  ),
  false,
);
```

- [ ] **Step 2: Write the failing simulated end-to-end MCP test**

Use an in-process fake VS Code session implementing `customRequest` with the
same normal/reload/exception scenarios as `UnityDebugger.TestAdapter`. Start a
real named pipe and MCP server process, then execute:

1. list targets;
2. attach;
3. add conditional breakpoint;
4. wait for stopped;
5. snapshot/threads/stack/scopes/variables;
6. safe evaluation;
7. explicit evaluation rejected then accepted with literal authorization;
8. step in/over/out and continue;
9. reload event/retry/stale reference;
10. exception policy and stop; and
11. disconnect without terminating VS Code.

- [ ] **Step 3: Run the package/integration tests and verify missing executable**

Run: `npx vitest run tests/integration/mcpCompanion.integration.test.ts && node --test tests/package/mcp-vsix.test.mjs`

Expected: FAIL because SEA/package scripts do not exist.

- [ ] **Step 4: Build the SEA with pinned Node 26.5.0**

`mcp-server/sea-config.json`:

```json
{
  "main": "mcp-server/dist/server.cjs",
  "mainFormat": "commonjs",
  "output": "mcp-extension/dist/mcp-bridge.exe",
  "useSnapshot": false,
  "useCodeCache": false
}
```

`build-mcp-bridge.mjs` verifies `process.version === "v26.5.0"`, builds the
server bundle, runs `process.execPath --build-sea mcp-server/sea-config.json`,
then starts the resulting executable against a fake pipe to complete MCP
initialize/list-tools. Fail if Node is not exact or the smoke test writes
non-protocol stdout.

- [ ] **Step 5: Add strict companion package verification**

Allow only the manifest, documentation/notices, `dist/extension.cjs`, and
`dist/mcp-bridge.exe` plus VSIX metadata. Verify safe ZIP paths, case-insensitive
duplicates, PE AMD64, the exact Node version and SHA-256 recorded in committed
`mcp-extension/runtime-inventory.json`, and forbidden Adapter/Mono/debugger-
vendor names.

- [ ] **Step 6: Add concise companion documentation**

Document:

- dependency on Unity Debugger Pure 0.2.0/API v1;
- VS Code must remain open;
- full tool groups and safe/explicit evaluation distinction;
- no telemetry, no TCP listener, current-user named pipe;
- built-in VS Code MCP registration; and
- external client installation is deferred to the next plan.

- [ ] **Step 7: Build and package both VSIXes**

Add scripts:

```json
{
  "build:mcp-bridge": "node scripts/build-mcp-bridge.mjs",
  "verify:mcp-vsix": "node scripts/verify-mcp-vsix.mjs dist/unity-debugger-pure-mcp-0.1.0.vsix",
  "package:mcp": "npm run build:mcp-extension && npm run build:mcp-bridge && npm run package:vsix -w unity-debugger-pure-mcp && npm run verify:mcp-vsix"
}
```

Add this workspace-local script to `mcp-extension/package.json`:

```json
{
  "package:vsix": "vsce package --no-dependencies --out ../dist/unity-debugger-pure-mcp-0.1.0.vsix"
}
```

Run:

```powershell
npm run test:mcp
npx vitest run tests/integration/mcpCompanion.integration.test.ts
npm run package:mcp
npm run package
```

Expected: both packages pass independent audits; only the debugger VSIX contains
the Adapter.

- [ ] **Step 8: Commit the companion core release artifact**

```powershell
git add mcp-server/sea-config.json scripts/build-mcp-bridge.mjs scripts/verify-mcp-vsix.mjs tests/package/mcp-vsix.test.mjs tests/integration/mcpCompanion.integration.test.ts mcp-extension package.json package-lock.json
git commit -m "build: package MCP companion extension"
```

## Completion Gate

Before starting the external-client/release plan, verify:

- The debugger extension still packages and operates without the companion.
- The companion depends on debugger API v1 and contains no Adapter/Mono runtime.
- VS Code can discover one stdio MCP server from the companion provider.
- All 19 tools have strict schemas, structured outputs, and truthful annotations.
- Safe evaluation cannot request explicit backend mode.
- Multiple bridge clients share one command queue and cannot overlap state writes.
- Reference invalidation, reload, event waiting, and output/size ceilings are tested.
- Wrong tokens, malformed frames, untrusted workspaces, and stdout contamination fail closed.
- The simulated full MCP session and both VSIX audit suites pass.
- No real Editor or Computer Use interaction has occurred.
