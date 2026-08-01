import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFICIAL_RELEASE_NODE_VERSION,
  OFFICIAL_RELEASE_UV_VERSION,
  assertSupportedNodeVersion,
  assertSupportedUvVersionOutput,
} from "../../scripts/build-tool-version-policy.mjs";

test("Node policy accepts stable compatible 26.x versions", () => {
  for (const version of ["v26.5.0", "v26.5.1", "v26.6.0", "v26.99.4"]) {
    assert.equal(assertSupportedNodeVersion(version), version);
  }
  assert.equal(OFFICIAL_RELEASE_NODE_VERSION, "v26.5.0");
});

test("Node policy rejects versions outside the supported stable range", () => {
  for (const version of [
    "26.5.0",
    "v26.4.9",
    "v26.5",
    "v26.5.1-rc.1",
    "v27.0.0",
    "garbage",
  ]) {
    assert.throws(
      () => assertSupportedNodeVersion(version),
      />=26\.5\.0 <27\.0\.0/,
      version,
    );
  }
});

test("uv policy accepts stable 0.12.x output", () => {
  assert.equal(assertSupportedUvVersionOutput("uv 0.12.0"), "0.12.0");
  assert.equal(assertSupportedUvVersionOutput("uv 0.12.1"), "0.12.1");
  assert.equal(
    assertSupportedUvVersionOutput(
      "uv 0.12.1 (329541a50 2026-07-31 x86_64-pc-windows-msvc)",
    ),
    "0.12.1",
  );
  assert.equal(OFFICIAL_RELEASE_UV_VERSION, "0.12.0");
});

test("uv policy rejects versions outside stable 0.12.x", () => {
  for (const version of [
    "0.12.0",
    "uv 0.11.9",
    "uv 0.12",
    "uv 0.12.1-rc.1",
    "uv 0.12.1 (nested (metadata))",
    "uv 0.12.1 metadata-without-parentheses",
    "uv 0.13.0",
    "uv garbage",
  ]) {
    assert.throws(
      () => assertSupportedUvVersionOutput(version),
      />=0\.12\.0 <0\.13\.0/,
      version,
    );
  }
});
