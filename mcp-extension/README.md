# Unity Debugger Pure MCP

Unity Debugger Pure MCP is the local MCP companion for Unity Debugger Pure
`0.2.0` and its public debugger API v1. Install both extensions and keep the
VS Code window open: the companion controls only debug sessions owned by that
running VS Code extension host.

VS Code discovers one stdio MCP server through its built-in MCP server
definition provider. The companion provides 19 tools in these groups:

- target and session lifecycle: list, attach, status, and disconnect;
- source breakpoints and exception policy;
- snapshots, threads, stack frames, scopes, and variables;
- safe evaluation and separately authorized explicit evaluation; and
- pause, continue, step in/over/out, and normalized event waiting.

Safe evaluation uses the debugger's non-executing inspection context. Explicit
evaluation can execute target code and is accepted only when
`allowSideEffects` is the literal value `true`.

The companion sends no telemetry and opens no TCP listener. It uses a
capability-protected, current-user Windows named pipe between the bundled MCP
process and VS Code. Installing or configuring external MCP clients is deferred
to the next release plan.
