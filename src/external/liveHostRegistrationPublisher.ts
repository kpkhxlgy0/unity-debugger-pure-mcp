import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeDescriptor } from "../bridge/bridgeHost.js";
import {
  LIVE_HOST_HEARTBEAT_MS,
  LIVE_HOST_MAX_RECORD_BYTES,
  LIVE_HOST_STALE_MS,
  parseLiveHostRegistration,
  resolveRuntimeRegistryRoot,
  type LiveHostRegistrationV1,
} from "./liveHostRegistration.js";

const INVENTORY_ERROR = "MCP bridge runtime inventory is invalid.";

export interface LiveHostWorkspaceSnapshot {
  readonly trusted: boolean;
  readonly roots: readonly string[];
}

export interface LiveHostPublisherClock {
  now(): number;
  setTimeout(
    callback: () => void | Promise<void>,
    milliseconds: number,
  ): NodeJS.Timeout;
  clearTimeout(timeout: NodeJS.Timeout): void;
}

export interface LiveHostPublisherFileSystem {
  mkdir(directory: string): Promise<void>;
  readdir(directory: string): Promise<string[]>;
  readFile(file: string): Promise<Buffer>;
  writeFile(file: string, bytes: Buffer): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(file: string): Promise<void>;
  realpath(file: string): Promise<string>;
}

export interface LiveHostRegistrationPublisherOptions {
  readonly localAppData: string;
  readonly ownerPid: number;
  readonly extensionRoot: string;
  readonly bridgeExecutable: string;
  readonly bridgeVersion: string;
  readonly bridgeSha256: string;
  readonly descriptor: BridgeDescriptor;
  readonly workspace: () => LiveHostWorkspaceSnapshot;
  readonly clock?: LiveHostPublisherClock;
  readonly randomUUID?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly fileSystem?: LiveHostPublisherFileSystem;
}

const SYSTEM_CLOCK: LiveHostPublisherClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timeout) => clearTimeout(timeout),
};

const SYSTEM_FILE_SYSTEM: LiveHostPublisherFileSystem = {
  mkdir: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
  readdir: (directory) => fs.readdir(directory),
  readFile: (file) => fs.readFile(file),
  writeFile: async (file, bytes) => { await fs.writeFile(file, bytes); },
  rename: async (source, destination) => { await fs.rename(source, destination); },
  rm: async (file) => { await fs.rm(file, { force: true }); },
  realpath: (file) => fs.realpath(file),
};

type PublisherState = "idle" | "started" | "closing" | "closed";

export class LiveHostRegistrationPublisher {
  readonly #options: LiveHostRegistrationPublisherOptions;
  readonly #clock: LiveHostPublisherClock;
  readonly #fileSystem: LiveHostPublisherFileSystem;
  readonly #randomUUID: () => string;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #runtimeRoot: string;
  readonly #instanceId: string;
  readonly #recordPath: string;
  #state: PublisherState = "idle";
  #timer: NodeJS.Timeout | undefined;
  #operation: Promise<void> = Promise.resolve();
  #closeOperation: Promise<void> | undefined;
  #canonicalBridge: Promise<{ extensionRoot: string; executable: string }> | undefined;

  constructor(options: LiveHostRegistrationPublisherOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#fileSystem = options.fileSystem ?? SYSTEM_FILE_SYSTEM;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#isProcessAlive = options.isProcessAlive ?? processAlive;
    this.#runtimeRoot = resolveRuntimeRegistryRoot(options.localAppData);
    this.#instanceId = this.#randomUUID();
    this.#recordPath = path.win32.join(this.#runtimeRoot, `${this.#instanceId}.json`);
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new Error("Live host registration publisher has already started.");
    }
    this.#state = "started";
    try {
      await this.#enqueue(() => this.#reconcile());
      this.#schedule();
    } catch (error) {
      this.#state = "closing";
      await this.#removeOwnedRecord();
      this.#state = "closed";
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closeOperation !== undefined) {
      return this.#closeOperation;
    }
    this.#state = "closing";
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#closeOperation = (async () => {
      await this.#operation;
      await this.#removeOwnedRecord();
      this.#state = "closed";
    })();
    return this.#closeOperation;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }

  #schedule(): void {
    if (this.#state !== "started") {
      return;
    }
    this.#timer = this.#clock.setTimeout(
      () => this.#heartbeat(),
      LIVE_HOST_HEARTBEAT_MS,
    );
  }

  async #heartbeat(): Promise<void> {
    this.#timer = undefined;
    if (this.#state !== "started") {
      return;
    }
    try {
      await this.#enqueue(() => this.#reconcile());
    } catch {
      await this.#removeOwnedRecord();
    } finally {
      this.#schedule();
    }
  }

  async #reconcile(): Promise<void> {
    await this.#fileSystem.mkdir(this.#runtimeRoot);
    await this.#pruneStaleRecords();
    const snapshot = safeWorkspaceSnapshot(this.#options.workspace);
    if (!snapshot.trusted || snapshot.roots.length === 0) {
      await this.#removeOwnedRecord();
      return;
    }
    const roots = await canonicalRoots(snapshot.roots, this.#fileSystem);
    if (roots.length === 0) {
      await this.#removeOwnedRecord();
      return;
    }
    const bridge = await this.#canonicalBridgePaths();
    const registration: LiveHostRegistrationV1 = Object.freeze({
      schemaVersion: 1,
      instanceId: this.#instanceId,
      ownerPid: this.#options.ownerPid,
      updatedAt: new Date(this.#clock.now()).toISOString(),
      workspaceRoots: roots,
      bridge: Object.freeze({
        version: this.#options.bridgeVersion,
        protocolVersion: 1,
        extensionRoot: bridge.extensionRoot,
        executable: bridge.executable,
        sha256: this.#options.bridgeSha256,
      }),
      pipe: Object.freeze({
        name: this.#options.descriptor.pipeName,
        token: this.#options.descriptor.token,
      }),
    });
    const bytes = Buffer.from(JSON.stringify(registration), "utf8");
    parseLiveHostRegistration(bytes);
    await this.#atomicWrite(bytes);
  }

  async #canonicalBridgePaths(): Promise<{ extensionRoot: string; executable: string }> {
    this.#canonicalBridge ??= (async () => {
      const extensionRoot = await this.#fileSystem.realpath(this.#options.extensionRoot);
      const executable = await this.#fileSystem.realpath(this.#options.bridgeExecutable);
      const expected = path.win32.join(extensionRoot, "dist", "mcp-bridge.exe");
      if (path.win32.normalize(expected).toLowerCase() !==
          path.win32.normalize(executable).toLowerCase()) {
        throw new Error("The packaged MCP bridge executable is invalid.");
      }
      return Object.freeze({ extensionRoot, executable });
    })();
    return this.#canonicalBridge;
  }

  async #atomicWrite(bytes: Buffer): Promise<void> {
    const temporary = path.win32.join(
      this.#runtimeRoot,
      `.${this.#instanceId}.${this.#randomUUID()}.tmp`,
    );
    try {
      await this.#fileSystem.writeFile(temporary, bytes);
      await this.#fileSystem.rename(temporary, this.#recordPath);
    } finally {
      await this.#fileSystem.rm(temporary);
    }
  }

  async #pruneStaleRecords(): Promise<void> {
    let names: string[];
    try {
      names = await this.#fileSystem.readdir(this.#runtimeRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === `${this.#instanceId}.json`) {
        continue;
      }
      const record = path.win32.join(this.#runtimeRoot, name);
      try {
        const registration = parseLiveHostRegistration(
          await this.#fileSystem.readFile(record),
        );
        const age = this.#clock.now() - Date.parse(registration.updatedAt);
        if (age > LIVE_HOST_STALE_MS && !this.#isProcessAlive(registration.ownerPid)) {
          await this.#fileSystem.rm(record);
        }
      } catch {
        // Unknown or malformed files are not owned by this publisher.
      }
    }
  }

  async #removeOwnedRecord(): Promise<void> {
    try {
      await this.#fileSystem.rm(this.#recordPath);
    } catch {
      // The owned record is already unavailable.
    }
  }
}

export async function verifyReviewedBridgeIntegrity(
  inventoryPath: string,
  bridgeExecutable: string,
): Promise<string> {
  try {
    const inventoryBytes = await fs.readFile(inventoryPath);
    if (inventoryBytes.byteLength === 0 || inventoryBytes.byteLength > 4_096) {
      throw new Error(INVENTORY_ERROR);
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(inventoryBytes),
    );
    if (!hasExactInventory(value)) {
      throw new Error(INVENTORY_ERROR);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(bridgeExecutable)) {
      hash.update(chunk as Buffer);
    }
    const actual = hash.digest("hex");
    if (actual !== value.sha256) {
      throw new Error(INVENTORY_ERROR);
    }
    return actual;
  } catch (error) {
    if (error instanceof Error && error.message === INVENTORY_ERROR) {
      throw error;
    }
    throw new Error(INVENTORY_ERROR);
  }
}

async function canonicalRoots(
  roots: readonly string[],
  fileSystem: LiveHostPublisherFileSystem,
): Promise<readonly string[]> {
  const canonical: string[] = [];
  const seen = new Set<string>();
  try {
    for (const root of roots) {
      const resolved = await fileSystem.realpath(root);
      const key = path.win32.normalize(resolved).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        canonical.push(resolved);
      }
    }
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(canonical);
}

function safeWorkspaceSnapshot(
  workspace: () => LiveHostWorkspaceSnapshot,
): LiveHostWorkspaceSnapshot {
  try {
    const snapshot = workspace();
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      typeof snapshot.trusted !== "boolean" ||
      !Array.isArray(snapshot.roots) ||
      !snapshot.roots.every((root) => typeof root === "string")
    ) {
      return { trusted: false, roots: [] };
    }
    return snapshot;
  } catch {
    return { trusted: false, roots: [] };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hasExactInventory(value: unknown): value is {
  readonly nodeVersion: "v26.5.0";
  readonly sha256: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "nodeVersion,sha256" &&
    record.nodeVersion === "v26.5.0" &&
    typeof record.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.sha256);
}
