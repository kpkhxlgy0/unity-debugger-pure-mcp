import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BridgeHost, type BridgeToolHandler } from "../../src/bridge/bridgeHost.js";
import { TOOL_NAMES } from "../../src/bridge/protocol.js";
import { bridgeUnavailableError } from "../../src/tools/errors.js";
import {
  createExternalTransport,
  ensureSeaBuilt,
  success,
  toolError,
  waitFor,
  waitForProcessExit,
  writeRegistration,
} from "./integrationSupport.js";

const temporaryDirectories: string[] = [];

beforeAll(() => ensureSeaBuilt(), 60_000);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe("external uvx-style launcher", () => {
  it("keeps MCP stdio alive across host loss and reconnects only the next call", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "udp external 测试 "));
    temporaryDirectories.push(base);
    const workspace = path.join(base, "Unity Project with spaces 测试");
    const localAppData = path.join(base, "Local App Data");
    await fs.mkdir(workspace, { recursive: true });

    let interruptedCalls = 0;
    const firstHandler: BridgeToolHandler = {
      async callTool({ name, signal }) {
        if (name === "unity_debug_status") {
          return attachedStatus(1);
        }
        if (name === "unity_debug_set_exception_breakpoints") {
          return { sessionRef: "session-fixture", mode: "all" };
        }
        if (name === "unity_debug_continue") {
          interruptedCalls += 1;
          return await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(bridgeUnavailableError()),
              { once: true },
            );
          });
        }
        return attachedStatus(1);
      },
    };
    const firstHost = new BridgeHost({ handler: firstHandler });
    const firstDescriptor = await firstHost.listen();
    const registration = await writeRegistration({
      localAppData,
      workspace,
      descriptor: firstDescriptor,
    });
    const transport = createExternalTransport({ workspace, localAppData });
    const client = new Client({ name: "external-launcher-test", version: "1.0.0" });
    let secondHost: BridgeHost | undefined;
    let launcherPid: number | null = null;

    try {
      await client.connect(transport, { timeout: 15_000 });
      launcherPid = transport.pid;
      expect(launcherPid).not.toBeNull();
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([...TOOL_NAMES]);
      await expect(success(client, "unity_debug_status", {})).resolves.toMatchObject({
        session: { sessionRef: "session-fixture", tracked: true },
        state: "stopped",
      });
      await expect(success(client, "unity_debug_set_exception_breakpoints", {
        sessionRef: "session-fixture",
        mode: "all",
      })).resolves.toEqual({ sessionRef: "session-fixture", mode: "all" });

      const interrupted = toolError(client, "unity_debug_continue", {
        sessionRef: "session-fixture",
      });
      await waitFor(() => interruptedCalls === 1);
      await firstHost.close();
      await expect(interrupted).resolves.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
      expect(interruptedCalls).toBe(1);

      secondHost = new BridgeHost({
        handler: {
          async callTool() {
            return attachedStatus(2);
          },
        },
      });
      const secondDescriptor = await secondHost.listen();
      await writeRegistration({
        localAppData,
        workspace,
        descriptor: secondDescriptor,
        registrationPath: registration,
      });
      await expect(success(client, "unity_debug_status", {})).resolves.toMatchObject({
        eventSequence: 2,
      });

      await secondHost.close();
      secondHost = undefined;
      await expect(toolError(client, "unity_debug_status", {})).resolves.toMatchObject({
        code: "BRIDGE_UNAVAILABLE",
      });
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([...TOOL_NAMES]);
    } finally {
      await client.close().catch(() => undefined);
      if (launcherPid !== null) {
        await waitForProcessExit(launcherPid);
      }
      await firstHost.close();
      await secondHost?.close();
    }
  }, 60_000);
});

function attachedStatus(eventSequence: number): Record<string, unknown> {
  return {
    session: { sessionRef: "session-fixture", tracked: true },
    state: "stopped",
    stopGeneration: 1,
    eventSequence,
  };
}
