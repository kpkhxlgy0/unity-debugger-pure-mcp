# Unity Debugger Pure MCP launcher

This standard-library-only Windows x64 launcher locates the live Unity Debugger
Pure MCP companion for the current project and starts its verified MCP bridge.
It requires Python 3.10 or newer only as provided by `uvx`; it has no runtime
package dependencies.

After version `0.1.0` is published, configure Codex at project scope:

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

Install Unity Debugger Pure `0.2.0` and the companion `0.1.0` VSIX in VS Code
1.101 or newer, trust the workspace, and keep that VS Code window open. The
launcher selects a live registration for its current directory, validates the
bridge path and SHA-256, and forwards MCP stdio without exposing capabilities
in process arguments or configuration.
