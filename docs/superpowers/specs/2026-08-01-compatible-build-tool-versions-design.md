# Compatible Build Tool Versions Design

## Goal

Allow developers to build and audit the companion with compatible Node.js and
uv patch/minor releases without changing their globally installed tools, while
preserving deterministic, reviewed inputs for public releases.

The supported local ranges are:

- Node.js `>=26.5.0 <27.0.0` on Windows x64;
- uv `>=0.12.0 <0.13.0`.

Official companion and launcher release workflows remain pinned to Node.js
`26.5.0` and uv `0.12.0` respectively.

## Build and Release Policy

Local compatibility and public reproducibility are separate gates:

1. Normal build and package commands accept any tool version in the supported
   ranges. They still run the complete SEA smoke test, launcher artifact
   verifier, strict VSIX allowlist, and package tests.
2. Public release workflows install the existing exact tool versions. The
   companion release additionally compares the generated SEA inventory with a
   tracked reviewed release inventory before publishing.
3. Versions below the supported minimum, Node.js 27 or newer, uv 0.13 or newer,
   prerelease versions, malformed version output, and non-Windows/non-x64 hosts
   fail before producing a publishable artifact.

No environment-variable bypass or hidden unsafe mode is added.

## SEA Inventory Model

`runtime-inventory.json` remains tracked and represents the reviewed official
release build. Normal builds never rewrite it.

`scripts/build-mcp-bridge.mjs` writes the actual local build identity to
`dist/runtime-inventory.json` after the SEA passes AMD64 and direct/registry
smoke tests. The generated inventory contains exactly:

```json
{
  "nodeVersion": "v26.5.1",
  "sha256": "<64 lower-case hexadecimal characters>"
}
```

The VSIX packages this generated file as
`extension/dist/runtime-inventory.json`; the previous
`extension/runtime-inventory.json` path is removed. The archive still contains
exactly 12 allowlisted files. The tracked release inventory is excluded from
the VSIX.

The extension reads the generated inventory beside `mcp-bridge.exe`. Runtime
validation accepts only a supported Node version string and a strict SHA-256,
then hashes the executable as before. The launcher registry continues to bind
the exact executable path and digest, so changing the build-tool policy does
not expose pipe names, tokens, or machine paths.

## Verification Layers

The normal VSIX verifier checks:

- its own Node.js process is within the supported range;
- the packaged inventory has the exact two-field schema;
- the packaged Node.js version is within the supported range;
- the packaged SHA-256 matches the packaged AMD64 SEA;
- the SEA passes the existing protocol smoke test and the archive stays within
  the 12-file allowlist.

A separate release-inventory verifier compares the exact two parsed fields in
`dist/runtime-inventory.json` with the tracked `runtime-inventory.json`. The
companion release workflow must run this verifier
after building with Node.js `26.5.0` and before uploading the VSIX.

Launcher builds parse `uv --version` and accept only the supported `0.12.x`
range. The launcher release workflow remains pinned to uv `0.12.0`; wheel and
sdist contents still pass the existing independent artifact verifier.

## Code Boundaries

- Add a small build-time version-policy module under `scripts/` for parsing and
  comparing Node.js and uv versions. Build and verification scripts reuse it.
- Keep extension runtime validation self-contained; do not bundle build scripts
  into the VSIX.
- Update `src/extension.ts` to read
  `dist/runtime-inventory.json` and relax only the inventory Node-version type.
- Update `.vscodeignore`, the strict verifier, package tests, and build tests for
  the generated inventory path without adding archive files.
- Do not change MCP protocol version 1, the bridge registration schema, tool
  schemas, the Python launcher version, or companion version `0.1.1`.

## Testing

Tests must prove behavior rather than inspect only source text:

- version policy accepts Node.js `26.5.0`, `26.5.1`, and later 26.x versions;
- it rejects `26.4.9`, prereleases, malformed strings, and `27.0.0`;
- it accepts uv `0.12.0` and `0.12.1`, and rejects `0.11.x`, prereleases,
  malformed strings, and `0.13.0`;
- a build with the machine's current compatible Node.js generates a matching
  `dist/runtime-inventory.json` and audited VSIX;
- normal packaging does not modify the tracked release inventory;
- release verification rejects a generated Node version or SHA mismatch;
- the packaged extension loads and validates the generated inventory at its
  new path;
- existing SEA, named-pipe, MCP, external configuration, launcher, and archive
  regression suites remain green.

The final local acceptance gate deliberately runs with the machine's ordinary
compatible Node.js and uv installations. A second release gate uses exact
Node.js `26.5.0` and uv `0.12.0` and requires the tracked release inventory to
match.

## Migration and Failure Behavior

The change affects only build inputs and the internal packaged inventory path.
Installed `0.1.0` and earlier `0.1.1` development VSIX files remain
self-contained and require no migration. A newly packaged extension always
ships its generated inventory and bridge together.

If a compatible local Node.js release produces a different SEA, local package
verification succeeds only when the generated inventory matches that exact
SEA. It does not update the reviewed release inventory. Public release
verification therefore remains blocked until an explicitly reviewed exact
release build updates that tracked inventory.

## Non-Goals

- Supporting Node.js 25, Node.js 27+, uv 0.11, or uv 0.13+.
- Automatically changing global Node.js or uv installations.
- Automatically accepting a new official release hash.
- Republishing launcher `0.1.0` or changing companion/server/launcher versions.
- Weakening the SEA smoke test, runtime digest comparison, or VSIX allowlist.
