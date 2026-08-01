import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeDescriptor } from "../../src/bridge/bridgeHost.js";
import {
  LIVE_HOST_HEARTBEAT_MS,
  LIVE_HOST_STALE_MS,
  parseLiveHostRegistration,
  resolveRuntimeRegistryRoot,
} from "../../src/external/liveHostRegistration.js";
import {
  LiveHostRegistrationPublisher,
  verifyPackagedBridgeIntegrity,
  type LiveHostPublisherClock,
  type LiveHostPublisherFileSystem,
  type LiveHostWorkspaceSnapshot,
} from "../../src/external/liveHostRegistrationPublisher.js";

const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "ERERERERERERERERERERERERERERERERERERERERERE";
const PIPE_NAME = "\\\\.\\pipe\\unity-debugger-pure-mcp-publisher-fixture";

const temporaryDirectories: string[] = [];

class ManualClock implements LiveHostPublisherClock {
  #now: number;
  #scheduled: { callback: () => void | Promise<void>; due: number } | undefined;

  constructor(now = Date.parse("2026-07-31T06:00:00.000Z")) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void | Promise<void>, milliseconds: number): NodeJS.Timeout {
    this.#scheduled = { callback, due: this.#now + milliseconds };
    return { fixture: true } as unknown as NodeJS.Timeout;
  }

  clearTimeout(): void {
    this.#scheduled = undefined;
  }

  pendingDelay(): number | undefined {
    return this.#scheduled?.due === undefined
      ? undefined
      : this.#scheduled.due - this.#now;
  }

  async advance(milliseconds: number): Promise<void> {
    this.#now += milliseconds;
    const scheduled = this.#scheduled;
    if (scheduled !== undefined && scheduled.due <= this.#now) {
      this.#scheduled = undefined;
      await scheduled.callback();
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function harness(options: {
  readonly clock?: ManualClock;
  readonly workspace?: () => LiveHostWorkspaceSnapshot;
  readonly processAlive?: (pid: number) => boolean;
  readonly fileSystem?: LiveHostPublisherFileSystem;
} = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "udp-mcp-publisher-"));
  temporaryDirectories.push(base);
  const localAppData = path.join(base, "local app data");
  const extensionRoot = path.join(base, "扩展 root");
  const bridgeExecutable = path.join(extensionRoot, "dist", "mcp-bridge.exe");
  const workspaceRoot = path.join(base, "workspace with spaces");
  const bridgeBytes = Buffer.from("audited bridge fixture", "utf8");
  await fs.mkdir(path.dirname(bridgeExecutable), { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(bridgeExecutable, bridgeBytes);
  const clock = options.clock ?? new ManualClock();
  const workspaceState = {
    current: { trusted: true, roots: [workspaceRoot] } as LiveHostWorkspaceSnapshot,
  };
  const descriptor: BridgeDescriptor = Object.freeze({
    protocolVersion: 1,
    pipeName: PIPE_NAME,
    token: TOKEN,
  });
  const publisher = new LiveHostRegistrationPublisher({
    localAppData,
    ownerPid: 4242,
    extensionRoot,
    bridgeExecutable,
    bridgeVersion: "0.1.0",
    bridgeSha256: createHash("sha256").update(bridgeBytes).digest("hex"),
    descriptor,
    workspace: options.workspace ?? (() => workspaceState.current),
    clock,
    randomUUID: () => INSTANCE_ID,
    isProcessAlive: options.processAlive ?? (() => false),
    fileSystem: options.fileSystem,
  });
  return {
    base,
    bridgeBytes,
    bridgeExecutable,
    clock,
    extensionRoot,
    localAppData,
    publisher,
    registryRoot: resolveRuntimeRegistryRoot(localAppData),
    workspaceRoot,
    workspaceState,
  };
}

async function registrationFiles(registryRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(registryRoot)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function nativeFileSystem(
  rename: LiveHostPublisherFileSystem["rename"] = async (source, destination) => {
    await fs.rename(source, destination);
  },
): LiveHostPublisherFileSystem {
  return {
    mkdir: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
    readdir: (directory) => fs.readdir(directory),
    readFile: (file) => fs.readFile(file),
    writeFile: async (file, bytes) => { await fs.writeFile(file, bytes); },
    rename,
    rm: async (file) => { await fs.rm(file, { force: true }); },
    realpath: (file) => fs.realpath(file),
  };
}

describe("live host registration publisher", () => {
  it("atomically publishes the canonical schema after the Host is ready", async () => {
    const setup = await harness();

    await setup.publisher.start();

    expect(await registrationFiles(setup.registryRoot)).toEqual([`${INSTANCE_ID}.json`]);
    const registration = parseLiveHostRegistration(
      await fs.readFile(path.join(setup.registryRoot, `${INSTANCE_ID}.json`)),
    );
    expect(registration).toMatchObject({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      ownerPid: 4242,
      updatedAt: "2026-07-31T06:00:00.000Z",
      workspaceRoots: [await fs.realpath(setup.workspaceRoot)],
      bridge: {
        version: "0.1.0",
        protocolVersion: 1,
        extensionRoot: await fs.realpath(setup.extensionRoot),
        executable: await fs.realpath(setup.bridgeExecutable),
        sha256: createHash("sha256").update(setup.bridgeBytes).digest("hex"),
      },
      pipe: { name: PIPE_NAME, token: TOKEN },
    });
    expect((await fs.readdir(setup.registryRoot)).some((name) => name.endsWith(".tmp")))
      .toBe(false);
    expect(setup.clock.pendingDelay()).toBe(LIVE_HOST_HEARTBEAT_MS);
  });

  it.each([
    { name: "untrusted", state: { trusted: false, roots: ["unused"] } },
    { name: "rootless", state: { trusted: true, roots: [] } },
  ])("publishes no record for a $name workspace", async ({ state }) => {
    const setup = await harness({ workspace: () => state });

    await setup.publisher.start();

    expect(await registrationFiles(setup.registryRoot)).toEqual([]);
    expect(setup.clock.pendingDelay()).toBe(LIVE_HOST_HEARTBEAT_MS);
  });

  it("refreshes at 15 seconds and removes the record when trust is lost", async () => {
    const setup = await harness();
    const record = path.join(setup.registryRoot, `${INSTANCE_ID}.json`);
    await setup.publisher.start();

    await setup.clock.advance(LIVE_HOST_HEARTBEAT_MS - 1);
    expect(parseLiveHostRegistration(await fs.readFile(record)).updatedAt).toBe(
      "2026-07-31T06:00:00.000Z",
    );
    await setup.clock.advance(1);
    expect(parseLiveHostRegistration(await fs.readFile(record)).updatedAt).toBe(
      "2026-07-31T06:00:15.000Z",
    );

    setup.workspaceState.current = { trusted: false, roots: [setup.workspaceRoot] };
    await setup.clock.advance(LIVE_HOST_HEARTBEAT_MS);
    await expect(fs.stat(record)).rejects.toMatchObject({ code: "ENOENT" });

    setup.workspaceState.current = { trusted: true, roots: [setup.workspaceRoot] };
    await setup.clock.advance(LIVE_HOST_HEARTBEAT_MS);
    expect(parseLiveHostRegistration(await fs.readFile(record)).updatedAt).toBe(
      "2026-07-31T06:00:45.000Z",
    );
  });

  it("prunes only stale registrations whose owner is confirmed absent", async () => {
    const alivePid = 7001;
    const deadPid = 7002;
    const setup = await harness({ processAlive: (pid) => pid === alivePid });
    await fs.mkdir(setup.registryRoot, { recursive: true });
    const base = JSON.parse(
      await fs.readFile(path.resolve("tests/fixtures/live-host-registration-v1.json"), "utf8"),
    ) as Record<string, unknown>;
    const writeForeign = async (id: string, pid: number): Promise<void> => {
      const value = structuredClone(base);
      value.instanceId = id;
      value.ownerPid = pid;
      value.updatedAt = new Date(setup.clock.now() - LIVE_HOST_STALE_MS - 1).toISOString();
      await fs.writeFile(path.join(setup.registryRoot, `${id}.json`), JSON.stringify(value));
    };
    await writeForeign(OTHER_INSTANCE_ID, alivePid);
    await writeForeign("44444444-4444-4444-8444-444444444444", deadPid);
    await fs.writeFile(path.join(setup.registryRoot, "malformed.json"), "{");

    await setup.publisher.start();

    expect((await registrationFiles(setup.registryRoot)).sort()).toEqual([
      `${INSTANCE_ID}.json`,
      `${OTHER_INSTANCE_ID}.json`,
      "malformed.json",
    ]);
  });

  it("closes idempotently and removes only its owned registration", async () => {
    const setup = await harness();
    await setup.publisher.start();
    const foreign = path.join(setup.registryRoot, `${OTHER_INSTANCE_ID}.json`);
    await fs.writeFile(foreign, "foreign");

    await Promise.all([setup.publisher.close(), setup.publisher.close()]);

    expect(await registrationFiles(setup.registryRoot)).toEqual([`${OTHER_INSTANCE_ID}.json`]);
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign");
    expect(setup.clock.pendingDelay()).toBeUndefined();
  });

  it("waits for an in-progress atomic write before removing its record", async () => {
    let releaseRename!: () => void;
    let reportRenameStarted!: () => void;
    const renameStarted = new Promise<void>((resolve) => { reportRenameStarted = resolve; });
    const renameReleased = new Promise<void>((resolve) => { releaseRename = resolve; });
    const fileSystem = nativeFileSystem(async (source, destination) => {
      reportRenameStarted();
      await renameReleased;
      await fs.rename(source, destination);
    });
    const setup = await harness({ fileSystem });
    const starting = setup.publisher.start();
    await renameStarted;

    const closing = setup.publisher.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseRename();
    await starting;
    await closing;
    expect(await registrationFiles(setup.registryRoot)).toEqual([]);
  });

  it("fails closed and schedules a retry after a heartbeat write failure", async () => {
    let failWrites = false;
    const native = nativeFileSystem();
    const fileSystem: LiveHostPublisherFileSystem = {
      ...native,
      async writeFile(file, bytes) {
        if (failWrites) {
          throw new Error("fixture write failure");
        }
        await native.writeFile(file, bytes);
      },
    };
    const setup = await harness({ fileSystem });
    const record = path.join(setup.registryRoot, `${INSTANCE_ID}.json`);
    await setup.publisher.start();
    failWrites = true;

    await expect(setup.clock.advance(LIVE_HOST_HEARTBEAT_MS)).resolves.toBeUndefined();

    await expect(fs.stat(record)).rejects.toMatchObject({ code: "ENOENT" });
    expect(setup.clock.pendingDelay()).toBe(LIVE_HOST_HEARTBEAT_MS);
    failWrites = false;
    await setup.clock.advance(LIVE_HOST_HEARTBEAT_MS);
    expect(parseLiveHostRegistration(await fs.readFile(record)).updatedAt).toBe(
      "2026-07-31T06:00:30.000Z",
    );
  });
});

describe("packaged bridge integrity", () => {
  it.each(["v26.5.0", "v26.5.1", "v26.6.0"])(
    "accepts compatible packaged inventory %s",
    async (nodeVersion) => {
      const setup = await harness();
      const inventory = path.join(setup.base, "runtime-inventory.json");
      const digest = createHash("sha256").update(setup.bridgeBytes).digest("hex");
      await fs.writeFile(inventory, JSON.stringify({ nodeVersion, sha256: digest }));

      await expect(verifyPackagedBridgeIntegrity(inventory, setup.bridgeExecutable))
        .resolves.toBe(digest);
    },
  );

  it.each(["v26.4.9", "v26.5.1-rc.1", "v27.0.0", "26.5.1"])(
    "rejects unsupported packaged inventory %s",
    async (nodeVersion) => {
      const setup = await harness();
      const inventory = path.join(setup.base, "runtime-inventory.json");
      const digest = createHash("sha256").update(setup.bridgeBytes).digest("hex");
      await fs.writeFile(inventory, JSON.stringify({ nodeVersion, sha256: digest }));

      await expect(verifyPackagedBridgeIntegrity(inventory, setup.bridgeExecutable))
        .rejects.toThrow("MCP bridge runtime inventory is invalid.");
    },
  );

  it("rejects malformed, extended, or mismatched packaged inventory", async () => {
    const setup = await harness();
    const inventory = path.join(setup.base, "runtime-inventory.json");
    const digest = createHash("sha256").update(setup.bridgeBytes).digest("hex");
    const cases: unknown[] = [
      null,
      { nodeVersion: "v26.5.0", sha256: "a".repeat(64), extra: true },
      { nodeVersion: "v26.5.0", sha256: "A".repeat(64) },
      { nodeVersion: "v26.5.0", sha256: digest.replace(/^./, digest[0] === "a" ? "b" : "a") },
    ];

    for (const value of cases) {
      await fs.writeFile(inventory, JSON.stringify(value));
      await expect(verifyPackagedBridgeIntegrity(inventory, setup.bridgeExecutable))
        .rejects.toThrow("MCP bridge runtime inventory is invalid.");
    }
  });
});
