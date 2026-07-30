import { randomUUID } from "node:crypto";
import { Socket } from "node:net";

import type { BridgeDescriptor } from "../../mcp-extension/src/bridge/bridgeHost.js";
import {
  CLIENT_FRAME_SCHEMA,
  SERVER_FRAME_SCHEMA,
  type ServerFrame,
  type ToolName,
} from "../../mcp-extension/src/bridge/protocol.js";
import {
  bridgeUnavailableError,
  cancelledError,
  type StructuredToolError,
} from "../../mcp-extension/src/tools/errors.js";
import {
  FrameDecoder,
  encodeFrame,
} from "../../mcp-extension/src/bridge/framing.js";

const HELLO_ACK_TIMEOUT_MS = 5_000;

interface PendingCall {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: BridgeCallError) => void;
  readonly removeAbortListener: () => void;
  sent: boolean;
}

export class BridgeCallError extends Error {
  constructor(readonly detail: StructuredToolError) {
    super(detail.message);
    this.name = "BridgeCallError";
  }
}

export class BridgeClient {
  readonly #socket = new Socket();
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingCall>();
  #state: "connecting" | "ready" | "closed" = "connecting";
  #resolveHello: (() => void) | undefined;
  #rejectHello: ((error: BridgeCallError) => void) | undefined;

  private constructor() {
    this.#socket.on("data", (bytes) => {
      if (typeof bytes === "string") {
        this.#protocolFailure();
        return;
      }
      this.#receive(bytes);
    });
    this.#socket.on("error", () => this.#failTransport());
    this.#socket.on("close", () => this.#failTransport());
  }

  static async connect(descriptor: BridgeDescriptor): Promise<BridgeClient> {
    validateDescriptor(descriptor);
    const client = new BridgeClient();
    await client.#authenticate(descriptor);
    return client;
  }

  callTool(name: ToolName, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted === true) {
      return Promise.reject(new BridgeCallError(cancelledError()));
    }
    if (this.#state !== "ready") {
      return Promise.reject(new BridgeCallError(bridgeUnavailableError()));
    }

    const id = randomUUID();
    const frame = CLIENT_FRAME_SCHEMA.parse({
      type: "request",
      id,
      method: "callTool",
      params: { name, input: input ?? null },
    });

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) {
          return;
        }
        this.#pending.delete(id);
        pending.removeAbortListener();
        if (pending.sent) {
          this.#sendCancel(id);
        }
        pending.reject(new BridgeCallError(cancelledError()));
      };
      const removeAbortListener = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const pending: PendingCall = { resolve, reject, removeAbortListener, sent: false };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }

      try {
        this.#socket.write(encodeFrame(frame));
        pending.sent = true;
      } catch {
        const current = this.#pending.get(id);
        if (current !== undefined) {
          this.#pending.delete(id);
          current.removeAbortListener();
          current.reject(new BridgeCallError(bridgeUnavailableError()));
        }
      }
    });
  }

  #sendCancel(id: string): void {
    if (this.#state !== "ready" || this.#socket.destroyed || !this.#socket.writable) {
      return;
    }
    try {
      const frame = CLIENT_FRAME_SCHEMA.parse({ type: "cancel", id });
      this.#socket.write(encodeFrame(frame));
    } catch {
      // Cancellation is best-effort; the local call is already settled as cancelled.
    }
  }

  close(): void {
    this.#failTransport();
    this.#socket.destroy();
  }

  #authenticate(descriptor: BridgeDescriptor): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const settleResolve = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        resolve();
      };
      const settleReject = (error: BridgeCallError): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        reject(error);
      };
      this.#resolveHello = settleResolve;
      this.#rejectHello = settleReject;
      timeout = setTimeout(() => this.#protocolFailure(), HELLO_ACK_TIMEOUT_MS);

      this.#socket.connect(descriptor.pipeName, () => {
        if (this.#state !== "connecting") {
          return;
        }
        try {
          const hello = CLIENT_FRAME_SCHEMA.parse({
            type: "hello",
            protocolVersion: 1,
            token: descriptor.token,
          });
          this.#socket.write(encodeFrame(hello));
        } catch {
          this.#protocolFailure();
        }
      });
    });
  }

  #receive(bytes: Buffer): void {
    if (this.#state === "closed") {
      return;
    }
    let decodedFrames: unknown[];
    try {
      decodedFrames = this.#decoder.push(bytes);
    } catch {
      this.#protocolFailure();
      return;
    }

    for (const decoded of decodedFrames) {
      const parsed = SERVER_FRAME_SCHEMA.safeParse(decoded);
      if (!parsed.success) {
        this.#protocolFailure();
        return;
      }
      const frame = parsed.data;
      if (this.#state === "connecting") {
        if (frame.type !== "helloAck") {
          this.#protocolFailure();
          return;
        }
        this.#state = "ready";
        const resolveHello = this.#resolveHello;
        this.#resolveHello = undefined;
        this.#rejectHello = undefined;
        resolveHello?.();
        continue;
      }
      if (frame.type !== "response") {
        this.#protocolFailure();
        return;
      }
      this.#settle(frame);
    }
  }

  #settle(frame: Extract<ServerFrame, { readonly type: "response" }>): void {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(frame.id);
    pending.removeAbortListener();
    if ("error" in frame) {
      pending.reject(new BridgeCallError(frame.error));
    } else {
      pending.resolve(frame.result);
    }
  }

  #protocolFailure(): void {
    this.#socket.destroy();
    this.#failTransport();
  }

  #failTransport(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    const error = new BridgeCallError(bridgeUnavailableError());
    const rejectHello = this.#rejectHello;
    this.#resolveHello = undefined;
    this.#rejectHello = undefined;
    rejectHello?.(error);
    for (const pending of this.#pending.values()) {
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validateDescriptor(descriptor: BridgeDescriptor): void {
  const tokenBytes = Buffer.from(descriptor.token, "base64url");
  if (
    descriptor.protocolVersion !== 1 ||
    !descriptor.pipeName.startsWith("\\\\.\\pipe\\unity-debugger-pure-mcp-") ||
    !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token) ||
    tokenBytes.byteLength !== 32
  ) {
    throw new BridgeCallError(bridgeUnavailableError());
  }
}
