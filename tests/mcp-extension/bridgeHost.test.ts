import { once } from "node:events";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BridgeHost,
  type BridgeConnectionContext,
  type BridgeDescriptor,
} from "../../mcp-extension/src/bridge/bridgeHost.js";
import { FrameDecoder, encodeFrame } from "../../mcp-extension/src/bridge/framing.js";

class FrameReader {
  readonly #decoder = new FrameDecoder();
  readonly #frames: unknown[] = [];
  readonly #waiters: Array<{
    resolve: (frame: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.on("data", (bytes) => {
      try {
        if (typeof bytes === "string") {
          throw new Error("Unexpected string data from bridge socket.");
        }
        for (const frame of this.#decoder.push(bytes)) {
          const waiter = this.#waiters.shift();
          if (waiter !== undefined) {
            waiter.resolve(frame);
          } else {
            this.#frames.push(frame);
          }
        }
      } catch (error) {
        this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => this.#rejectAll(error));
    socket.on("close", () => this.#rejectAll(new Error("Socket closed.")));
  }

  next(): Promise<unknown> {
    const frame = this.#frames.shift();
    if (frame !== undefined) {
      return Promise.resolve(frame);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #rejectAll(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

async function openSocket(descriptor: BridgeDescriptor): Promise<Socket> {
  const socket = createConnection(descriptor.pipeName);
  await once(socket, "connect");
  return socket;
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await once(socket, "close");
}

const hosts = new Set<BridgeHost>();
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all([...hosts].map(async (host) => host.close()));
  hosts.clear();
});

function createHost(
  callTool: (request: {
    readonly connectionId: string;
    readonly signal: AbortSignal;
    readonly name: "unity_debug_status";
    readonly input: unknown;
  }) => Promise<unknown> = async () => ({ ok: true }),
  onDisconnect?: (context: BridgeConnectionContext) => void | Promise<void>,
): BridgeHost {
  const host = new BridgeHost({
    handler: {
      callTool,
      onDisconnect,
    },
  });
  hosts.add(host);
  return host;
}

describe("BridgeHost", () => {
  it("shares one in-flight listen operation and binds exactly one pipe", async () => {
    const createdServers: Server[] = [];
    const host = new BridgeHost({
      createServer: (listener) => {
        const server = createServer(listener);
        createdServers.push(server);
        return server;
      },
      handler: { callTool: async () => ({ ok: true }) },
    });
    hosts.add(host);

    try {
      const first = host.listen();
      const second = host.listen();
      const third = host.listen();
      expect(second).toBe(first);
      expect(third).toBe(first);
      const descriptors = await Promise.all([first, second, third]);

      expect(createdServers).toHaveLength(1);
      expect(descriptors[1]).toBe(descriptors[0]);
      expect(descriptors[2]).toBe(descriptors[0]);
      expect(createdServers.filter((server) => server.listening)).toHaveLength(1);
    } finally {
      await host.close();
      await Promise.all(
        createdServers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
            }),
        ),
      );
    }
  });

  it("rejects every pending listener and leaves no stale pipe when closed during listen", async () => {
    let createdServer: Server | undefined;
    const host = new BridgeHost({
      createServer: (listener) => {
        createdServer = createServer(listener);
        return createdServer;
      },
      handler: { callTool: async () => ({ ok: true }) },
    });
    hosts.add(host);

    const first = host.listen();
    const second = host.listen();
    const closing = host.close();
    const results = await Promise.allSettled([first, second, closing]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
        "fulfilled",
      ]);
      await expect(host.listen()).rejects.toThrow("Bridge host is closed.");
      expect(createdServer?.listening).toBe(false);
    } finally {
      if (createdServer?.listening === true) {
        await new Promise<void>((resolve) => createdServer?.close(() => resolve()));
      }
    }
  });

  it("uses an immutable production descriptor with a random pipe and 32-byte token", async () => {
    const descriptor = await createHost().listen();

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(descriptor).toMatchObject({ protocolVersion: 1 });
    expect(descriptor.pipeName).toMatch(
      /^\\\\\.\\pipe\\unity-debugger-pure-mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Buffer.from(descriptor.token, "base64url")).toHaveLength(32);
    expect(descriptor.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("authenticates the correct token and disconnects a wrong token", async () => {
    const descriptor = await createHost().listen();
    const wrong = await openSocket(descriptor);
    sockets.add(wrong);
    wrong.write(
      encodeFrame({ type: "hello", protocolVersion: 1, token: "wrong-token" }),
    );
    await waitForClose(wrong);

    const correct = await openSocket(descriptor);
    sockets.add(correct);
    const reader = new FrameReader(correct);
    correct.write(
      encodeFrame({ type: "hello", protocolVersion: 1, token: descriptor.token }),
    );

    await expect(reader.next()).resolves.toEqual({
      type: "helloAck",
      protocolVersion: 1,
    });
  });

  it("never dispatches a request received before authentication", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const descriptor = await createHost(callTool).listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);

    socket.write(
      encodeFrame({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_status", input: {} },
      }),
    );
    await waitForClose(socket);

    expect(callTool).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid request received after authentication", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const descriptor = await createHost(callTool).listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const reader = new FrameReader(socket);
    socket.write(
      encodeFrame({ type: "hello", protocolVersion: 1, token: descriptor.token }),
    );
    await reader.next();

    socket.write(
      encodeFrame({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_unknown", input: {} },
      }),
    );
    await waitForClose(socket);

    expect(callTool).not.toHaveBeenCalled();
  });

  it("disconnects an unauthenticated socket after the five-second hello deadline", async () => {
    const descriptor = await createHost().listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const startedAt = Date.now();

    await waitForClose(socket);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(4_850);
    expect(elapsed).toBeLessThan(7_000);
  }, 8_000);

  it("invalidates a connection synchronously when its hello deadline expires", async () => {
    let expireHello: (() => void) | undefined;
    let acceptedSocket: Socket | undefined;
    let markAccepted!: () => void;
    const connectionAccepted = new Promise<void>((resolve) => {
      markAccepted = resolve;
    });
    const callTool = vi.fn(async () => ({ ok: true }));
    const host = new BridgeHost({
      clock: {
        setTimeout: (callback) => {
          expireHello = callback;
          return { fake: true } as unknown as NodeJS.Timeout;
        },
        clearTimeout: () => undefined,
      },
      createServer: (listener) =>
        createServer((socket) => {
          acceptedSocket = socket;
          listener(socket);
          markAccepted();
        }),
      handler: { callTool },
    });
    hosts.add(host);
    const descriptor = await host.listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    await connectionAccepted;
    const bytes = Buffer.concat([
      encodeFrame({ type: "hello", protocolVersion: 1, token: descriptor.token }),
      encodeFrame({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_status", input: {} },
      }),
    ]);

    expireHello?.();
    acceptedSocket?.emit("data", bytes);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(callTool).not.toHaveBeenCalled();
    expect(acceptedSocket?.destroyed).toBe(true);
  });

  it("fails closed when a peer declares an oversized frame", async () => {
    const descriptor = await createHost().listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(1_048_577);

    socket.write(header);
    await waitForClose(socket);
  });

  it("fails closed instead of throwing on a server error after listening", async () => {
    let server: Server | undefined;
    const host = new BridgeHost({
      createServer: (listener) => {
        server = createServer(listener);
        return server;
      },
      handler: { callTool: async () => ({ ok: true }) },
    });
    hosts.add(host);
    const descriptor = await host.listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const closed = once(socket, "close");

    expect(() => server?.emit("error", new Error("runtime server failure"))).not.toThrow();
    await closed;
    await host.close();
  });

  it("accepts split hello bytes followed by coalesced authenticated requests", async () => {
    const callTool = vi.fn(async ({ input }: { readonly input: unknown }) => input);
    const descriptor = await createHost(callTool).listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const reader = new FrameReader(socket);
    const hello = encodeFrame({
      type: "hello",
      protocolVersion: 1,
      token: descriptor.token,
    });
    const first = encodeFrame({
      type: "request",
      id: "request-1",
      method: "callTool",
      params: { name: "unity_debug_status", input: { ordinal: 1 } },
    });
    const second = encodeFrame({
      type: "request",
      id: "request-2",
      method: "callTool",
      params: { name: "unity_debug_status", input: { ordinal: 2 } },
    });

    socket.write(hello.subarray(0, 2));
    socket.write(Buffer.concat([hello.subarray(2), first, second]));

    await expect(reader.next()).resolves.toEqual({ type: "helloAck", protocolVersion: 1 });
    const responses = [await reader.next(), await reader.next()];
    expect(responses).toEqual(
      expect.arrayContaining([
        { type: "response", id: "request-1", result: { ordinal: 1 } },
        { type: "response", id: "request-2", result: { ordinal: 2 } },
      ]),
    );
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("aborts the authenticated connection and invokes its disconnect hook on host close", async () => {
    let requestContext:
      | { readonly connectionId: string; readonly signal: AbortSignal }
      | undefined;
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disconnectContext: BridgeConnectionContext | undefined;
    const host = createHost(
      async (request) => {
        requestContext = request;
        entered();
        return new Promise(() => undefined);
      },
      (context) => {
        disconnectContext = context;
      },
    );
    const descriptor = await host.listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const reader = new FrameReader(socket);
    socket.write(
      encodeFrame({ type: "hello", protocolVersion: 1, token: descriptor.token }),
    );
    await reader.next();
    socket.write(
      encodeFrame({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_status", input: {} },
      }),
    );
    await requestEntered;

    await host.close();
    await waitForClose(socket);

    expect(requestContext?.signal.aborted).toBe(true);
    expect(disconnectContext?.connectionId).toBe(requestContext?.connectionId);
    expect(disconnectContext?.signal.aborted).toBe(true);
  });

  it("waits for asynchronous authenticated disconnect cleanup before close resolves", async () => {
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const host = createHost(async () => ({ ok: true }), async () => cleanupBlocked);
    const descriptor = await host.listen();
    const socket = await openSocket(descriptor);
    sockets.add(socket);
    const reader = new FrameReader(socket);
    socket.write(
      encodeFrame({ type: "hello", protocolVersion: 1, token: descriptor.token }),
    );
    await reader.next();

    let closeResolved = false;
    const closing = host.close().then(() => {
      closeResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closeResolved).toBe(false);
    releaseCleanup();
    await closing;
    expect(closeResolved).toBe(true);
  });
});
