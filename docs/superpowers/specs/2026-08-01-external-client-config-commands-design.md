# External Client Configuration Commands Design

**Date:** 2026-08-01

**Status:** Approved for implementation

## Summary

Unity Debugger Pure MCP 0.1.1 will add two explicit VS Code commands that
configure the current project for external Codex or Claude Code clients. The
extension remains opt-in: installing or activating it never creates or edits a
client configuration file. Each command changes only the selected workspace
root and can reverse only configuration that the user has explicitly placed
under extension management.

The commands configure the public, independently versioned Python launcher:
`unity-debugger-pure-mcp==0.1.0`. They never copy the launcher, discover a user
name, or persist a live bridge pipe name or capability token.

## Goals

- Provide one command for project-scoped Codex configuration and one for
  project-scoped Claude Code configuration.
- Keep both clients unconfigured by default.
- Preserve unrelated client configuration and user formatting.
- Make generated configuration reversible without deleting manually authored
  or subsequently modified entries.
- Work in single-root and multi-root VS Code workspaces.
- Keep the existing launcher, bridge protocol, 12-file VSIX boundary, and
  release-channel split unchanged.
- Ship the feature in companion 0.1.1.

## Non-goals

- Claude Desktop, Cursor, or other MCP clients.
- User-global Codex or Claude configuration.
- Installing `uv`, `uvx`, Codex, or Claude.
- Starting, stopping, or restarting Codex or Claude.
- Editing Git state, staging, committing, or ignoring generated configuration.
- Bypassing Claude Code's project MCP trust prompt.
- Storing a named-pipe descriptor, capability token, or absolute launcher path.

## User-facing commands

The extension contributes exactly these new commands:

- `unityDebuggerPureMcp.configureCodex`, displayed as
  `Unity Debugger Pure MCP: Configure Codex`
- `unityDebuggerPureMcp.configureClaudeCode`, displayed as
  `Unity Debugger Pure MCP: Configure Claude Code`

There is no status-bar item, activation notification, checkbox, or automatic
prompt. A command invocation is the only entry point that may write a client
configuration.

Both commands use the same workspace-selection rules:

1. Require a trusted VS Code workspace and a local `file:` workspace folder.
2. Use the folder directly when the workspace has one root.
3. Present a Quick Pick when it has multiple roots.
4. Refuse without writing when no folder is open or selection is cancelled.

## Generated configurations

Both clients use the server name `unity_debugger_pure`.

### Codex

The target is `<workspace>/.codex/config.toml`. A newly managed entry has the
following canonical block:

```toml
# BEGIN Unity Debugger Pure MCP
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
# END Unity Debugger Pure MCP
```

The editor validates the existing TOML before editing it. It appends a managed
block without reserializing unrelated tables, comments, whitespace, newline
style, or byte-order mark. The paired comments delimit only this extension's
owned block.

### Claude Code

The target is `<workspace>/.mcp.json`. A newly managed entry is:

```json
{
  "mcpServers": {
    "unity_debugger_pure": {
      "command": "uvx",
      "args": [
        "--from",
        "unity-debugger-pure-mcp==0.1.0",
        "unity-debugger-pure-mcp"
      ],
      "env": {}
    }
  }
}
```

The editor performs a property-level JSON edit and preserves unrelated
properties, MCP servers, indentation, newline style, and trailing newline. It
does not add comments or private fields because `.mcp.json` is an official
Claude Code project configuration file.

## Configuration states and actions

Each editor classifies its target before showing an action:

### Absent

The file or entry does not exist. The command offers **Configure** and writes
the canonical entry. Missing `.codex/` is created only for the Codex command.

### Managed current

The owned entry and launcher pin match the current canonical configuration.
The command reports that the client is configured and offers **Remove** and
**Open Configuration**. Removal requires an explicit action selection.

### Managed outdated

The owned entry uses a launcher pin from an explicit set of earlier supported
launcher versions and otherwise has the canonical shape. The command offers
**Update**, **Remove**, and **Open Configuration**.

### Compatible but unmanaged

The entry is semantically equivalent to a recognized generated configuration,
but it has no valid ownership evidence. This covers configuration written
manually before these commands existed.

The command reports that the client is already configured and offers
**Adopt Management** and **Open Configuration**. It never offers removal until
the user explicitly adopts the entry.

- Codex adoption replaces only the equivalent target table with the canonical
  comment-delimited block.
- Claude adoption records an ownership fingerprint in VS Code
  `workspaceState`; it does not change the JSON schema.

### Conflicting or invalid

The same server name exists with different command, arguments, environment, or
unsupported fields; ownership evidence is stale; the file is syntactically
invalid; or the file cannot be handled safely. The command refuses to modify
the file and offers only **Open Configuration** when the path is readable.

## Ownership model

### Codex

Ownership requires all of the following:

- one complete BEGIN/END marker pair;
- exactly one `mcp_servers.unity_debugger_pure` table inside it;
- a recognized canonical launcher shape;
- no duplicate target table elsewhere in the parsed document.

Removing or updating deletes or replaces only the marker-delimited bytes. A
marker mismatch, duplicate table, or semantic change invalidates ownership and
fails closed.

### Claude Code

Strict JSON cannot carry a safe extension-private ownership marker. After the
user configures or adopts the entry, the extension stores in `workspaceState`:

- a hash of the canonical workspace identity rather than a display path;
- the target client kind;
- a fingerprint of the exact managed server object;
- the launcher version known when ownership was recorded.

Removal or update is available only when the current server object still
matches the stored fingerprint and a recognized canonical shape. Reinstalling
the extension, clearing workspace state, moving the project, or manually
editing the entry returns it to the compatible-unmanaged or conflicting state;
the user can adopt it again. Operational enablement remains determined solely
by `.mcp.json`; workspace state records ownership only.

## Components

### ExternalClientCommands

- Registers and disposes both commands.
- Checks platform, workspace trust, and local-folder eligibility.
- Selects a workspace root.
- Maps editor state to confirmation messages and actions.
- Shows completion/restart guidance and an **Open Configuration** action.
- Never parses or writes file formats itself.

### CodexProjectConfigEditor

- Resolves only `.codex/config.toml` beneath the selected canonical root.
- Validates TOML and classifies the target table and ownership markers.
- Produces byte-preserving append, adoption, update, and removal edits.

### ClaudeProjectConfigEditor

- Resolves only `.mcp.json` beneath the selected canonical root.
- Parses the document and performs minimal property-level edits.
- Classifies the target server object and validates workspace-state ownership.

### AtomicWorkspaceFile

- Enforces canonical-root containment and rejects symlink or junction escape.
- Enforces a 256 KiB UTF-8 configuration-file size ceiling.
- Reads UTF-8 files while retaining BOM/newline information.
- Returns a content hash with the snapshot.
- Rechecks the content hash immediately before mutation.
- Writes a same-directory temporary file and atomically replaces the target.
- Cleans temporary files on every failure path.

### ExternalLauncherDescriptor

A single versioned descriptor supplies the server name, launcher package pin,
command, arguments, and client-specific optional fields. Both editors consume
it so the Codex and Claude entries cannot drift. It contains no machine-local
state.

## Safety and failure behavior

- Configuration is opt-in and never runs from activation.
- Writes are limited to the two exact relative paths under the selected root.
- The command does not spawn `codex`, `claude`, a shell, or arbitrary commands.
- No user directory is scanned and no user-global file is touched.
- Same-name conflicts are never overwritten.
- A file changed between read and write returns a retryable conflict and keeps
  the newer file intact.
- Any parse, permission, path, temporary-write, rename, or cleanup failure is
  surfaced without including configuration contents, bridge data, or tokens.
- Successful configuration tells the user that a new Codex or Claude session
  is required. The extension does not restart either client.
- Claude Code remains responsible for approving a project-scoped MCP server.
- The commands never modify `.gitignore` or stage the resulting files.

## Packaging and compatibility

- The feature is included in companion 0.1.1.
- The public launcher stays at 0.1.0 and continues to be invoked through
  `uvx --from unity-debugger-pure-mcp==0.1.0 unity-debugger-pure-mcp`.
- The private MCP server workspace and bridge protocol remain at 0.1.0/v1.
- The companion VSIX remains a strict 12-file archive; new TypeScript is
  bundled into `dist/extension.cjs` and no launcher or source file is added.
- Any syntax-editing library included in the bundle must be pinned exactly,
  covered by the repository's third-party notice and lockfile audit, and must
  not become an unpacked VSIX dependency.

## Test strategy

Automated tests use real temporary directories and real file bytes wherever
possible. They cover:

- creation from absent files and absent parent directories;
- preservation of unrelated TOML sections, JSON properties, MCP servers,
  comments where supported, indentation, BOM, newline style, and trailing
  newline;
- current managed detection, recognized-version update, and exact removal;
- compatible manual configuration and explicit adoption;
- stale Claude ownership fingerprints and changed managed entries;
- duplicate names, malformed syntax, unsupported fields, oversized files, and
  read-only or otherwise unwritable targets;
- no workspace, cancelled multi-root selection, remote roots, and untrusted
  workspaces;
- content changing between read and write;
- symlink and junction escape;
- atomic replacement and temporary-file cleanup on each failure path;
- absence of user names, absolute launcher paths, pipe names, and capability
  tokens in generated files and public errors;
- command registration, disposal, and action mapping;
- unchanged launcher, bridge protocol, and 12-file VSIX allowlist.

The mutation check must prove that a wrong client path, wrong launcher version,
missing ownership check, broad deletion, non-atomic write, or untrusted-root
write makes at least one test fail.

## Real acceptance

Using the audited debugger 0.2.0 and companion 0.1.1 VSIX files in MyGame:

1. Run **Configure Codex** against the existing compatible manual entry and
   adopt it.
2. Run **Configure Claude Code** and create or adopt `.mcp.json`.
3. Start fresh Codex and Claude Code sessions and require all 19 debugger tools
   to be listed through the public launcher.
4. Exercise removal for each client and prove unrelated configuration remains
   byte-for-byte or structurally intact as appropriate.
5. Restore the final configuration state requested for the project.

The acceptance flow does not commit MyGame configuration and does not use
Computer Use unless the user separately requests UI automation.

## References

- Anthropic documents project-scoped Claude Code MCP servers in `.mcp.json`,
  including the `mcpServers` command/args/env shape and the client trust prompt:
  <https://docs.anthropic.com/en/docs/claude-code/mcp>
- Codex project configuration is verified against the live project
  `.codex/config.toml` format and local `codex mcp add --help`; the current CLI
  does not expose a project-scope output option, so the extension edits the
  project file directly.
