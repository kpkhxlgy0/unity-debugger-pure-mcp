# Companion Icon and Repository Metadata Design

## Goal

Give Unity Debugger Pure MCP a recognizable sibling identity to Unity Debugger
Pure, make the GitHub repository easier to discover, and prepare companion
version 0.1.1 without changing or republishing the launcher.

## Icon

Use the approved "Protocol Ring" direction. The final asset is a 512 by 512
PNG with a flat near-black navy background, a cyan wireframe cube inside a
simple cyan hexagonal connection ring, and one coral-red breakpoint node on the
lower-right ring segment. It contains no text, gradients, glow, shadows, or
third-party marks. Its main geometry must remain legible at 32 and 64 pixels.

Store the final asset at `images/icon.png` and declare it through the root VS
Code extension manifest. The companion VSIX allowlist and package tests must
explicitly include exactly that asset. The README may display the same file;
there is no duplicate logo source.

## Repository Presentation

The README header displays the icon and badges for Visual Studio Marketplace,
Open VSX, PyPI, CI, and the MIT license. Existing installation and security
guidance remains authoritative and is not reorganized as part of this work.

Set the GitHub repository About fields to:

- Description: `VS Code MCP companion for inspecting and controlling Unity and Tuanjie debug sessions with Unity Debugger Pure.`
- Website: `https://marketplace.visualstudio.com/items?itemName=kpk.unity-debugger-pure-mcp`
- Topics: `unity`, `tuanjie`, `vscode-extension`, `mcp`,
  `model-context-protocol`, `debugger`, `debug-adapter-protocol`, and `codex`

This scope does not add a GitHub social-preview banner or change the repository
owner avatar.

## Version and Release Boundary

Bump only the companion extension from 0.1.0 to 0.1.1. Update the root manifest,
lockfile identity, changelog, fixed artifact names, package tests, and companion
release documentation consistently. Keep the private server workspace and the
PyPI launcher at version 0.1.0. Do not create a launcher tag or publish new
launcher artifacts.

Build and audit the local `unity-debugger-pure-mcp-0.1.1.vsix`. Publishing is a
separate authorized action: Visual Studio Marketplace remains a manual upload,
while a later `companion-v0.1.1` tag may publish Open VSX and the companion
GitHub Release through the existing workflow.

The public Unity Debugger Pure channels currently provide version 0.1.1. The
local debugger 0.2.0 contains the public debugger API required by the companion
but has not yet been pushed or published. Therefore companion 0.1.1 must not be
published until the exact local debugger 0.2.0 and companion 0.1.1 VSIX files
pass combined validation and debugger 0.2.0 is publicly available.

The release order is fixed:

1. build and validate debugger 0.2.0 with companion 0.1.1 locally;
2. publish debugger 0.2.0;
3. verify the public debugger artifact;
4. publish companion 0.1.1 to its independent channels.

## Verification

- Inspect the full-size icon and downscaled 64- and 32-pixel previews.
- Verify the PNG is square, 512 by 512, and uses RGB/RGBA color.
- Run root type checking and the complete companion test suite.
- Build the SEA and companion VSIX with exact Node.js 26.5.0.
- Run the strict VSIX allowlist and package tests and confirm the icon is the
  only newly packaged file.
- Confirm launcher metadata and launcher artifacts remain at 0.1.0.
- Install the exact debugger 0.2.0 and companion 0.1.1 VSIX files together and
  verify API v1 activation plus one real MCP inspection/control flow before any
  release.
- Read back GitHub About metadata after updating it.
- Leave publishing, tagging, pushing, and both Marketplace uploads pending
  explicit authorization; preserve the fixed debugger-before-companion order.
