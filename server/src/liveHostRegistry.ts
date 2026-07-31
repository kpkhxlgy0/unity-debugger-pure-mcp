import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeDescriptor } from "../../src/bridge/bridgeHost.js";
import {
  LIVE_HOST_HEARTBEAT_MS,
  LIVE_HOST_STALE_MS,
  canonicalPathContains,
  parseLiveHostRegistration,
  resolveRuntimeRegistryRoot,
  type LiveHostRegistrationV1,
} from "../../src/external/liveHostRegistration.js";
import {
  ambiguousBridgeError,
  bridgeUnavailableError,
} from "../../src/tools/errors.js";
import { BridgeCallError } from "./bridgeClient.js";

export interface LiveHostRegistryOptions {
  readonly runtimeRoot: string;
  readonly clientRoot: string;
  readonly runningExecutable: string;
  readonly localAppData?: string;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

interface CanonicalRegistryContext {
  readonly runtimeRoot: string;
  readonly clientRoot: string;
  readonly runningExecutable: string;
}

export class LiveHostRegistry {
  readonly #options: LiveHostRegistryOptions;
  readonly #now: () => number;
  readonly #isProcessAlive: (pid: number) => boolean;

  constructor(options: LiveHostRegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? processAlive;
  }

  async locate(): Promise<BridgeDescriptor> {
    let context: CanonicalRegistryContext;
    try {
      context = await this.#canonicalContext();
    } catch {
      throw new BridgeCallError(bridgeUnavailableError());
    }

    const matches: LiveHostRegistrationV1[] = [];
    let names: string[];
    try {
      names = await fs.readdir(context.runtimeRoot);
    } catch {
      throw new BridgeCallError(bridgeUnavailableError());
    }
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const registration = parseLiveHostRegistration(
          await fs.readFile(path.join(context.runtimeRoot, name)),
        );
        if (await this.#matches(registration, context)) {
          matches.push(registration);
        }
      } catch {
        // Each file is an untrusted current-user registration candidate.
      }
    }
    if (matches.length === 0) {
      throw new BridgeCallError(bridgeUnavailableError());
    }
    if (matches.length !== 1) {
      throw new BridgeCallError(ambiguousBridgeError());
    }
    const registration = matches[0]!;
    return Object.freeze({
      protocolVersion: 1,
      pipeName: registration.pipe.name,
      token: registration.pipe.token,
    });
  }

  async #canonicalContext(): Promise<CanonicalRegistryContext> {
    const localAppData = this.#options.localAppData ?? process.env.LOCALAPPDATA ?? "";
    const expectedRoot = resolveRuntimeRegistryRoot(localAppData);
    const [runtimeRoot, canonicalExpected, clientRoot, runningExecutable] =
      await Promise.all([
        fs.realpath(this.#options.runtimeRoot),
        fs.realpath(expectedRoot),
        fs.realpath(this.#options.clientRoot),
        fs.realpath(this.#options.runningExecutable),
      ]);
    if (!samePath(runtimeRoot, canonicalExpected)) {
      throw new Error("Unexpected registry root.");
    }
    return Object.freeze({ runtimeRoot, clientRoot, runningExecutable });
  }

  async #matches(
    registration: LiveHostRegistrationV1,
    context: CanonicalRegistryContext,
  ): Promise<boolean> {
    const age = this.#now() - Date.parse(registration.updatedAt);
    if (
      age > LIVE_HOST_STALE_MS ||
      age < -LIVE_HOST_HEARTBEAT_MS ||
      !this.#isProcessAlive(registration.ownerPid)
    ) {
      return false;
    }
    const roots = await Promise.all(
      registration.workspaceRoots.map((root) => fs.realpath(root)),
    );
    if (!roots.some((root) => canonicalPathContains(root, context.clientRoot))) {
      return false;
    }
    const [extensionRoot, executable] = await Promise.all([
      fs.realpath(registration.bridge.extensionRoot),
      fs.realpath(registration.bridge.executable),
    ]);
    const expectedExecutable = path.win32.join(
      extensionRoot,
      "dist",
      "mcp-bridge.exe",
    );
    if (
      !samePath(executable, expectedExecutable) ||
      !samePath(executable, context.runningExecutable)
    ) {
      return false;
    }
    const status = await fs.stat(executable);
    if (!status.isFile()) {
      return false;
    }
    return await sha256(executable) === registration.bridge.sha256;
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function samePath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase() ===
    path.win32.normalize(right).toLowerCase();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
