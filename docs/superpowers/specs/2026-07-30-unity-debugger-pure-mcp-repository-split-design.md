# Unity Debugger Pure MCP Repository Split — Design Specification

## 1. Summary

Extract the Unity Debugger Pure MCP companion from
`D:\Unity\unity-debugger-vscode` into the independent local Git repository
`D:\Unity\unity-debugger-pure-mcp`.

The new repository preserves the companion's relevant source, test, build,
audit, and design history. It remains a separately installable VS Code
extension that depends on the public API v1 exported by
`kpk.unity-debugger-pure`. The debugger repository retains that public API and
ordinary debugging functionality, but no longer contains the companion's
implementation or release pipeline.

This migration uses ordinary Git branches and local clones only. It does not
use Git worktrees, create a GitHub repository, configure a remote for the new
repository, publish a release, or install either extension.

## 2. Goals

- Produce a self-contained local repository for `kpk.unity-debugger-pure-mcp`.
- Preserve relevant commit authors, timestamps, messages, and ordering while
  accepting rewritten commit IDs.
- Keep the companion's runtime dependency limited to the debugger's public API
  v1 and VS Code APIs.
- Give the new repository independent typecheck, test, SEA build, VSIX package,
  and artifact-audit commands.
- Remove companion-specific source, tests, build configuration, and documents
  from the debugger repository only after the independent repository passes
  its complete verification suite.
- Leave both repositories on explicit Git branches with clean tracked states
  and reviewable commits.

## 3. Non-goals

- Changing MCP tool semantics, bridge protocol behavior, debugger behavior, or
  the public debugger API contract.
- Bundling the debugger Adapter, Mono runtime, or debugger implementation in
  the companion VSIX.
- Creating or pushing `kpkhxlgy0/unity-debugger-pure-mcp` on GitHub.
- Publishing to GitHub Releases, Visual Studio Marketplace, or Open VSX.
- Running Unity/Tuanjie, opening another VS Code profile, or performing real
  Editor acceptance for a source-and-build-boundary migration.
- Preserving original commit SHA values, which is impossible after filtering
  paths from commits.

## 4. Chosen Migration Strategy

Create a local clone from the fixed source commit at the tip of
`feature/unity-debugger-pure-mcp`, then filter its history through an explicit
allowlist of companion-owned paths. Prune commits that become empty. Preserve
the metadata and parent ordering of the remaining commits, then add one
standalone-repository normalization commit.

This is preferred to manually replaying patches because the filter treats
source, tests, and build assets consistently and reduces the risk of omitting
cross-directory changes. A final-snapshot-only migration is rejected because
it would discard the requested history.

The history filter runs only inside the new local clone. It never rewrites the
source repository. The target clone has no configured `origin`, preventing an
accidental push to the debugger repository.

## 5. Repository Boundaries

### 5.1 Independent companion repository

The new repository uses its root as the published VS Code extension package:

```text
unity-debugger-pure-mcp/
├─ src/                     # VS Code extension, bridge host, tools, debug state
├─ server/                  # private MCP stdio server workspace and SEA entry
├─ tests/                   # extension, server, integration, package, build
├─ scripts/                 # SEA build, smoke test, VSIX and release audits
├─ docs/                    # companion design and implementation records
├─ .github/workflows/       # independent validation and release-ready config
├─ package.json             # kpk.unity-debugger-pure-mcp extension manifest
├─ package-lock.json
├─ tsconfig.json
├─ vitest.config.ts
└─ runtime-inventory.json   # reviewed Node version and SEA SHA-256
```

The former `mcp-extension/` contents move to the repository root. The former
`mcp-server/` contents move to `server/`. Git records these changes in the
normalization commit so file history remains discoverable across renames.

The root extension manifest keeps:

- extension ID `kpk.unity-debugger-pure-mcp`;
- version `0.1.0`;
- VS Code engine `^1.101.0`;
- Windows workspace-extension restrictions;
- extension dependency `kpk.unity-debugger-pure`;
- MCP provider ID `unity-debugger-pure-mcp.server`.

Repository, bugs, homepage, and security-reporting links point to the expected
future repository `kpkhxlgy0/unity-debugger-pure-mcp`, but the migration does
not create that remote.

### 5.2 Debugger repository

The debugger repository retains the complete API v1 implementation and its
tests, including target discovery, single-use attach capability handling,
trusted-workspace checks, attach-session correlation, exported public types,
and API activation.

It removes:

- the companion and MCP server workspaces;
- companion-only unit, integration, build, package, and smoke tests;
- companion-only SEA and VSIX build/audit scripts;
- npm workspace declarations and scripts that build or test the companion;
- companion-specific design and implementation documents that belong in the
  new repository;
- monorepo wording and companion packaging instructions that are no longer
  accurate.

Base VSIX audit rules may continue to reject MCP executables or companion
directories as a defense-in-depth packaging constraint even after those paths
are removed from the source tree.

## 6. Runtime Dependency and Data Flow

The standalone companion does not import files from the debugger repository.
Its `DependencyAdapter` obtains `kpk.unity-debugger-pure` through
`vscode.extensions.getExtension`, activates it, and validates the returned
facade structurally:

- `apiVersion` is exactly `1`;
- `debugType` is exactly `unity-debugger-pure`;
- `extensionVersion` is a string;
- `discoverTargets` and `startAttach` are callable.

All debugger session access continues through VS Code's debug APIs after an
attach is initiated through API v1. The bundled MCP stdio process connects only
to the matching companion extension host over the existing authenticated,
current-user Windows named pipe. No TCP listener, telemetry, Adapter copy, or
Mono runtime is introduced by the split.

## 7. Build, Packaging, and Release Configuration

The new root package owns these independent operations:

- typecheck the companion extension and private server workspace;
- run all companion unit, simulated integration, and package tests;
- bundle the extension and server;
- build the Windows x64 Node 26.5.0 single executable application;
- smoke-test strict MCP stdout behavior and authenticated bridge startup;
- package `dist/unity-debugger-pure-mcp-0.1.0.vsix`;
- audit the VSIX manifest, dependency, provider, path allowlist, runtime
  inventory, executable architecture, and prohibited payloads.

The directory normalization may alter the SEA bytes even when runtime behavior
does not change. The migration therefore regenerates and explicitly reviews
the `runtime-inventory.json` SHA-256 under exact Node `v26.5.0`. A hash update
is accepted only after the PE/AMD64 check, process smoke test, integration
tests, and package audit pass.

The VSIX allowlist excludes source files, source maps, Git metadata,
`node_modules`, test assets, the debugger Adapter, and Mono assemblies.

Independent GitHub workflow files are prepared for future use, but their
presence does not authorize creating a remote, pushing a branch, creating a
release, or publishing to a registry during this migration.

## 8. Migration Sequence

1. Record the source repository path, branch, and exact tip commit; require a
   clean tracked state.
2. Require that `D:\Unity\unity-debugger-pure-mcp` does not exist.
3. Create a local clone at the target and remove its inherited remote.
4. Filter the clone through the reviewed companion path allowlist and prune
   commits that become empty.
5. Verify preserved commit metadata and compare content hashes for the filtered
   source, tests, scripts, and documents against the recorded source commit.
6. Create `codex/standalone-repository` in the new repository.
7. Normalize directories, root package ownership, imports, build paths,
   documentation links, ignores, and workflow files in one migration commit.
8. Install from the independent lockfile and run the complete new-repository
   verification suite.
9. Only after step 8 passes, create a separate cleanup commit on the debugger
   repository's existing feature branch.
10. Run the debugger repository's complete verification suite and confirm both
    tracked workspaces are clean.

No worktree is created at any step.

## 9. Failure Handling and Recovery

The migration stops before debugger-repository cleanup if:

- the target directory already exists;
- the source repository is dirty or its recorded tip changes unexpectedly;
- history filtering drops an allowlisted change or content hashes differ;
- commit metadata validation fails;
- the required Node version is unavailable;
- typecheck, test, build, SEA smoke, inventory, or VSIX audit fails;
- the companion imports a debugger-internal source path.

A failure in the new repository leaves the source repository unchanged. The
partially created target is retained for diagnosis unless the user explicitly
authorizes its removal.

Debugger cleanup is a separate commit made only after standalone verification.
If debugger verification then fails, fix or revert only that cleanup commit;
do not alter the already validated filtered history.

## 10. Verification Strategy

### 10.1 Independent repository

- Fresh `npm ci` using the standalone lockfile.
- TypeScript checks for both extension and server boundaries.
- All companion extension and server unit tests.
- Simulated end-to-end debug session through a real child process and Windows
  named pipe.
- Cancellation, aggregate response-budget, socket-preservation, opaque
  reference, lifecycle, and strict schema regression tests.
- Exact Node 26.5.0 SEA build, PE/AMD64 validation, and stdout smoke test.
- VSIX package tests and direct verifier execution.
- Static scan that rejects imports from the debugger repository or absolute
  source paths.
- Source-versus-filtered content-hash report.
- Commit metadata/order report for retained history.
- Clean tracked state on `codex/standalone-repository`.

### 10.2 Debugger repository

- Base TypeScript typecheck, including public API v1 tests.
- Extension, Adapter, and simulated integration tests.
- Debugger build, staging, VSIX packaging, and direct artifact verification.
- Static scan confirming companion workspaces, tests, scripts, npm commands,
  and stale monorepo instructions are gone.
- Validation that `kpk.unity-debugger-pure` still exports API v1 and that its
  VSIX contains no companion executable.
- Clean tracked state with one reviewable cleanup commit.

Real Unity/Tuanjie Editor and Computer Use acceptance are unnecessary because
the split does not modify the already verified bridge protocol, MCP tools,
debug Adapter, or debugger runtime behavior. If implementation requires a
runtime behavior change, stop and request the confirmation required by the
repository instructions before any real Editor interaction.

## 11. Completion Criteria

The split is complete when:

- the independent local repository exists at the agreed path with preserved
  relevant history and no remote;
- its standalone branch builds, tests, packages, and audits successfully;
- the debugger repository retains API v1 but no companion implementation;
- the debugger repository also builds, tests, packages, and audits
  successfully;
- both repositories have clean tracked states and their resulting branches and
  commits are reported to the user;
- no remote repository, release, marketplace publication, Editor session, or
  Computer Use session was started.
