import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BridgeHost, type BridgeToolHandler } from "../../src/bridge/bridgeHost.js";
import { SessionCommandQueue } from "../../src/debug/commandQueue.js";
import { staleReferenceError } from "../../src/tools/errors.js";
import {
  createDirectTransport,
  createRegistryTransport,
  ensureSeaBuilt,
  success,
  toolError,
  waitForProcessExit,
  writeRegistration,
} from "./integrationSupport.js";

const temporaryDirectories: string[] = [];

beforeAll(() => ensureSeaBuilt(), 60_000);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe("direct and registry MCP clients", () => {
  it("share one fair write queue and one reference generation", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "udp dual clients "));
    temporaryDirectories.push(base);
    const workspace = path.join(base, "Unity Project");
    const localAppData = path.join(base, "Local App Data");
    await fs.mkdir(workspace, { recursive: true });
    const queue = new SessionCommandQueue();
    let generation = 1;
    let eventSequence = 1;
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let disconnectedClients = 0;
    const handler: BridgeToolHandler = {
      async callTool({ name, input }) {
        if (name === "unity_debug_status") {
          return status(generation, eventSequence);
        }
        if (name === "unity_debug_threads") {
          return {
            ...metadata(generation, eventSequence),
            threads: [{ threadRef: `thread-${generation}`, name: "Main Thread" }],
          };
        }
        if (name === "unity_debug_stack_trace") {
          const threadRef = (input as { readonly threadRef?: unknown }).threadRef;
          if (threadRef !== `thread-${generation}`) {
            throw staleReferenceError();
          }
          return {
            ...metadata(generation, eventSequence),
            totalFrames: 1,
            frames: [{ frameRef: `frame-${generation}`, name: "Update", line: 1, column: 1 }],
          };
        }
        if (name === "unity_debug_continue") {
          return await queue.write("shared-session", async () => {
            activeWrites += 1;
            maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
            await new Promise((resolve) => setTimeout(resolve, 30));
            generation += 1;
            eventSequence += 1;
            activeWrites -= 1;
            return {
              sessionRef: "shared-session",
              state: "running",
              stopGeneration: generation,
              eventSequence,
              transitioning: false,
            };
          });
        }
        return status(generation, eventSequence);
      },
      onDisconnect() {
        disconnectedClients += 1;
      },
    };
    const host = new BridgeHost({ handler });
    const descriptor = await host.listen();
    const registrationPath = await writeRegistration({
      localAppData,
      workspace,
      descriptor,
    });
    const direct = new Client({ name: "direct-client", version: "1.0.0" });
    const registry = new Client({ name: "registry-client", version: "1.0.0" });
    const directTransport = createDirectTransport({ workspace, descriptor });
    const registryTransport = createRegistryTransport({
      workspace,
      localAppData,
      registrationPath,
    });
    let directPid: number | null = null;
    let registryPid: number | null = null;

    try {
      await Promise.all([
        direct.connect(directTransport, { timeout: 10_000 }),
        registry.connect(registryTransport, { timeout: 10_000 }),
      ]);
      directPid = directTransport.pid;
      registryPid = registryTransport.pid;
      expect(directPid).not.toBeNull();
      expect(registryPid).not.toBeNull();
      const [directThreads, registryThreads] = await Promise.all([
        success(direct, "unity_debug_threads", { sessionRef: "shared-session" }),
        success(registry, "unity_debug_threads", { sessionRef: "shared-session" }),
      ]);
      const directRef = (directThreads.threads as Array<{ threadRef: string }>)[0]!.threadRef;
      const registryRef = (registryThreads.threads as Array<{ threadRef: string }>)[0]!.threadRef;
      expect(directRef).toBe("thread-1");
      expect(registryRef).toBe("thread-1");

      await Promise.all([
        success(direct, "unity_debug_continue", { sessionRef: "shared-session" }),
        success(registry, "unity_debug_continue", { sessionRef: "shared-session" }),
      ]);
      expect(maximumActiveWrites).toBe(1);
      await expect(toolError(direct, "unity_debug_stack_trace", {
        sessionRef: "shared-session",
        threadRef: directRef,
      })).resolves.toMatchObject({ code: "STALE_REFERENCE" });
      await expect(toolError(registry, "unity_debug_stack_trace", {
        sessionRef: "shared-session",
        threadRef: registryRef,
      })).resolves.toMatchObject({ code: "STALE_REFERENCE" });

      await direct.close();
      await expect(success(registry, "unity_debug_status", {})).resolves.toMatchObject({
        session: { sessionRef: "shared-session" },
        stopGeneration: 3,
      });
      expect(disconnectedClients).toBeGreaterThanOrEqual(1);
    } finally {
      await direct.close().catch(() => undefined);
      await registry.close().catch(() => undefined);
      await Promise.all([
        directPid === null ? Promise.resolve() : waitForProcessExit(directPid),
        registryPid === null ? Promise.resolve() : waitForProcessExit(registryPid),
      ]);
      await host.close();
    }
  }, 60_000);
});

function metadata(stopGeneration: number, eventSequence: number) {
  return {
    sessionRef: "shared-session",
    state: "stopped" as const,
    stopGeneration,
    eventSequence,
  };
}

function status(stopGeneration: number, eventSequence: number) {
  return {
    session: { sessionRef: "shared-session", tracked: true },
    state: stopGeneration === 1 ? "stopped" : "running",
    stopGeneration,
    eventSequence,
  };
}
