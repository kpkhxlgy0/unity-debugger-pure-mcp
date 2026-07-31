# Unity Debugger Pure MCP Companion — Design Specification

Date: 2026-07-30

## 1. Summary

Add MCP access to Unity Debugger Pure as a separate companion VS Code
extension rather than adding MCP responsibilities to the existing debugger
extension.

The existing `kpk.unity-debugger-pure` extension remains the sole owner of
Editor discovery, VS Code debug configuration, the C# Debug Adapter, and the
Mono Soft Debugger connection. A new `kpk.unity-debugger-pure-mcp` extension
depends on it and exposes the active VS Code debug session through a local
stdio MCP server.

Both the VS Code built-in agent and external MCP clients such as Codex or
Claude can use the same tools. VS Code must be running with the companion
extension active. The companion never starts the C# Adapter directly and does
not work as an independent debugger when VS Code is closed.

## 2. Goals

- Publish MCP support as an independently installable and versioned VSIX.
- Keep the current debugger extension useful without the MCP companion.
- Support both VS Code's built-in MCP client and external local stdio MCP
  clients.
- Expose the complete currently supported managed-debugging feature set:
  discovery, attach, breakpoints, exception policy, pause, continue, stepping,
  threads, stack frames, scopes, variables, expression evaluation, Domain
  Reload, termination, and debugger events.
- Share exactly one VS Code/DAP/Mono session. MCP must never establish a second
  connection to an Editor that VS Code is already debugging.
- Preserve the current Windows x64, local Editor, Unity 2022/Tuanjie, and Mono
  managed-debugging support boundary.
- Keep source text, expressions, and variable values out of diagnostic logs.
- Make state-changing and potentially side-effecting MCP calls explicit and
  mechanically enforce their safety policy.

## 3. Non-goals

- Debugging while VS Code is closed.
- Bundling a second copy of `UnityDebuggerPure.exe` in the MCP companion.
- Remote Player, Android/iOS, IL2CPP, WebGL, native C++, or arbitrary remote
  host support.
- Extending the formal Editor support matrix beyond the debugger extension's
  current support policy.
- Multiple simultaneous Editor debug sessions in one VS Code window.
- A Streamable HTTP MCP transport.
- Automatically installing configuration into external MCP clients without an
  explicit user command.
- MCP prompts, MCP Apps, or unrelated AI features in the first release.

## 4. Product and Repository Boundaries

The repository becomes a two-extension monorepo with independently versioned
and published artifacts.

```text
unity-debugger-vscode/
├─ extension/                  # existing debugger VS Code extension
├─ mcp-extension/              # new companion VS Code extension
├─ mcp-server/                 # stdio MCP-to-bridge process
├─ adapter/                    # existing C# DAP-to-Mono process
├─ tests/
│  ├─ extension/
│  ├─ mcp-extension/
│  ├─ mcp-server/
│  ├─ adapter/
│  └─ integration/
└─ docs/
```

The exact directory migration is an implementation-plan concern, but the two
VSIX manifests and release artifacts must remain independent:

| Artifact | Extension ID | Responsibility |
| --- | --- | --- |
| Debugger | `kpk.unity-debugger-pure` | Discovery, DAP, Mono, diagnostics |
| MCP companion | `kpk.unity-debugger-pure-mcp` | MCP, bridge, policy, session projection |

The companion manifest declares:

```json
{
  "extensionDependencies": ["kpk.unity-debugger-pure"]
}
```

Installing the companion therefore installs the debugger dependency. Removing
or disabling the companion has no effect on normal debugging.

## 5. Architecture

```text
VS Code built-in agent ── native provider/direct mode ─┐
External MCP client ── pinned uvx/registry mode ───────┤
                                                       v
                                               mcp-bridge.exe
                                                 | authenticated named pipe
                                                 v
                                  MCP companion extension host
                                      |               |
                                      | public API    | VS Code Debug API
                                      v               v
                              debugger extension   DebugSession + tracker
                                      |               |
                                      └────── DAP ────┘
                                                 |
                                                 v
                                      C# Debug Adapter
                                                 |
                                      Mono Soft Debugger TCP
                                                 |
                                                 v
                                      Unity/Tuanjie Editor
```

There is no standalone DAP-client branch. If no matching debug session exists,
the companion asks the debugger extension to start a visible VS Code attach
session. All subsequent MCP work goes through that `DebugSession`.

If VS Code or the matching window closes, the named pipe disappears. MCP calls
then return `BRIDGE_UNAVAILABLE`; they do not start an Adapter themselves.

## 6. Debugger Extension Public API

The existing extension's `activate()` function returns a narrow, immutable,
versioned API. Version 1 has this conceptual contract:

```ts
interface UnityDebuggerPureApiV1 {
  readonly apiVersion: 1;
  readonly extensionVersion: string;
  readonly debugType: "unity-debugger-pure";

  discoverTargets(
    workspaceRoots: readonly string[],
  ): Promise<readonly PublicEditorTarget[]>;

  startAttach(targetId: string): Promise<StartedDebugSession>;
}
```

`PublicEditorTarget` contains an opaque, single-use `targetId` plus display
metadata: project name, process ID, project version, workspace root, and
discovery source. It never exposes a configurable host or a reusable attach
secret. The extension keeps the loopback address and debugger port internal.

`targetId` is scoped to the canonical workspace roots supplied to discovery,
expires after 60 seconds, and can be consumed only once by `startAttach`.
`startAttach` performs the same support-policy checks as an ordinary VS Code
attach and starts a normal visible debug session. It does not create a hidden
or UI-suppressed session.

The companion obtains the dependency with `vscode.extensions.getExtension`,
activates it, and rejects anything other than `apiVersion === 1` with
`INCOMPATIBLE_DEBUGGER_API`. The manifest dependency guarantees presence but
does not replace this runtime version check.

No MCP types or dependencies enter the debugger extension's public API.

## 7. MCP Companion Components

### 7.1 DependencyAdapter

- Activates and validates `UnityDebuggerPureApiV1`.
- Delegates target discovery and attach startup.
- Converts public API failures into the companion's structured error model.

### 7.2 SessionRegistry

- Tracks only debug sessions whose type is `unity-debugger-pure`.
- Selects a session by opaque MCP session reference, never by a caller-supplied
  Adapter process or network endpoint.
- Records whether a session was already active or was requested through MCP,
  but never auto-terminates either kind when an MCP client disconnects.

### 7.3 DebugSessionBridge

- Uses `DebugSession.customRequest` for DAP inspection and execution-control
  requests.
- Uses VS Code's breakpoint APIs for source breakpoint additions and removals,
  so MCP-created breakpoints remain visible in the UI.
- Uses `DebugAdapterTracker` to observe stopped, continued, breakpoint, output,
  reload, and terminated messages.
- Registers early enough to track sessions from their start. A session that
  predates companion installation and cannot be reconstructed is reported as
  `SESSION_UNTRACKED` with an instruction to restart that debug session.

### 7.4 SessionCommandQueue

- Serializes state-changing commands per debug session across every connected
  MCP client.
- Allows independent read requests only while the session is stopped and no
  state-changing command is pending.
- Rechecks the stop generation immediately before each inspection request.

### 7.5 ReferenceStore

- Converts DAP thread, frame, scope, and variable handles into opaque MCP
  references.
- Binds every reference to a debug-session ID and stop generation.
- Invalidates all inspection references on continue, step, reload, termination,
  or a new stopped event.
- Returns `STALE_REFERENCE` instead of forwarding stale DAP handles.

### 7.6 EventBuffer

- Assigns a monotonically increasing sequence number to each normalized event.
- Keeps the latest 256 normalized events in memory per debug session.
- Implements race-free `wait_for_event(afterSequence, kinds, timeoutMs)`.
- Clears variable-bearing data when a stop generation ends.

### 7.7 LocalBridgeHost

- Creates one Windows named pipe per VS Code window.
- Uses a random pipe name and a 256-bit random capability token.
- Leaves `readableAll` and `writableAll` disabled.
- Requires an authenticated first frame within five seconds and rejects
  oversized, malformed, or out-of-order frames.
- Serializes messages as length-prefixed UTF-8 JSON with a 1 MiB maximum frame
  size.
- Never records tokens, expressions, source text, or variable values in logs.

## 8. MCP Server Process and Client Registration

The companion ships a small `mcp-bridge.exe`. It contains the MCP stdio server,
tool schemas, structured-result validation, and a named-pipe client. It contains
no Editor discovery, DAP Adapter, Mono debugger libraries, or debug backend.

The bridge is authored in TypeScript, bundled as one production file, and built
with the repository's pinned Node.js 26.5.0 single-executable support. The MCP
SDK must be a pinned production-stable release; previews, release candidates,
and floating dependency ranges are prohibited. Because Node single-executable
support is still evolving, executable smoke tests are release gates.

stdout is reserved exclusively for MCP framing. Sanitized diagnostics go to
stderr or the existing product log directory.

### 8.1 VS Code built-in MCP client

The companion contributes `mcpServerDefinitionProviders` and registers a
`McpStdioServerDefinition` that launches the packaged `mcp-bridge.exe`. The
resolved definition passes the current window's pipe descriptor and allowed
workspace roots without user configuration.

### 8.2 External MCP clients

External clients launch an exactly pinned, zero-dependency Python package with
`uvx`. The launcher derives its client root from the current directory, reads
short-lived registrations from the current user's local application data,
and selects exactly one canonical workspace match. It validates owner liveness,
freshness, protocol compatibility, the bridge path, and the bridge SHA-256
before starting registry mode. No username, installed extension path,
environment shim, pipe name, or capability token appears in client settings.

The companion publishes and refreshes registrations but never edits external
client configuration. The old `globalStorageUri` installer/current-pointer
design is superseded and is not implemented. Multiple VS Code windows are
disambiguated by canonical root; an ambiguous match returns
`AMBIGUOUS_BRIDGE` rather than selecting a window.

The registry-mode bridge re-reads registrations after connection loss. It does
not replay an in-flight request; the next request reconnects. Direct and
registry clients share one Extension Host session state and command queue.

## 9. MCP Tool Surface

All tool results provide structured JSON and a short human-readable text
summary. Every structured result includes the selected session, normalized
state, stop generation where relevant, and event sequence where relevant.

### 9.1 Discovery and lifecycle

- `unity_debug_list_targets`
- `unity_debug_attach`
- `unity_debug_status`
- `unity_debug_disconnect`

`attach` accepts only a `targetId` returned by `list_targets`.

`disconnect` defaults to releasing the MCP selection while preserving the VS
Code debug session. Ending the VS Code session requires
`terminateSession: true`, is annotated as destructive, and uses
`vscode.debug.stopDebugging`.

### 9.2 Breakpoints

- `unity_debug_list_breakpoints`
- `unity_debug_add_breakpoint`
- `unity_debug_remove_breakpoint`
- `unity_debug_set_exception_breakpoints`

The companion maintains ownership metadata for MCP-created breakpoints. It
never removes a user-created breakpoint. Deleting an MCP breakpoint in the VS
Code UI updates the MCP registry. Add/remove operations are translated through
the VS Code breakpoint API; the existing Adapter continues to own binding and
Domain Reload recovery.

### 9.3 Inspection

- `unity_debug_threads`
- `unity_debug_stack_trace`
- `unity_debug_scopes`
- `unity_debug_variables`
- `unity_debug_snapshot`

`debug_snapshot` is the agent-oriented aggregate operation. In one call it can
return the stop reason, selected thread, at most 20 stack frames, and at most
100 top-level variables from the selected frame. It expands one variable level
only. Callers use the granular tools to expand opaque references. Individual
variable requests also return at most 100 entries, matching the current Adapter
policy; longer display strings are truncated at 4096 characters and explicitly
marked as truncated.

### 9.4 Evaluation

- `unity_debug_evaluate_safe`
- `unity_debug_evaluate_explicit`

Safe evaluation uses the Adapter's existing `BackendEvaluationMode.Safe` and
does not permit target invocation, method calls, property getters, or implicit
`ToString()` execution.

Explicit evaluation uses `BackendEvaluationMode.Explicit`, requires the literal
input `allowSideEffects: true`, and is always declared as potentially
destructive. The server enforces this check even if the MCP client ignores tool
annotations.

### 9.5 Execution control

- `unity_debug_pause`
- `unity_debug_continue`
- `unity_debug_step`, with `kind` equal to `in`, `over`, or `out`

Control operations require a current session and valid execution state. Step
operations require a stopped generation and invalidate its references before
the request is forwarded.

### 9.6 Events

- `unity_debug_wait_for_event`

The call accepts `afterSequence`, an optional event-kind filter, and a timeout
from 0 through 60 seconds with a 30-second default. Cancellation has no effect
on the debug session. Normalized output-event text is truncated at 64 KiB
before it enters the event ring.

Normalized event kinds are `stopped`, `continued`, `breakpoint`,
`reload-started`, `reload-progress`, `reload-completed`, `output`, and
`terminated`.

## 10. Tool Safety Metadata

Read-only inspection, target listing, status, safe evaluation, and event waiting
set `readOnlyHint: true` and `openWorldHint: false`.

Attach and additive configuration operations set `readOnlyHint: false` and use
accurate idempotence/destructiveness hints. Operations that can resume code,
change control flow, remove state, terminate a session, or execute target code
set `destructiveHint: true`.

Annotations are descriptive hints only. Workspace restrictions, safe evaluation
mode, the explicit-side-effect flag, breakpoint ownership, and state validation
are deterministic server-side controls.

## 11. Session and State Flow

### 11.1 Attach

1. The MCP server connects and authenticates to the matching companion window.
2. `list_targets` asks `UnityDebuggerPureApiV1` to discover only within the
   configured workspace roots.
3. `attach(targetId)` first reuses a matching active debug session.
4. If none exists, the debugger extension consumes the target ID and starts a
   visible VS Code attach session.
5. The companion waits for that session to be registered and returns its opaque
   MCP session reference.

### 11.2 Stop and inspection

1. The tracker observes a DAP `stopped` event.
2. The companion increments the stop generation and records the normalized
   reason and thread.
3. Inspection calls create opaque references bound to that generation.
4. A continued, step, reload, new stopped, or terminated event invalidates
   those references.

### 11.3 Domain Reload

1. Reload output/events move the projected state to `reloading`.
2. Inspection and control calls return retryable `RELOADING` errors.
3. The existing Adapter reconnects and rebinds logical breakpoints.
4. Completion produces a new event sequence and generation; old references
   remain invalid.
5. Reconnect failure becomes `terminated` and requires an explicit new attach.

### 11.4 Client and window shutdown

- An MCP client or `mcp-bridge.exe` exit never terminates the VS Code session.
- Companion deactivation closes its pipe and removes its live descriptor.
- VS Code/window exit makes external tools return `BRIDGE_UNAVAILABLE`.
- Reopening VS Code creates a new pipe and capability token; external bridge
  processes reconnect through the stable live-descriptor registry.

## 12. Error Model

Expected failures return an MCP error result with:

```json
{
  "code": "STALE_REFERENCE",
  "message": "The stack frame belongs to an earlier stop.",
  "retryable": true,
  "currentState": "stopped",
  "action": "Request a new stack trace."
}
```

The stable first-release codes are:

- `BRIDGE_UNAVAILABLE`
- `AMBIGUOUS_BRIDGE`
- `INCOMPATIBLE_DEBUGGER_API`
- `WORKSPACE_NOT_ALLOWED`
- `WORKSPACE_UNTRUSTED`
- `NO_TARGET`
- `AMBIGUOUS_TARGET`
- `TARGET_EXPIRED`
- `ATTACH_FAILED`
- `SESSION_UNTRACKED`
- `NOT_ATTACHED`
- `NOT_STOPPED`
- `STALE_REFERENCE`
- `RELOADING`
- `SIDE_EFFECTS_NOT_ALLOWED`
- `DAP_FAILURE`
- `TIMEOUT`
- `CANCELLED`

Unexpected exception types are written only to sanitized diagnostics and map to
`DAP_FAILURE` or an internal MCP failure without stack traces, source content,
expressions, or variable values.

## 13. Security, Trust, and Privacy

- The companion runs locally on Windows x64 and exposes no listening TCP port.
- Named pipes are current-user-only by default and additionally require a
  random capability token.
- Live bridge descriptors are scoped to canonical workspace roots, refreshed
  every 15 seconds, considered stale after 45 seconds, and pruned on activation
  if their owner process is gone.
- External configurations contain an allowlist of workspace roots. MCP client
  Roots, when supplied, may narrow but never expand that allowlist.
- VS Code Restricted Mode blocks target discovery, attach, evaluation, and
  execution control with `WORKSPACE_UNTRUSTED`.
- No caller can provide an arbitrary executable, Adapter path, host, port, or
  debug transport.
- IPC frames and tool inputs have strict schemas and bounded sizes. Expressions
  are limited to 4096 characters and breakpoint conditions to 1024 characters.
- Variable values, evaluated results, expressions, source content, pipe tokens,
  and raw user paths are excluded from diagnostic logs.
- The product remains telemetry-free.

## 14. Packaging and Versioning

The debugger and companion VSIXes have separate manifests, package tests,
changelogs, and release artifacts. They may release together, but neither
artifact is nested inside the other.

The debugger extension release that first supports the companion exports API
version 1. The companion's first release accepts only API version 1. A future
breaking API requires a new integer API version and an explicit compatibility
branch in the companion; SemVer alone is not used as the protocol contract.

The companion VSIX contains:

- its extension-host bundle;
- `mcp-bridge.exe`;
- MCP/runtime dependency notices;
- no C# Adapter executable or Mono debugger assemblies.

Both VSIX pipelines use path allowlists, committed runtime inventories, license
checks, and SHA-256 verification. The companion's audit fails if an Adapter or
Mono runtime file is accidentally included.

## 15. Testing Strategy

### 15.1 Debugger extension tests

- `activate()` returns the exact version-1 API shape.
- Discovery returns opaque expiring target IDs and no arbitrary host control.
- `startAttach` rejects unknown, expired, cross-workspace, and already-consumed
  target IDs.
- Normal non-MCP attach behavior remains unchanged.

### 15.2 Companion unit tests

- Dependency/API version validation.
- Session selection and untracked-session behavior.
- Per-session command serialization across multiple clients.
- Breakpoint ownership and UI deletion synchronization.
- Stop-generation and stale-reference invalidation.
- Event sequence/ring-buffer behavior, timeout, and cancellation.
- Safe/explicit evaluation policy and tool annotations.
- Workspace allowlist and Restricted Mode enforcement.
- Error normalization and log redaction.

### 15.3 Process and simulated integration tests

- A test MCP client starts the packaged server over stdio and validates tool
  listing, structured results, and stdout purity.
- A fake named-pipe host validates authentication, frame limits, reconnect, and
  malformed-input rejection.
- A simulated VS Code bridge plus the existing test Adapter covers attach,
  breakpoint, exception, stopped, threads, stack, scopes, variables, safe and
  explicit evaluation, pause, continue, every step kind, reload, and
  termination.
- Two MCP clients issue competing control requests and observe deterministic
  serialization.
- Closing the bridge produces `BRIDGE_UNAVAILABLE` and never spawns an Adapter.

### 15.4 Package tests

- The debugger and companion VSIXes satisfy separate path allowlists.
- The companion contains no Adapter or Mono runtime.
- `mcp-bridge.exe` runs with Node absent from `PATH` and from a path containing
  spaces.
- External launcher upgrade selects the new version without corrupting a
  running older process.
- VSIX and external bridge files match their committed inventories and hashes.

### 15.5 Real Editor acceptance

Real acceptance uses only:

- `H:\workspace\Unity\Tuanjie\Projects\MyGame` in the existing Editor; and
- the VS Code window opened from that project.

Before relying on a breakpoint, the selected `MyGame/DevTools` code path must
have concrete reachability evidence. A missed breakpoint without that evidence
is not a debugger failure.

Acceptance covers:

1. installing both VSIXes and seeing the MCP server in VS Code;
2. MCP-started visible attach;
3. source and conditional breakpoints synchronized with the UI;
4. pause, continue, and all step operations;
5. threads, stack, scopes, bounded variables, and snapshot;
6. safe evaluation and explicitly authorized evaluation;
7. exception stops;
8. Domain Reload and breakpoint recovery;
9. concurrent VS Code-internal and external MCP clients sharing one session;
10. external calls returning `BRIDGE_UNAVAILABLE` after the VS Code window
    closes; and
11. ordinary debugger use after the companion is disabled.

Any Computer Use session for this acceptance requires explicit user
confirmation immediately before it starts and is closed immediately after the
specific interaction.

## 16. Delivery Sequence

1. Add and test `UnityDebuggerPureApiV1` without changing existing debug UX.
2. Add the companion extension skeleton and dependency/API validation.
3. Implement the local bridge, state projection, and command queue.
4. Implement the MCP server and full tool surface.
5. Register the VS Code MCP provider.
6. Add the live-registration registry and the pinned `uvx` external launcher.
7. Complete simulated integration, security, and packaging gates.
8. Perform the user-confirmed `MyGame` real-Editor acceptance run.
9. Publish the API-capable debugger version before or with the companion's first
   public version.

The implementation plan may split these into smaller test-driven commits, but
it must preserve this dependency order and may not reintroduce a standalone
Adapter or no-VS-Code debugging path.
