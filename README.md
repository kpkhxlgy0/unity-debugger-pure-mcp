# Unity Debugger Pure MCP

Unity Debugger Pure MCP is the independent local MCP companion for
[Unity Debugger Pure](https://marketplace.visualstudio.com/items?itemName=kpk.unity-debugger-pure)
`0.2.0` and its public debugger API v1. On Windows, install both VS Code
extensions and keep the VS Code window open: the companion controls only debug
sessions owned by that running extension host.

The companion declares `kpk.unity-debugger-pure` as an extension dependency.
It never imports the debugger repository's internal source and does not bundle
the Unity debugger Adapter or any Mono debugging assembly.

VS Code 1.101 or newer discovers one stdio MCP server through its built-in MCP
server definition provider. The companion provides 19 tools in these groups:

- target and session lifecycle: list, attach, status, and disconnect;
- source breakpoints and exception policy;
- snapshots, threads, stack frames, scopes, and variables;
- safe evaluation and separately authorized explicit evaluation; and
- pause, continue, step in/over/out, and normalized event waiting.

Safe evaluation uses the debugger's non-executing inspection context. Explicit
evaluation can execute target code and is accepted only when
`allowSideEffects` is the literal value `true`.

The companion sends no telemetry and opens no TCP listener. Its bundled
Windows x64 MCP executable connects to the matching VS Code extension host
through a capability-protected, current-user named pipe. Installing or
configuring external MCP clients is deferred to a later release.

## Local validation

Use exact Node.js `26.5.0` for the SEA and release artifact:

```powershell
npm ci
npm run typecheck
npm test
npm run package
```

The final command creates and audits
`dist/unity-debugger-pure-mcp-0.1.0.vsix`. The audit fails if the package
contains source, tests, Git metadata, `node_modules`, an Adapter, or Mono.
