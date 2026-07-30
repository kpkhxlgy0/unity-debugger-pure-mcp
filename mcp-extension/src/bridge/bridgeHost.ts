import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer as nodeCreateServer,
  type Server,
  type Socket,
} from "node:net";

import {
  CLIENT_FRAME_SCHEMA,
  SERVER_FRAME_SCHEMA,
  type ServerFrame,
  type ToolName,
} from "./protocol.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import {
  STRUCTURED_TOOL_ERROR_SCHEMA,
  dapFailureError,
  type StructuredToolError,
} from "../tools/errors.js";

const HELLO_TIMEOUT_MS = 5_000;

export interface BridgeDescriptor {
  readonly protocolVersion: 1;
  readonly pipeName: string;
  readonly token: string;
}

export interface BridgeConnectionContext {
  readonly connectionId: string;
  readonly signal: AbortSignal;
}

export interface BridgeToolRequest extends BridgeConnectionContext {
  readonly name: ToolName;
  readonly input: unknown;
}

export interface BridgeToolHandler {
  callTool(request: BridgeToolRequest): Promise<unknown>;
  onDisconnect?(context: BridgeConnectionContext): void | Promise<void>;
}

export interface BridgeClock {
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimeout(timeout: NodeJS.Timeout): void;
}

export interface BridgeHostOptions {
  readonly handler: BridgeToolHandler;
  readonly createServer?: (connectionListener: (socket: Socket) => void) => Server;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => `${string}-${string}-${string}-${string}-${string}`;
  readonly clock?: BridgeClock;
}

interface HostConnection {
  readonly socket: Socket;
  readonly connectionId: string;
  readonly abortController: AbortController;
  readonly decoder: FrameDecoder;
  helloTimeout: NodeJS.Timeout | undefined;
  authenticated: boolean;
  disconnected: boolean;
}

const SYSTEM_CLOCK: BridgeClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timeout) => clearTimeout(timeout),
};

export class BridgeHost {
  readonly #handler: BridgeToolHandler;
  readonly #createServer: (connectionListener: (socket: Socket) => void) => Server;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
  readonly #clock: BridgeClock;
  readonly #connections = new Set<HostConnection>();
  readonly #disconnectCleanups = new Set<Promise<void>>();
  #server: Server | undefined;
  #descriptor: BridgeDescriptor | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: BridgeHostOptions) {
    this.#handler = options.handler;
    this.#createServer = options.createServer ?? nodeCreateServer;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  async listen(): Promise<BridgeDescriptor> {
    if (this.#descriptor !== undefined) {
      return this.#descriptor;
    }
    if (this.#closing !== undefined) {
      throw new Error("Bridge host is closed.");
    }

    const descriptor = Object.freeze({
      protocolVersion: 1 as const,
      pipeName: `\\\\.\\pipe\\unity-debugger-pure-mcp-${this.#randomUUID()}`,
      token: this.#randomBytes(32).toString("base64url"),
    });
    const server = this.#createServer((socket) => this.#accept(socket, descriptor.token));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onRuntimeError = (): void => {
        void this.close();
      };
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.#server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.on("error", onRuntimeError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        path: descriptor.pipeName,
        readableAll: false,
        writableAll: false,
      });
    });

    this.#descriptor = descriptor;
    return descriptor;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) {
      return this.#closing;
    }
    this.#closing = this.#closeResources();
    return this.#closing;
  }

  async #closeResources(): Promise<void> {
    for (const connection of [...this.#connections]) {
      connection.socket.destroy();
      this.#disconnect(connection);
    }
    const server = this.#server;
    this.#server = undefined;
    this.#descriptor = undefined;
    if (server === undefined || !server.listening) {
      await Promise.all([...this.#disconnectCleanups]);
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await Promise.all([...this.#disconnectCleanups]);
  }

  #accept(socket: Socket, token: string): void {
    const connection: HostConnection = {
      socket,
      connectionId: this.#randomUUID(),
      abortController: new AbortController(),
      decoder: new FrameDecoder(),
      helloTimeout: undefined,
      authenticated: false,
      disconnected: false,
    };
    this.#connections.add(connection);
    connection.helloTimeout = this.#clock.setTimeout(() => {
      connection.helloTimeout = undefined;
      if (!connection.authenticated) {
        socket.destroy();
      }
    }, HELLO_TIMEOUT_MS);

    socket.on("data", (bytes) => {
      if (typeof bytes === "string") {
        socket.destroy();
        return;
      }
      this.#receive(connection, token, bytes);
    });
    socket.once("close", () => this.#disconnect(connection));
    socket.on("error", () => {
      socket.destroy();
    });
  }

  #receive(connection: HostConnection, token: string, bytes: Buffer): void {
    if (connection.disconnected) {
      return;
    }
    let decodedFrames: unknown[];
    try {
      decodedFrames = connection.decoder.push(bytes);
    } catch {
      connection.socket.destroy();
      return;
    }

    for (const decoded of decodedFrames) {
      const parsed = CLIENT_FRAME_SCHEMA.safeParse(decoded);
      if (!parsed.success) {
        connection.socket.destroy();
        return;
      }
      const frame = parsed.data;
      if (!connection.authenticated) {
        if (frame.type !== "hello" || !tokensEqual(frame.token, token)) {
          connection.socket.destroy();
          return;
        }
        connection.authenticated = true;
        this.#clearHelloTimeout(connection);
        this.#write(connection, { type: "helloAck", protocolVersion: 1 });
        continue;
      }
      if (frame.type !== "request") {
        connection.socket.destroy();
        return;
      }
      void this.#dispatch(connection, frame.id, frame.params.name, frame.params.input);
    }
  }

  async #dispatch(
    connection: HostConnection,
    id: string,
    name: ToolName,
    input: unknown,
  ): Promise<void> {
    try {
      const result = await this.#handler.callTool({
        connectionId: connection.connectionId,
        signal: connection.abortController.signal,
        name,
        input,
      });
      this.#write(connection, { type: "response", id, result: result ?? null });
    } catch (error) {
      this.#write(connection, {
        type: "response",
        id,
        error: structuredErrorFrom(error),
      });
    }
  }

  #write(connection: HostConnection, frame: ServerFrame): void {
    if (connection.disconnected || connection.socket.destroyed || !connection.socket.writable) {
      return;
    }
    const validated = SERVER_FRAME_SCHEMA.safeParse(frame);
    if (!validated.success) {
      connection.socket.destroy();
      return;
    }
    try {
      connection.socket.write(encodeFrame(validated.data));
    } catch {
      connection.socket.destroy();
    }
  }

  #disconnect(connection: HostConnection): void {
    if (connection.disconnected) {
      return;
    }
    connection.disconnected = true;
    this.#clearHelloTimeout(connection);
    this.#connections.delete(connection);
    connection.abortController.abort();
    if (connection.authenticated) {
      let cleanup: Promise<void>;
      try {
        cleanup = Promise.resolve(
          this.#handler.onDisconnect?.({
            connectionId: connection.connectionId,
            signal: connection.abortController.signal,
          }),
        ).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        cleanup = Promise.resolve();
      }
      this.#disconnectCleanups.add(cleanup);
      void cleanup.then(() => this.#disconnectCleanups.delete(cleanup));
    }
  }

  #clearHelloTimeout(connection: HostConnection): void {
    if (connection.helloTimeout !== undefined) {
      this.#clock.clearTimeout(connection.helloTimeout);
      connection.helloTimeout = undefined;
    }
  }
}

function tokensEqual(received: string, expected: string): boolean {
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function structuredErrorFrom(error: unknown): StructuredToolError {
  const direct = STRUCTURED_TOOL_ERROR_SCHEMA.safeParse(error);
  if (direct.success) {
    return direct.data;
  }
  if (typeof error === "object" && error !== null && "detail" in error) {
    const nested = STRUCTURED_TOOL_ERROR_SCHEMA.safeParse(
      (error as { readonly detail: unknown }).detail,
    );
    if (nested.success) {
      return nested.data;
    }
  }
  return dapFailureError();
}
