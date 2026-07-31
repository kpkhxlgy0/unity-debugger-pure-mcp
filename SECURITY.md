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

External launchers discover short-lived Host registrations for the current
project, reject stale/dead/ambiguous registrations, canonicalize workspace and
bridge paths, verify the bridge SHA-256, and never place pipe capabilities in
client configuration or process arguments. Registration files contain live
capabilities and must not be copied, logged, attached to reports, or shared.

Install the external launcher only through an exactly pinned package version.
The wheel and source distribution are release artifacts separate from the
VSIX; the VSIX never embeds Python files, and the launcher never embeds the
Adapter, Mono runtime, Node executable, or bridge executable.
