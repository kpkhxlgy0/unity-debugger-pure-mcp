# Unity Debugger Pure MCP PyPI Launcher — Design Specification

Date: 2026-07-31

## 1. Summary

Add external Codex support to Unity Debugger Pure MCP without installing a
machine-specific executable path, modifying `PATH`, or embedding a username in
project configuration.

The companion will publish a small, public Python package named
`unity-debugger-pure-mcp`. Codex starts that package through `uvx`. The Python
package is only a launcher: it discovers the live companion extension for the
current workspace and starts the `mcp-bridge.exe` already installed by the
companion VSIX. It does not contain the bridge, MCP tool schemas, the debugger
Adapter, or Mono assemblies.

VS Code's built-in Agent continues to use the existing native MCP Server
Definition Provider. External Codex clients use the new launcher. Both paths
connect to the same companion Extension Host, use the same 19 tools, share the
same VS Code debug session, and use the existing per-session command queue.

## 2. Decisions

- Publish exactly one logical PyPI project: `unity-debugger-pure-mcp`.
- Expose exactly one console command with the same name.
- Keep the PyPI distribution pure Python and small; do not upload
  `mcp-bridge.exe` to PyPI.
- Keep `mcp-bridge.exe` in the companion VSIX as the only MCP server runtime.
- Store live VS Code host registrations in a well-known current-user runtime
  directory resolved internally by the launcher and extension.
- Configure Codex per project with `uvx` and a pinned launcher version.
- Do not modify the debugger repository or its public API v1.
- Do not add a user environment variable, user `PATH` entry, PowerShell shim,
  project-local executable, or machine-specific absolute path.
- Require VS Code and the companion extension to be running when Codex first
  initializes the MCP server.

## 3. Current State

The companion already has two runtime layers:

1. the VS Code Extension Host owns debugger state, tool dispatch, opaque
   references, event buffers, per-session command serialization, and a
   capability-protected Windows named-pipe host; and
2. `mcp-bridge.exe` owns MCP stdio framing, the 19 public tool schemas, result
   validation, and the named-pipe client.

For VS Code's built-in Agent, the extension registers a native
`McpServerDefinitionProvider`. VS Code calls the provider and receives the
current pipe name, token, bridge path, and workspace roots dynamically.

Codex cannot call that VS Code provider. Codex reads a static
`.codex/config.toml`, so it needs a stable command that can rediscover the
dynamic connection at process start.

## 4. Goals

- Let Codex use the existing 19 debugger tools through project configuration.
- Make the same committed `.codex/config.toml` work for different Windows user
  names and machines.
- Preserve the existing VS Code built-in Agent path unchanged.
- Preserve one VS Code/DAP/Mono debug session even when VS Code Agent and Codex
  are both connected.
- Fail closed for stale, ambiguous, untrusted, or out-of-workspace hosts.
- Keep stdout exclusively available for MCP JSON-RPC after the bridge starts.
- Support reconnecting on a later tool call after the matching VS Code window
  reloads and publishes a fresh pipe/token.
- Keep launcher publication reproducible, pinned, and independently testable.

## 5. Non-goals

- Debugging while VS Code is closed.
- Starting VS Code, Unity/Tuanjie, the Adapter, or a debug session directly
  from the Python launcher.
- Reimplementing MCP or the 19 tool schemas in Python.
- Bundling `mcp-bridge.exe`, Node.js, the Adapter, or Mono in a wheel.
- Supporting macOS, Linux, remote Extension Hosts, WSL, or VS Code forks in the
  first launcher release.
- Automatically editing global Codex configuration.
- Supporting unpinned launcher versions in committed project configuration.
- Publishing to PyPI without explicit account authorization and a reviewed
  release artifact.

## 6. Considered Approaches

### 6.1 PyPI launcher through `uvx` — selected

Project configuration contains only `uvx`, an exact package version, and the
console command. `uvx` creates or reuses an isolated cached environment. The
launcher discovers and executes the bridge supplied by the installed VSIX.

Advantages:

- portable across Windows user names;
- no `PATH` mutation or custom environment variable;
- exact-version pinning and ordinary Python packaging provenance;
- the public package remains small; and
- the existing bridge and tool implementation remain authoritative.

Costs:

- `uv` and network access are required on first use;
- a PyPI release process must be maintained; and
- VS Code must be live when Codex first starts the launcher.

### 6.2 User-installed launcher on `PATH` — rejected

This produces a clean command but requires an installer to copy an executable
and modify the user `PATH`. It creates machine state that is harder to audit
and uninstall and was rejected by the user.

### 6.3 Project-local shim or absolute executable path — rejected

A shim leaves platform-specific launcher logic in every project. An absolute
path embeds the current user or VSIX version and breaks on another machine or
extension upgrade. Neither is acceptable for committed project configuration.

### 6.4 Codex plugin — deferred

A Codex plugin could bundle a launcher and MCP registration, but it creates a
second product and distribution lifecycle. It is unnecessary for the scoped
goal of enabling this existing companion in trusted local projects.

## 7. Architecture

```text
Codex
  |
  | MCP stdio
  v
uvx --from unity-debugger-pure-mcp==0.1.0
  |
  v
Python launcher
  |  discovers current workspace registration
  |  validates host, bridge path, hash, and protocol
  v
mcp-bridge.exe --registry <runtime-dir> --client-root <canonical-root>
  |
  | authenticated named pipe
  v
Companion Extension Host
  |
  | VS Code DebugSession / public debugger API v1
  v
Unity Debugger Pure Adapter -> Mono -> Unity/Tuanjie Editor
```

The VS Code built-in path remains:

```text
VS Code Agent -> native MCP Provider -> mcp-bridge.exe direct mode
```

Direct and registry modes differ only in how the bridge obtains a live pipe
descriptor. After connection, both use the same protocol and ToolDispatcher.

## 8. Components

### 8.1 LiveHostRegistrationPublisher

The companion extension adds one focused component that publishes a live host
record after the named-pipe host is listening and the workspace is trusted.

The runtime root is resolved internally from the current Windows user's local
application-data directory:

```text
%LOCALAPPDATA%\kpk\unity-debugger-pure-mcp\runtime\v1\
```

Neither Codex configuration nor the Python launcher accepts this path from the
project. Both compute it from the operating-system environment.

Each VS Code window owns one `<instance-id>.json` file with this conceptual
schema:

```json
{
  "schemaVersion": 1,
  "instanceId": "opaque UUID",
  "ownerPid": 1234,
  "updatedAt": "2026-07-31T12:00:00.000Z",
  "workspaceRoots": ["D:\\Unity\\TuanjieHub\\Projects\\MyGame"],
  "bridge": {
    "version": "0.1.0",
    "protocolVersion": 1,
    "extensionRoot": "...\\kpk.unity-debugger-pure-mcp-0.1.0",
    "executable": "...\\kpk.unity-debugger-pure-mcp-0.1.0\\dist\\mcp-bridge.exe",
    "sha256": "lowercase hexadecimal digest"
  },
  "pipe": {
    "name": "\\\\.\\pipe\\unity-debugger-pure-mcp-opaque",
    "token": "base64url capability"
  }
}
```

Rules:

- canonicalize roots with native real-path resolution before publication;
- create the runtime directory beneath the current user's profile and inherit
  its current-user access control;
- write to a same-directory temporary file and atomically rename it;
- refresh `updatedAt` every 15 seconds;
- treat a record as stale after 45 seconds;
- remove the owned record on normal deactivation;
- prune stale records only after verifying their owner PID is absent; and
- publish no record while the workspace is untrusted or has no workspace root.

The publisher never changes the existing direct-mode MCP provider.

### 8.2 Python launcher package

The MCP repository adds:

```text
launcher/
├─ pyproject.toml
├─ README.md
└─ src/
   └─ unity_debugger_pure_mcp_launcher/
      ├─ __init__.py
      └─ __main__.py
```

Package metadata:

```toml
[project]
name = "unity-debugger-pure-mcp"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = []

[project.scripts]
unity-debugger-pure-mcp = "unity_debugger_pure_mcp_launcher.__main__:main"
```

The launcher uses only the Python standard library. It:

1. rejects non-Windows platforms;
2. resolves and canonicalizes its current working directory;
3. reads strictly validated live records from the well-known runtime root;
4. discards stale records, dead owner processes, unsupported schemas, invalid
   hashes, missing bridge files, and records whose roots do not contain the
   current directory;
5. rejects more than one matching live VS Code window as ambiguous;
6. verifies that the bridge is a regular file, its canonical path is exactly
   `<extensionRoot>/dist/mcp-bridge.exe`, and its bytes match the registered
   SHA-256; and
7. replaces itself with the verified bridge in registry mode without invoking
   a shell.

The launcher does not parse or forward MCP messages. It does not log the pipe,
token, workspace path, or bridge installation path. Before bridge execution,
diagnostics go only to stderr and use stable, sanitized messages.

### 8.3 Bridge registry mode

The existing bridge retains direct mode for VS Code:

```text
mcp-bridge.exe --pipe <pipe> --token <token> --workspace <root>...
```

It adds an external mode used only by the Python launcher:

```text
mcp-bridge.exe --registry <runtime-root> --client-root <canonical-root>
```

Registry mode:

- starts the same MCP server and advertises the same 19 tools;
- locates a single live record matching `client-root`;
- reads the token inside the bridge process rather than placing it on the
  process command line;
- connects through the existing named-pipe client and framing protocol;
- revalidates workspace, owner liveness, heartbeat, bridge protocol, and token
  on every new connection;
- keeps the MCP stdio process alive when a connected VS Code window reloads;
- performs at most one registry refresh on the next tool call after a broken
  connection; and
- never automatically replays an in-flight tool request, because a cancelled
  or disconnected state-changing request may already have taken effect.

If reconnect fails, the call returns the existing structured
`BRIDGE_UNAVAILABLE` or `AMBIGUOUS_BRIDGE` error. A later call may retry after a
fresh registration appears.

### 8.4 Project-level Codex configuration

Trusted projects use:

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

The configuration contains no username, machine path, token, pipe name,
extension path, shell expression, or environment variable. The exact version
is pinned. `tool_timeout_sec` exceeds the public 60-second event-wait maximum.

The launcher uses the MCP server process working directory as the requested
project root. The Codex project must be trusted so its `.codex/config.toml` is
loaded.

## 9. Runtime Flows

### 9.1 First connection

1. The user opens the Unity project in VS Code.
2. The debugger 0.2.0 and companion 0.1.0 extensions activate.
3. The companion starts its named-pipe Host and publishes a live registration.
4. Codex starts the pinned launcher through `uvx`.
5. The launcher selects the registration matching Codex's canonical working
   directory and executes the registered bridge in registry mode.
6. The bridge initializes MCP stdio, authenticates to the pipe, and exposes the
   19 tools.

If VS Code has not published a matching registration when Codex initializes
the MCP server, launcher startup fails with a sanitized instruction to open the
project in VS Code and restart the Codex task. The Python package does not
implement a second MCP server merely to wait for VS Code.

### 9.2 VS Code reload

1. Reloading the window closes the old pipe and removes or ages out its record.
2. The running registry-mode bridge keeps MCP stdio alive but marks the Host
   unavailable.
3. The reactivated companion publishes a new instance, pipe, and token.
4. The next tool call refreshes the registry and connects to the single
   matching instance.
5. The call observes the new session state. Old opaque references remain stale
   and are never revived.

### 9.3 Multiple MCP clients

VS Code Agent and Codex each run their own stdio bridge process. Both connect
to the same Extension Host. The Host already assigns a separate connection ID
and client selection state to every connection.

- concurrent reads may share the stopped state;
- state-changing requests share the existing per-session fair command queue;
- one client disconnect does not terminate the debug session or the other
  client;
- a continue, step, reload, or new stop initiated by either client invalidates
  opaque references held by both clients; and
- protocol serialization prevents request races but does not create exclusive
  human ownership. Documentation advises using only one controlling Agent at a
  time for pause, continue, step, evaluation with side effects, and disconnect.

### 9.4 Shutdown

- Closing Codex terminates only its registry-mode bridge and client state.
- Closing the VS Code Agent's bridge does not affect Codex.
- Closing VS Code removes the Host; subsequent Codex calls return
  `BRIDGE_UNAVAILABLE` and never start VS Code or the Adapter.
- Closing the companion never terminates an existing VS Code debug session.

## 10. Security and Privacy

- The runtime registry is local, per Windows user, and contains no network
  endpoint.
- The named pipe remains current-user-only and capability-authenticated.
- Direct mode continues to pass its token only from VS Code to its child
  bridge. Registry mode reads the token from the current-user record and does
  not expose it in process arguments.
- Registration parsing uses exact schemas, bounded string lengths, canonical
  paths, and no user-provided executable or shell command.
- The launcher invokes the bridge with an argument array or process replacement
  API and never uses `shell=True`.
- A project can only select a registration whose canonical workspace root
  contains the launcher's canonical current directory.
- Workspace roots, tokens, pipe names, expressions, variable values, and raw
  DAP handles never enter launcher diagnostics.
- No telemetry, update check, background service, TCP listener, or credential
  storage is added.
- The PyPI package contains no secret, executable payload, or downloaded code.
- PyPI publication uses a reviewed wheel and source distribution, exact
  versioning, 2FA, and preferably Trusted Publishing with short-lived OIDC
  credentials. Long-lived user-scoped tokens are prohibited for CI.

The threat model does not attempt to defend against arbitrary malicious code
already executing as the same Windows user. It does defend against accidental
cross-workspace selection, stale instances, malformed registration files,
command injection, path substitution, and token disclosure in logs or process
arguments.

## 11. Errors

Before the bridge starts, launcher failures are short stderr messages with a
non-zero exit code:

- Windows is required;
- no live matching VS Code companion was found;
- more than one live companion matches the project;
- the registration or bridge failed integrity validation; or
- the launcher protocol is incompatible with the installed companion.

Messages contain the corrective action but not raw paths, pipe names, or
tokens.

After bridge initialization, failures use the existing structured MCP error
model. No new public tool error is added unless implementation proves the
existing `BRIDGE_UNAVAILABLE`, `AMBIGUOUS_BRIDGE`,
`WORKSPACE_NOT_ALLOWED`, or `INCOMPATIBLE_DEBUGGER_API` codes cannot express a
required state.

## 12. Packaging and Publication

The launcher is developed and versioned inside the existing independent MCP
repository. It is not a separate Git repository.

The repository adds commands conceptually equivalent to:

```text
npm run test:launcher
npm run build:launcher
npm run verify:launcher
```

The launcher build produces:

- one `py3-none-win_amd64` wheel; and
- one source distribution.

Both artifacts must contain only launcher source, metadata, license, and
documentation. Package tests reject the bridge executable, VSIX, Adapter,
Mono assemblies, Node bundle, source maps, tokens, registration fixtures with
real paths, and repository build output.

The first public release is `unity-debugger-pure-mcp==0.1.0`. The package name
appeared unclaimed when this design was written, but it is not considered
reserved until PyPI accepts the first release. If the name is unavailable at
publication time, stop and request a naming decision rather than silently
publishing under another name.

Release order:

1. build and test the launcher from the local directory;
2. build and inspect wheel and source distribution;
3. test with `uvx --from <local-wheel>` against the packaged companion VSIX;
4. publish and smoke-test on TestPyPI when practical;
5. publish the reviewed artifacts to PyPI with explicit user authorization;
6. test the exact public version with `uvx`; and
7. only then commit the PyPI form of `.codex/config.toml` to a consuming
   project.

The MCP repository currently has no remote. Trusted Publishing therefore
requires a later remote repository setup. Until that exists, publication may
use a project-scoped API token only with explicit user authorization; the token
must never be written to the repository or logs.

## 13. Compatibility and Versioning

- Launcher protocol schema starts at version 1.
- Bridge registry mode accepts registration schema 1 and named-pipe protocol 1.
- Companion and launcher versions are independently released, but each live
  record declares both bridge version and protocol version.
- An older running registry-mode bridge may reconnect to a newer companion only
  when the declared protocol remains compatible.
- A breaking registry or bridge change increments the protocol/schema version
  and requires a launcher release plus an explicit compatibility branch.
- Project configuration pins the launcher exactly; upgrades are deliberate
  edits followed by validation.

## 14. Testing

### 14.1 Python launcher tests

- package metadata and console entry point;
- Windows-only fail-closed behavior;
- current-user runtime-root resolution;
- native canonicalization, case folding, junctions, and child-root matching;
- strict record parsing and size bounds;
- stale heartbeat and dead owner rejection;
- no match and ambiguous match behavior;
- bridge path containment, filename, regular-file, version, protocol, and
  SHA-256 verification;
- shell-free process replacement; and
- diagnostics never containing token, pipe, or raw path values.

### 14.2 Companion tests

- registration begins only after Host listen succeeds;
- no record for untrusted or rootless workspaces;
- atomic create/refresh and exact 15/45-second timing;
- ownership-safe cleanup and stale-record pruning;
- reload rotates instance, pipe, and token;
- direct Provider behavior remains byte-for-byte compatible; and
- package inventory includes no Python environment or launcher cache.

### 14.3 Bridge tests

- direct and registry CLI schemas cannot be mixed;
- registry mode exposes the same 19 tools and output schemas;
- initial connection, loss, bounded refresh, and later reconnect;
- ambiguous windows fail closed;
- no replay of an interrupted state-changing call;
- request cancellation and 1 MiB frame/result budgets remain enforced; and
- two bridge clients share one SessionCommandQueue without terminating the
  debug session on disconnect.

### 14.4 Packaging and subprocess tests

- build wheel and source distribution in a clean environment;
- inspect their exact allowlists;
- run `uvx --from <local-wheel> unity-debugger-pure-mcp`;
- run with spaces and non-ASCII text in user/project paths;
- start the real packaged SEA bridge with Node absent from `PATH`;
- prove stdout contains only MCP protocol bytes;
- rebuild and audit the companion VSIX and runtime inventory; and
- run the existing full companion, server, integration, SEA, and VSIX gates.

### 14.5 Real acceptance

Using only the existing MyGame Editor and its VS Code window:

1. install the debugger and companion VSIXes;
2. verify VS Code built-in Agent still exposes 19 tools;
3. start Codex from MyGame with the local-wheel configuration;
4. verify Codex exposes the same 19 tools;
5. attach once and inspect the same debug session from both clients;
6. prove serialized control and cross-client stale-reference behavior;
7. reload VS Code and verify a later Codex call reconnects;
8. close VS Code and verify Codex returns `BRIDGE_UNAVAILABLE`; and
9. repeat using the exact published PyPI version before recommending the
   committed project configuration.

Computer Use is not required for MCP protocol operations. A user or Computer
Use is still required only when an acceptance scenario needs a GUI-only Unity
action to make a chosen code path execute.

## 15. Repository Boundaries

All product source, tests, package metadata, release workflow, and design
changes belong to:

```text
D:\Unity\unity-debugger-pure-mcp
```

The debugger repository needs no change because public debugger API v1 already
provides the required discovery and attach boundary.

A consuming project may add only its project-scoped `.codex/config.toml` after
the launcher is published and verified. No launcher source, wheel, executable,
runtime registration, token, or generated cache belongs in the game repository.

## 16. Completion Criteria

The feature is complete when:

- the PyPI distribution contains only one lightweight launcher package;
- `uvx` starts it from an exact version without username-dependent paths,
  environment variables, PowerShell, or `PATH` modification;
- the companion safely publishes and removes live host registrations;
- the launcher selects only the single live VS Code window containing the
  canonical Codex project root;
- registry-mode `mcp-bridge.exe` exposes the same 19 tools as direct mode;
- built-in VS Code and external Codex clients can coexist on one debug session;
- reconnect, ambiguity, cancellation, result budgets, reference invalidation,
  and VS Code-closed behavior pass subprocess tests;
- the debugger repository remains unchanged;
- the companion VSIX and Python artifacts pass independent content and hash
  audits; and
- the exact public PyPI version succeeds in the real MyGame acceptance flow.

## 17. Superseded Design

This specification replaces the external-client installation design in
Section 8.2 of
`2026-07-30-unity-debugger-pure-mcp-companion-design.md` and supersedes the
unexecuted global-storage launcher/configuration portions of
`2026-07-30-mcp-external-bridge-release.md`.

The existing VS Code direct-provider architecture, tool surface, error model,
session semantics, and release security requirements remain authoritative.
