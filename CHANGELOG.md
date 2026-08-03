# Changelog

## 0.1.2

- Accept Windows short-path and junction aliases when configuring Codex or
  Claude Code, while rechecking workspace trust and membership before writes.

## 0.1.1

- Added a dedicated companion icon aligned with Unity Debugger Pure.
- Added repository discovery metadata and release-channel badges.
- Activate the companion after VS Code startup so external `uvx` clients can
  discover the live bridge without first opening the built-in MCP server.
- Added opt-in project commands for configuring Codex and Claude Code without
  overwriting unmanaged or conflicting client entries.
- Accept successful bodyless pause and step responses returned by VS Code as
  `null`, preserving control compatibility with the debugger Adapter.
- Accept compatible Node.js 26.5+ and uv 0.12.x local builds while retaining
  exact reviewed tool versions and SEA inventory for public releases.
- Kept the external `uvx` launcher pinned independently at version 0.1.0.

## 0.1.0

- Added the built-in VS Code MCP companion for Unity Debugger Pure 0.2.0/API v1.
- Added 19 debugger tools over a bundled Windows x64 stdio MCP executable.
- Added capability-protected current-user named-pipe transport and strict
  debugger/runtime package isolation.
- Added a zero-dependency Python launcher for pinned `uvx` use by Codex and
  other external MCP clients.
- Added live Host discovery, reload reconnection, dual-client serialization,
  and independently audited Windows wheel and source-distribution artifacts.
