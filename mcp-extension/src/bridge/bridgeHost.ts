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
import { BridgeFrameTooLargeError, FrameDecoder, encodeFrame } from "./framing.js";
import {
  STRUCTURED_TOOL_ERROR_SCHEMA,
  dapFailureError,
  resultTooLargeError,
  type StructuredToolError,
} from "../tools/errors.js";

const HELLO_TIMEOUT_MS = 5_000;
const HOST_CLOSED_MESSAGE = "Bridge host is closed.";

type BridgeHostState = "idle" | "listening" | "open" | "closing" | "closed";

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
  readonly requests: Map<string, HostRequest>;
  helloTimeout: NodeJS.Timeout | undefined;
  authenticated: boolean;
  disconnected: boolean;
}

interface HostRequest {
  readonly abortController: AbortController;
  readonly removeConnectionAbortListener: () => void;
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
  #state: BridgeHostState = "idle";
  #server: Server | undefined;
  #descriptor: BridgeDescriptor | undefined;
  #listenOperation: Promise<BridgeDescriptor> | undefined;
  #startupCompletion: Promise<void> | undefined;
  #listenAbortController: AbortController | undefined;
  #rejectListen: ((error: Error) => void) | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: BridgeHostOptions) {
    this.#handler = options.handler;
    this.#createServer = options.createServer ?? nodeCreateServer;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  listen(): Promise<BridgeDescriptor> {
    if (this.#state === "open" && this.#descriptor !== undefined) {
      return Promise.resolve(this.#descriptor);
    }
    if (this.#state === "listening" && this.#listenOperation !== undefined) {
      return this.#listenOperation;
    }
    if (this.#state !== "idle") {
      return Promise.reject(new Error(HOST_CLOSED_MESSAGE));
    }

    this.#state = "listening";
    const descriptor = Object.freeze({
      protocolVersion: 1 as const,
      pipeName: `\\\\.\\pipe\\unity-debugger-pure-mcp-${this.#randomUUID()}`,
      token: this.#randomBytes(32).toString("base64url"),
    });

    let server: Server;
    try {
      server = this.#createServer((socket) => this.#accept(socket, descriptor.token));
    } catch (error) {
      this.#state = "closed";
      return Promise.reject(asError(error));
    }
    this.#server = server;
    const listenAbortController = new AbortController();
    this.#listenAbortController = listenAbortController;

    let completeStartup: (() => void) | undefined;
    this.#startupCompletion = new Promise<void>((resolve) => {
      completeStartup = resolve;
    });

    let settled = false;
    let resolveListen!: (value: BridgeDescriptor) => void;
    let rejectListen!: (error: Error) => void;
    const operation = new Promise<BridgeDescriptor>((resolve, reject) => {
      resolveListen = resolve;
      rejectListen = reject;
    });
    this.#listenOperation = operation;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.#rejectListen = undefined;
      rejectListen(error);
    };
    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.#rejectListen = undefined;
      resolveListen(descriptor);
    };
    this.#rejectListen = rejectOnce;

    let startupCompleted = false;
    const completeStartupOnce = (): void => {
      if (startupCompleted) {
        return;
      }
      startupCompleted = true;
      completeStartup?.();
      completeStartup = undefined;
    };
    const onRuntimeError = (): void => {
      void this.close();
    };
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      server.off("close", onStartupClose);
      completeStartupOnce();
      if (this.#state === "listening") {
        this.#state = "closed";
        this.#server = undefined;
        this.#listenAbortController = undefined;
        rejectOnce(error);
      } else {
        rejectOnce(new Error(HOST_CLOSED_MESSAGE));
      }
    };
    const onStartupClose = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
      completeStartupOnce();
      if (this.#state === "listening") {
        this.#state = "closed";
        this.#server = undefined;
        this.#listenAbortController = undefined;
        rejectOnce(new Error("Bridge host closed before listening."));
      } else {
        rejectOnce(new Error(HOST_CLOSED_MESSAGE));
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      server.off("close", onStartupClose);
      server.on("error", onRuntimeError);
      completeStartupOnce();
      if (this.#state !== "listening" || this.#server !== server) {
        rejectOnce(new Error(HOST_CLOSED_MESSAGE));
        void closeNetServer(server);
        return;
      }
      this.#state = "open";
      this.#descriptor = descriptor;
      this.#listenAbortController = undefined;
      resolveOnce();
    };
    server.once("error", onError);
    server.once("close", onStartupClose);
    server.once("listening", onListening);
    try {
      server.listen({
        path: descriptor.pipeName,
        readableAll: false,
        writableAll: false,
        signal: listenAbortController.signal,
      });
    } catch (error) {
      server.off("error", onError);
      server.off("close", onStartupClose);
      server.off("listening", onListening);
      completeStartupOnce();
      this.#state = "closed";
      this.#server = undefined;
      this.#listenAbortController = undefined;
      rejectOnce(asError(error));
    }
    return operation;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) {
      return this.#closing;
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    this.#state = "closing";
    this.#listenAbortController?.abort();
    this.#rejectListen?.(new Error(HOST_CLOSED_MESSAGE));
    for (const connection of [...this.#connections]) {
      this.#terminate(connection);
    }
    this.#closing = this.#closeResources();
    return this.#closing;
  }

  async #closeResources(): Promise<void> {
    const server = this.#server;
    if (this.#startupCompletion !== undefined) {
      await this.#startupCompletion;
    }
    if (server !== undefined) {
      await closeNetServer(server);
    }
    await Promise.all([...this.#disconnectCleanups]);
    this.#server = undefined;
    this.#descriptor = undefined;
    this.#listenAbortController = undefined;
    this.#rejectListen = undefined;
    this.#state = "closed";
  }

  #accept(socket: Socket, token: string): void {
    if (this.#state !== "listening" && this.#state !== "open") {
      socket.destroy();
      return;
    }
    const connection: HostConnection = {
      socket,
      connectionId: this.#randomUUID(),
      abortController: new AbortController(),
      decoder: new FrameDecoder(),
      requests: new Map(),
      helloTimeout: undefined,
      authenticated: false,
      disconnected: false,
    };
    this.#connections.add(connection);
    connection.helloTimeout = this.#clock.setTimeout(() => {
      connection.helloTimeout = undefined;
      if (!connection.authenticated) {
        this.#terminate(connection);
      }
    }, HELLO_TIMEOUT_MS);

    socket.on("data", (bytes) => {
      if (typeof bytes === "string") {
        this.#terminate(connection);
        return;
      }
      this.#receive(connection, token, bytes);
    });
    socket.once("close", () => this.#disconnect(connection));
    socket.on("error", () => {
      this.#terminate(connection);
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
      this.#terminate(connection);
      return;
    }

    for (const decoded of decodedFrames) {
      const parsed = CLIENT_FRAME_SCHEMA.safeParse(decoded);
      if (!parsed.success) {
        this.#terminate(connection);
        return;
      }
      const frame = parsed.data;
      if (!connection.authenticated) {
        if (frame.type !== "hello" || !tokensEqual(frame.token, token)) {
          this.#terminate(connection);
          return;
        }
        connection.authenticated = true;
        this.#clearHelloTimeout(connection);
        this.#write(connection, { type: "helloAck", protocolVersion: 1 });
        continue;
      }
      if (frame.type === "cancel") {
        connection.requests.get(frame.id)?.abortController.abort();
        continue;
      }
      if (frame.type !== "request") {
        this.#terminate(connection);
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
    if (connection.disconnected) {
      return;
    }
    const abortController = new AbortController();
    const onConnectionAbort = (): void => abortController.abort();
    const removeConnectionAbortListener = (): void => {
      connection.abortController.signal.removeEventListener("abort", onConnectionAbort);
    };
    const request: HostRequest = { abortController, removeConnectionAbortListener };
    connection.requests.set(id, request);
    connection.abortController.signal.addEventListener("abort", onConnectionAbort, { once: true });
    if (connection.abortController.signal.aborted) {
      onConnectionAbort();
    }
    try {
      const result = await this.#handler.callTool({
        connectionId: connection.connectionId,
        signal: abortController.signal,
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
    } finally {
      removeConnectionAbortListener();
      if (connection.requests.get(id) === request) {
        connection.requests.delete(id);
      }
    }
  }

  #write(connection: HostConnection, frame: ServerFrame): void {
    if (connection.disconnected || connection.socket.destroyed || !connection.socket.writable) {
      return;
    }
    const validated = SERVER_FRAME_SCHEMA.safeParse(frame);
    if (!validated.success) {
      this.#terminate(connection);
      return;
    }
    try {
      connection.socket.write(encodeFrame(validated.data));
    } catch (error) {
      if (
        error instanceof BridgeFrameTooLargeError &&
        frame.type === "response" &&
        "result" in frame
      ) {
        this.#write(connection, {
          type: "response",
          id: frame.id,
          error: resultTooLargeError(),
        });
        return;
      }
      this.#terminate(connection);
    }
  }

  #terminate(connection: HostConnection): void {
    this.#disconnect(connection);
    connection.socket.destroy();
  }

  #disconnect(connection: HostConnection): void {
    if (connection.disconnected) {
      return;
    }
    connection.disconnected = true;
    this.#clearHelloTimeout(connection);
    this.#connections.delete(connection);
    connection.abortController.abort();
    for (const request of connection.requests.values()) {
      request.removeConnectionAbortListener();
      request.abortController.abort();
    }
    connection.requests.clear();
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
  try {
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
  } catch {
    return dapFailureError();
  }
  return dapFailureError();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Bridge host failed to listen.");
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
