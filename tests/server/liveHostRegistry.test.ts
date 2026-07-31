import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_HOST_STALE_MS, resolveRuntimeRegistryRoot } from "../../src/external/liveHostRegistration.js";
import { BridgeCallError } from "../../server/src/bridgeClient.js";
import { LiveHostRegistry } from "../../server/src/liveHostRegistry.js";

const TOKEN = Buffer.alloc(32, 0x23).toString("base64url");
const NOW = Date.parse("2026-07-31T06:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function harness(options: {
  readonly clientRootOutsideWorkspace?: boolean;
  readonly runtimeRootOverride?: string;
  readonly runningExecutableOverride?: string;
} = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "udp-mcp-registry-"));
  temporaryDirectories.push(base);
  const localAppData = path.join(base, "local app data");
  const runtimeRoot = resolveRuntimeRegistryRoot(localAppData);
  const workspaceRoot = path.join(base, "workspace");
  const clientRoot = options.clientRootOutsideWorkspace
    ? path.join(base, "other workspace")
    : path.join(workspaceRoot, "nested", "project");
  const extensionRoot = path.join(base, "extension");
  const executable = path.join(extensionRoot, "dist", "mcp-bridge.exe");
  const bridgeBytes = Buffer.from("registry bridge fixture", "utf8");
  await Promise.all([
    fs.mkdir(runtimeRoot, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true }),
    fs.mkdir(clientRoot, { recursive: true }),
    fs.mkdir(path.dirname(executable), { recursive: true }),
  ]);
  await fs.writeFile(executable, bridgeBytes);
  const livePids = new Set([4242]);
  const registry = new LiveHostRegistry({
    runtimeRoot: options.runtimeRootOverride ?? runtimeRoot,
    clientRoot,
    runningExecutable: options.runningExecutableOverride ?? executable,
    localAppData,
    now: () => NOW,
    isProcessAlive: (pid) => livePids.has(pid),
  });
  return {
    base,
    bridgeBytes,
    clientRoot,
    executable,
    extensionRoot,
    livePids,
    localAppData,
    registry,
    runtimeRoot,
    workspaceRoot,
  };
}

async function writeRegistration(
  setup: Awaited<ReturnType<typeof harness>>,
  overrides: Record<string, unknown> = {},
  instanceId = "55555555-5555-4555-8555-555555555555",
): Promise<void> {
  const value = {
    schemaVersion: 1,
    instanceId,
    ownerPid: 4242,
    updatedAt: new Date(NOW).toISOString(),
    workspaceRoots: [await fs.realpath(setup.workspaceRoot)],
    bridge: {
      version: "0.1.0",
      protocolVersion: 1,
      extensionRoot: await fs.realpath(setup.extensionRoot),
      executable: await fs.realpath(setup.executable),
      sha256: createHash("sha256").update(setup.bridgeBytes).digest("hex"),
    },
    pipe: {
      name: "\\\\.\\pipe\\unity-debugger-pure-mcp-registry-fixture",
      token: TOKEN,
    },
  };
  merge(value as unknown as Record<string, unknown>, overrides);
  await fs.writeFile(
    path.join(setup.runtimeRoot, `${instanceId}.json`),
    JSON.stringify(value),
  );
}

function merge(target: Record<string, unknown>, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])
    ) {
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(BridgeCallError);
  await expect(operation).rejects.toMatchObject({
    detail: { code: "BRIDGE_UNAVAILABLE" },
  });
}

describe("LiveHostRegistry", () => {
  it("returns the one live registration containing the canonical client root", async () => {
    const setup = await harness();
    await writeRegistration(setup);

    await expect(setup.registry.locate()).resolves.toEqual({
      protocolVersion: 1,
      pipeName: "\\\\.\\pipe\\unity-debugger-pure-mcp-registry-fixture",
      token: TOKEN,
    });
  });

  it("fails closed when no live registration contains the client root", async () => {
    const setup = await harness({ clientRootOutsideWorkspace: true });
    await writeRegistration(setup);

    await expectUnavailable(setup.registry.locate());
  });

  it("returns AMBIGUOUS_BRIDGE for two independently valid matches", async () => {
    const setup = await harness();
    await writeRegistration(setup);
    await writeRegistration(
      setup,
      { pipe: { name: "\\\\.\\pipe\\unity-debugger-pure-mcp-second" } },
      "66666666-6666-4666-8666-666666666666",
    );

    await expect(setup.registry.locate()).rejects.toMatchObject({
      detail: { code: "AMBIGUOUS_BRIDGE" },
    });
  });

  it.each([
    {
      name: "stale heartbeat",
      overrides: { updatedAt: new Date(NOW - LIVE_HOST_STALE_MS - 1).toISOString() },
    },
    { name: "future heartbeat", overrides: { updatedAt: new Date(NOW + 15_001).toISOString() } },
    { name: "dead owner", overrides: { ownerPid: 7000 } },
    { name: "protocol mismatch", overrides: { bridge: { protocolVersion: 2 } } },
    { name: "hash mismatch", overrides: { bridge: { sha256: "a".repeat(64) } } },
    { name: "path substitution", overrides: { bridge: { executable: "C:\\fixture\\other.exe" } } },
  ])("ignores a registration with $name", async ({ overrides }) => {
    const setup = await harness();
    await writeRegistration(setup, overrides);

    await expectUnavailable(setup.registry.locate());
  });

  it("ignores malformed files while accepting one independently valid record", async () => {
    const setup = await harness();
    await fs.writeFile(path.join(setup.runtimeRoot, "malformed.json"), "{");
    await writeRegistration(setup);

    await expect(setup.registry.locate()).resolves.toMatchObject({ token: TOKEN });
  });

  it("rejects a registry root outside the well-known current-user location", async () => {
    const setup = await harness();
    const unexpected = path.join(setup.base, "attacker registry");
    await fs.mkdir(unexpected, { recursive: true });
    const registry = new LiveHostRegistry({
      runtimeRoot: unexpected,
      clientRoot: setup.clientRoot,
      runningExecutable: setup.executable,
      localAppData: setup.localAppData,
      now: () => NOW,
      isProcessAlive: () => true,
    });

    await expectUnavailable(registry.locate());
  });

  it("rejects a registered bridge other than the currently running SEA", async () => {
    const setup = await harness();
    await writeRegistration(setup);
    const otherExecutable = path.join(setup.base, "other", "mcp-bridge.exe");
    await fs.mkdir(path.dirname(otherExecutable), { recursive: true });
    await fs.writeFile(otherExecutable, setup.bridgeBytes);
    const registry = new LiveHostRegistry({
      runtimeRoot: setup.runtimeRoot,
      clientRoot: setup.clientRoot,
      runningExecutable: otherExecutable,
      localAppData: setup.localAppData,
      now: () => NOW,
      isProcessAlive: () => true,
    });

    await expectUnavailable(registry.locate());
  });

  it("realpaths a junctioned client root before workspace containment", async () => {
    const setup = await harness();
    const outside = path.join(setup.base, "outside");
    const junction = path.join(setup.workspaceRoot, "junction");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, junction, "junction");
    await writeRegistration(setup);
    const registry = new LiveHostRegistry({
      runtimeRoot: setup.runtimeRoot,
      clientRoot: junction,
      runningExecutable: setup.executable,
      localAppData: setup.localAppData,
      now: () => NOW,
      isProcessAlive: () => true,
    });

    await expectUnavailable(registry.locate());
  });
});
