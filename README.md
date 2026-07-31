# Unity Debugger Pure MCP

Unity Debugger Pure MCP is the independent local MCP companion for
[Unity Debugger Pure](https://marketplace.visualstudio.com/items?itemName=kpk.unity-debugger-pure)
`0.2.0` and its public debugger API v1. It supports Windows x64, VS Code 1.101
or newer, companion version `0.1.0`, and trusted workspaces. Install both VS
Code extensions and keep the matching VS Code window open: the companion
controls only debug sessions owned by that running extension host.

The companion declares `kpk.unity-debugger-pure` as an extension dependency.
It never imports the debugger repository's internal source and does not bundle
the Unity debugger Adapter or any Mono debugging assembly.

The two client paths deliberately use the same Extension Host:

- VS Code Agent uses the native provider and bridge direct mode.
- Codex uses the pinned `uvx` launcher and bridge registry mode.

Starting a bridge for VS Code Agent does not block Codex. Both clients connect
to the same companion Host and share its session state, reference generations,
breakpoint ownership, and serialized command queue. Prefer only one Agent to
issue control mutations at a time so human intent remains clear.

The companion provides 19 tools in these groups:

- target and session lifecycle: list, attach, status, and disconnect;
- source breakpoints and exception policy;
- snapshots, threads, stack frames, scopes, and variables;
- safe evaluation and separately authorized explicit evaluation; and
- pause, continue, step in/over/out, and normalized event waiting.

Safe evaluation uses the debugger's non-executing inspection context. Explicit
evaluation can execute target code and is accepted only when
`allowSideEffects` is the literal value `true`.

The companion sends no telemetry and opens no TCP listener. Its bundled MCP
executable connects to the matching VS Code extension host through a
capability-protected, current-user named pipe.

## VS Code Agent

Install Unity Debugger Pure `0.2.0` and this companion VSIX, then reload the VS
Code window once. The native MCP provider starts the packaged bridge in direct
mode; no MCP configuration or Python installation is required.

## Codex and other external clients

External clients require [uv](https://docs.astral.sh/uv/) and the published
Windows launcher package. After version `0.1.0` is available from PyPI, add the
following project-scoped Codex configuration:

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

No username, installation directory, environment shim, pipe name, or
capability token belongs in client configuration. The launcher uses the
client's current project directory to select one live, trusted VS Code window.
Start or reload that window before starting the external MCP client. If no
matching Host exists, tools fail closed with `BRIDGE_UNAVAILABLE`; after a VS
Code reload, the next call reconnects through the refreshed registration.

The earlier global-storage installer design is superseded by this versioned
launcher package. The extension does not copy launchers or edit client
configuration.

## Local validation

Use exact Node.js `26.5.0` for the SEA and release artifact:

```console
npm ci
npm run typecheck
npm test
npm run package
npm run test:package
```

The package command creates and audits the companion VSIX, a
`py3-none-win_amd64` launcher wheel, and its source distribution. The VSIX
retains an 11-file allowlist and contains no Python launcher; the launcher
artifacts contain no Adapter, Mono runtime, Node bundle, live capability, or
machine-specific path.
