# Security Policy

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/kpkhxlgy0/unity-debugger-pure-mcp/security/advisories/new).
Do not include project source, expressions, variable values, credentials,
capability tokens, pipe names, or unsanitized debugger output.

The companion requires a trusted workspace, sends no telemetry, and opens no
TCP listener. Its bundled MCP process connects only to the current VS Code
extension host through a current-user named pipe protected by a one-time
capability. Explicit evaluation may execute target code and requires literal
`allowSideEffects: true` authorization.
