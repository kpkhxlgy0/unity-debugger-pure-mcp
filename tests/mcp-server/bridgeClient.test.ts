import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BridgeHost,
  type BridgeDescriptor,
  type BridgeToolRequest,
} from "../../mcp-extension/src/bridge/bridgeHost.js";
import { FrameDecoder, encodeFrame } from "../../mcp-extension/src/bridge/framing.js";
import {
  CLIENT_FRAME_SCHEMA,
  SERVER_FRAME_SCHEMA,
} from "../../mcp-extension/src/bridge/protocol.js";
import {
  BridgeCallError,
  BridgeClient,
} from "../../mcp-server/src/bridgeClient.js";

const hosts = new Set<BridgeHost>();
const clients = new Set<BridgeClient>();
const servers = new Set<Server>();

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.clear();
  await Promise.all([...hosts].map(async (host) => host.close()));
  hosts.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function startHost(
  callTool: Parameters<typeof createTestHost>[0],
): Promise<{ readonly host: BridgeHost; readonly descriptor: BridgeDescriptor }> {
  const host = createTestHost(callTool);
  return { host, descriptor: await host.listen() };
}

function createTestHost(
  callTool: (request: {
    readonly connectionId: string;
    readonly signal: AbortSignal;
    readonly name: "unity_debug_status";
    readonly input: unknown;
  }) => Promise<unknown>,
): BridgeHost {
  const host = new BridgeHost({ handler: { callTool } });
  hosts.add(host);
  return host;
}

async function connect(descriptor: BridgeDescriptor): Promise<BridgeClient> {
  const client = await BridgeClient.connect(descriptor);
  clients.add(client);
  return client;
}

describe("BridgeClient", () => {
  it("authenticates once and reuses the socket for correlated tool calls", async () => {
    const callTool = vi.fn(async ({ input }: BridgeToolRequest) => input);
    const { descriptor } = await startHost(callTool);
    const client = await connect(descriptor);

    await expect(client.callTool("unity_debug_status", { ordinal: 1 })).resolves.toEqual({
      ordinal: 1,
    });
    await expect(client.callTool("unity_debug_status", { ordinal: 2 })).resolves.toEqual({
      ordinal: 2,
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls[0]?.[0].connectionId).toBe(
      callTool.mock.calls[1]?.[0].connectionId,
    );
  });

  it("does not send a pre-aborted call", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const { descriptor } = await startHost(callTool);
    const client = await connect(descriptor);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.callTool("unity_debug_status", {}, controller.signal),
    ).rejects.toMatchObject({
      detail: { code: "CANCELLED" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps the required input field on the wire when the caller supplies undefined", async () => {
    const callTool = vi.fn(async ({ input }: BridgeToolRequest) => input);
    const { descriptor } = await startHost(callTool);
    const client = await connect(descriptor);

    await expect(client.callTool("unity_debug_status", undefined)).resolves.toBeNull();
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ input: null }));
  });

  it("returns a sanitized structured error when the host handler throws unexpectedly", async () => {
    const { descriptor } = await startHost(async () => {
      throw new Error("sensitive expression and source path");
    });
    const client = await connect(descriptor);

    await expect(client.callTool("unity_debug_status", {})).rejects.toMatchObject({
      detail: {
        code: "DAP_FAILURE",
        message: "The debugger request failed.",
        retryable: false,
      },
    });
    await expect(client.callTool("unity_debug_status", {})).rejects.not.toThrow(
      /sensitive|source path/i,
    );
  });

  it("sanitizes a hostile thrown object whose fields cannot be inspected", async () => {
    const hostileError = new Proxy(
      {},
      {
        get: () => {
          throw new Error("hostile getter");
        },
        ownKeys: () => {
          throw new Error("hostile keys");
        },
      },
    );
    const { descriptor } = await startHost(async () => {
      throw hostileError;
    });
    const client = await connect(descriptor);
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("response timed out")), 500);
    });

    try {
      await expect(
        Promise.race([client.callTool("unity_debug_status", {}), deadline]),
      ).rejects.toMatchObject({
        detail: {
          code: "DAP_FAILURE",
          message: "The debugger request failed.",
        },
      });
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  });

  it("rejects a cancelled pending call, deletes it, and ignores its late response", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const { descriptor } = await startHost(async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await firstBlocked;
      }
      return input;
    });
    const client = await connect(descriptor);
    const controller = new AbortController();
    const cancelled = client.callTool(
      "unity_debug_status",
      { ordinal: 1 },
      controller.signal,
    );
    await firstEntered;

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(BridgeCallError);
    await expect(cancelled).rejects.toMatchObject({ detail: { code: "CANCELLED" } });
    releaseFirst();
    await expect(client.callTool("unity_debug_status", { ordinal: 2 })).resolves.toEqual({
      ordinal: 2,
    });
  });

  it("rejects all pending calls when the host closes", async () => {
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host, descriptor } = await startHost(async () => {
      entered();
      return new Promise(() => undefined);
    });
    const client = await connect(descriptor);
    const pending = client.callTool("unity_debug_status", {});
    await requestEntered;

    await host.close();

    await expect(pending).rejects.toMatchObject({
      detail: { code: "BRIDGE_UNAVAILABLE" },
    });
  });

  it("ignores unknown and duplicate responses without corrupting later calls", async () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    const pipeName = `\\\\.\\pipe\\unity-debugger-pure-mcp-client-test-${randomUUID()}`;
    let firstResponseId: string | undefined;
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (bytes) => {
        if (typeof bytes === "string") {
          socket.destroy();
          return;
        }
        for (const decoded of decoder.push(bytes)) {
          const frame = CLIENT_FRAME_SCHEMA.parse(decoded);
          if (frame.type === "hello") {
            socket.write(
              encodeFrame(
                SERVER_FRAME_SCHEMA.parse({ type: "helloAck", protocolVersion: 1 }),
              ),
            );
            continue;
          }
          if (firstResponseId === undefined) {
            firstResponseId = frame.id;
            socket.write(
              Buffer.concat([
                encodeFrame(
                  SERVER_FRAME_SCHEMA.parse({
                    type: "response",
                    id: "unknown-request",
                    result: { ignored: true },
                  }),
                ),
                encodeFrame(
                  SERVER_FRAME_SCHEMA.parse({
                    type: "response",
                    id: frame.id,
                    result: { ordinal: 1 },
                  }),
                ),
                encodeFrame(
                  SERVER_FRAME_SCHEMA.parse({
                    type: "response",
                    id: frame.id,
                    result: { duplicate: true },
                  }),
                ),
              ]),
            );
          } else {
            socket.write(
              encodeFrame(
                SERVER_FRAME_SCHEMA.parse({
                  type: "response",
                  id: frame.id,
                  result: { ordinal: 2 },
                }),
              ),
            );
          }
        }
      });
    });
    servers.add(server);
    server.listen({ path: pipeName, readableAll: false, writableAll: false });
    await once(server, "listening");
    const client = await connect(
      Object.freeze({ protocolVersion: 1, pipeName, token } as const),
    );

    await expect(client.callTool("unity_debug_status", {})).resolves.toEqual({ ordinal: 1 });
    await expect(client.callTool("unity_debug_status", {})).resolves.toEqual({ ordinal: 2 });
  });
});
