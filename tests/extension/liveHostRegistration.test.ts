import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIVE_HOST_MAX_RECORD_BYTES,
  canonicalPathContains,
  parseLiveHostRegistration,
  resolveRuntimeRegistryRoot,
} from "../../src/external/liveHostRegistration.js";

const FIXTURE_BYTES = fs.readFileSync(
  path.resolve("tests", "fixtures", "live-host-registration-v1.json"),
);

function fixture(): Record<string, unknown> {
  return JSON.parse(FIXTURE_BYTES.toString("utf8")) as Record<string, unknown>;
}

function encoded(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("live host registration schema v1", () => {
  it("parses the exact schema-v1 registration fixture", () => {
    const registration = parseLiveHostRegistration(FIXTURE_BYTES);

    expect(registration).toEqual({
      schemaVersion: 1,
      instanceId: "11111111-1111-4111-8111-111111111111",
      ownerPid: 4242,
      updatedAt: "2026-07-31T06:00:00.000Z",
      workspaceRoots: ["C:\\fixture\\project"],
      bridge: {
        version: "0.1.0",
        protocolVersion: 1,
        extensionRoot: "C:\\fixture\\extension",
        executable: "C:\\fixture\\extension\\dist\\mcp-bridge.exe",
        sha256: "a".repeat(64),
      },
      pipe: {
        name: "\\\\.\\pipe\\unity-debugger-pure-mcp-fixture",
        token: "ERERERERERERERERERERERERERERERERERERERERERE",
      },
    });
  });

  it("rejects unknown keys at every object boundary", () => {
    const root = fixture();
    const bridge = structuredClone(root);
    const pipe = structuredClone(root);
    root.extra = true;
    (bridge.bridge as Record<string, unknown>).extra = true;
    (pipe.pipe as Record<string, unknown>).extra = true;

    for (const value of [root, bridge, pipe]) {
      expect(() => parseLiveHostRegistration(encoded(value))).toThrow(
        "Live host registration is invalid.",
      );
    }
  });

  it("rejects malformed, oversized, and non-object JSON", () => {
    const oversized = Buffer.alloc(LIVE_HOST_MAX_RECORD_BYTES + 1, 0x20);

    for (const bytes of [
      Buffer.from("{", "utf8"),
      Buffer.from("\xc3\x28", "binary"),
      Buffer.from("null", "utf8"),
      Buffer.from("[]", "utf8"),
      oversized,
    ]) {
      expect(() => parseLiveHostRegistration(bytes)).toThrow(
        "Live host registration is invalid.",
      );
    }
  });

  it("rejects invalid scalar and collection fields", () => {
    const cases: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.schemaVersion = 2; },
      (value) => { value.instanceId = "not-a-uuid"; },
      (value) => { value.ownerPid = 0; },
      (value) => { value.ownerPid = 1.5; },
      (value) => { value.updatedAt = "2026-07-31"; },
      (value) => { value.workspaceRoots = []; },
      (value) => { value.workspaceRoots = Array.from({ length: 33 }, () => "C:\\fixture"); },
      (value) => { value.workspaceRoots = [""]; },
      (value) => { (value.bridge as Record<string, unknown>).version = ""; },
      (value) => { (value.bridge as Record<string, unknown>).protocolVersion = 2; },
      (value) => { (value.bridge as Record<string, unknown>).extensionRoot = "x".repeat(4_097); },
      (value) => { (value.bridge as Record<string, unknown>).executable = ""; },
      (value) => { (value.bridge as Record<string, unknown>).sha256 = "A".repeat(64); },
      (value) => { (value.pipe as Record<string, unknown>).name = "\\\\.\\pipe\\wrong"; },
      (value) => { (value.pipe as Record<string, unknown>).token = "x".repeat(42); },
    ];

    for (const mutate of cases) {
      const value = fixture();
      mutate(value);
      expect(() => parseLiveHostRegistration(encoded(value))).toThrow(
        "Live host registration is invalid.",
      );
    }
  });

  it("rejects relative filesystem paths in every path-bearing section", () => {
    const roots = fixture();
    const extension = fixture();
    const executable = fixture();
    roots.workspaceRoots = ["relative\\project"];
    (extension.bridge as Record<string, unknown>).extensionRoot = "relative\\extension";
    (executable.bridge as Record<string, unknown>).executable = "dist\\mcp-bridge.exe";

    for (const value of [roots, extension, executable]) {
      expect(() => parseLiveHostRegistration(encoded(value))).toThrow(
        "Live host registration is invalid.",
      );
    }
  });

  it("resolves the registry root beneath the current local app-data directory", () => {
    expect(resolveRuntimeRegistryRoot("C:\\Users\\Fixture\\AppData\\Local")).toBe(
      "C:\\Users\\Fixture\\AppData\\Local\\kpk\\unity-debugger-pure-mcp\\runtime\\v1",
    );
    expect(() => resolveRuntimeRegistryRoot("")).toThrow(
      "The local application-data directory is unavailable.",
    );
  });

  it("contains only the same canonical Windows path or its descendants", () => {
    expect(canonicalPathContains("C:\\Game", "C:\\Game")).toBe(true);
    expect(canonicalPathContains("C:\\Game", "c:\\game\\Assets\\测试.cs")).toBe(true);
    expect(canonicalPathContains("C:\\Game", "C:\\Game\\Folder With Spaces")).toBe(true);
    expect(canonicalPathContains("C:\\Game", "C:\\Game\\..\\Other")).toBe(false);
    expect(canonicalPathContains("C:\\Game", "C:\\GameBackup")).toBe(false);
    expect(canonicalPathContains("C:\\Game", "D:\\Game")).toBe(false);
  });
});
