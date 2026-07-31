import { describe, expect, it } from "vitest";

import type { BridgeDescriptor } from "../../src/bridge/bridgeHost.js";
import type { ToolName } from "../../src/bridge/protocol.js";
import { bridgeUnavailableError, cancelledError } from "../../src/tools/errors.js";
import { BridgeCallError } from "../../server/src/bridgeClient.js";
import {
  RegistryBridgeClient,
  type BridgeClientConnection,
  type BridgeClientFactory,
  type LiveHostLocator,
} from "../../server/src/registryBridgeClient.js";

const DESCRIPTOR: BridgeDescriptor = Object.freeze({
  protocolVersion: 1,
  pipeName: "\\\\.\\pipe\\unity-debugger-pure-mcp-registry-client-fixture",
  token: Buffer.alloc(32, 0x34).toString("base64url"),
});

class FakeConnection implements BridgeClientConnection {
  ready = true;
  readonly calls: Array<{ name: ToolName; input: unknown; signal?: AbortSignal }> = [];
  result: unknown = { session: null, state: "not-attached", eventSequence: 0 };
  failure: BridgeCallError | undefined;
  closed = false;

  async callTool(name: ToolName, input: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ name, input, signal });
    if (signal?.aborted) {
      throw new BridgeCallError(cancelledError());
    }
    if (this.failure !== undefined) {
      this.ready = false;
      throw this.failure;
    }
    return this.result;
  }

  close(): void {
    this.closed = true;
    this.ready = false;
  }
}

function harness() {
  const located: BridgeDescriptor[] = [];
  const connections: FakeConnection[] = [];
  let locateCalls = 0;
  let connectCalls = 0;
  const locator: LiveHostLocator = {
    async locate() {
      locateCalls += 1;
      located.push(DESCRIPTOR);
      return DESCRIPTOR;
    },
  };
  const factory: BridgeClientFactory = {
    async connect(descriptor) {
      connectCalls += 1;
      expect(descriptor).toBe(DESCRIPTOR);
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  };
  return {
    connections,
    factory,
    locator,
    counts: () => ({ connectCalls, locateCalls }),
  };
}

describe("RegistryBridgeClient", () => {
  it("connects initially and reuses one ready client", async () => {
    const setup = harness();
    const bridge = await RegistryBridgeClient.connect(setup.locator, setup.factory);

    await bridge.callTool("unity_debug_status", { ordinal: 1 });
    await bridge.callTool("unity_debug_status", { ordinal: 2 });

    expect(setup.counts()).toEqual({ connectCalls: 1, locateCalls: 1 });
    expect(setup.connections[0]?.calls.map(({ input }) => input)).toEqual([
      { ordinal: 1 },
      { ordinal: 2 },
    ]);
  });

  it("shares one reconnect when concurrent calls begin after disconnection", async () => {
    const setup = harness();
    const bridge = await RegistryBridgeClient.connect(setup.locator, setup.factory);
    setup.connections[0]!.ready = false;

    await Promise.all([
      bridge.callTool("unity_debug_status", { ordinal: 1 }),
      bridge.callTool("unity_debug_status", { ordinal: 2 }),
    ]);

    expect(setup.counts()).toEqual({ connectCalls: 2, locateCalls: 2 });
    expect(setup.connections[1]?.calls).toHaveLength(2);
  });

  it("does not replay an in-flight call that loses its connection", async () => {
    const setup = harness();
    const bridge = await RegistryBridgeClient.connect(setup.locator, setup.factory);
    setup.connections[0]!.failure = new BridgeCallError(bridgeUnavailableError());

    await expect(bridge.callTool("unity_debug_continue", {})).rejects.toMatchObject({
      detail: { code: "BRIDGE_UNAVAILABLE" },
    });
    expect(setup.counts()).toEqual({ connectCalls: 1, locateCalls: 1 });
    expect(setup.connections[0]?.calls).toHaveLength(1);

    await expect(bridge.callTool("unity_debug_status", {})).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
    expect(setup.counts()).toEqual({ connectCalls: 2, locateCalls: 2 });
    expect(setup.connections[1]?.calls).toHaveLength(1);
  });

  it("does not send a call cancelled while reconnecting", async () => {
    const setup = harness();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    let connectionNumber = 0;
    const factory: BridgeClientFactory = {
      async connect() {
        connectionNumber += 1;
        if (connectionNumber === 2) {
          await connectGate;
        }
        const connection = new FakeConnection();
        setup.connections.push(connection);
        return connection;
      },
    };
    const bridge = await RegistryBridgeClient.connect(setup.locator, factory);
    setup.connections[0]!.ready = false;
    const controller = new AbortController();
    const pending = bridge.callTool("unity_debug_status", {}, controller.signal);
    controller.abort();
    releaseConnect();

    await expect(pending).rejects.toMatchObject({ detail: { code: "CANCELLED" } });
    expect(setup.connections[1]?.calls).toHaveLength(0);
  });

  it("closes a connection that finishes after the registry client is closed", async () => {
    const setup = harness();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    let connectionNumber = 0;
    const factory: BridgeClientFactory = {
      async connect() {
        connectionNumber += 1;
        if (connectionNumber === 2) {
          await connectGate;
        }
        const connection = new FakeConnection();
        setup.connections.push(connection);
        return connection;
      },
    };
    const bridge = await RegistryBridgeClient.connect(setup.locator, factory);
    setup.connections[0]!.ready = false;
    const pending = bridge.callTool("unity_debug_status", {});

    bridge.close();
    releaseConnect();

    await expect(pending).rejects.toMatchObject({ detail: { code: "BRIDGE_UNAVAILABLE" } });
    expect(setup.connections[1]?.closed).toBe(true);
  });
});
