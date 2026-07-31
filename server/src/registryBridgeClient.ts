import type { BridgeDescriptor } from "../../src/bridge/bridgeHost.js";
import type { ToolName } from "../../src/bridge/protocol.js";
import {
  bridgeUnavailableError,
  cancelledError,
} from "../../src/tools/errors.js";
import type { BridgeToolCaller } from "./toolCatalog.js";
import {
  BridgeCallError,
  BridgeClient,
} from "./bridgeClient.js";

export interface LiveHostLocator {
  locate(): Promise<BridgeDescriptor>;
}

export interface BridgeClientConnection extends BridgeToolCaller {
  readonly ready: boolean;
  close(): void;
}

export interface BridgeClientFactory {
  connect(descriptor: BridgeDescriptor): Promise<BridgeClientConnection>;
}

const DEFAULT_FACTORY: BridgeClientFactory = {
  connect: (descriptor) => BridgeClient.connect(descriptor),
};

export class RegistryBridgeClient implements BridgeToolCaller {
  readonly #locator: LiveHostLocator;
  readonly #factory: BridgeClientFactory;
  #connection: BridgeClientConnection | undefined;
  #connectOperation: Promise<BridgeClientConnection> | undefined;
  #closed = false;

  private constructor(locator: LiveHostLocator, factory: BridgeClientFactory) {
    this.#locator = locator;
    this.#factory = factory;
  }

  static async connect(
    locator: LiveHostLocator,
    factory: BridgeClientFactory = DEFAULT_FACTORY,
  ): Promise<RegistryBridgeClient> {
    const client = new RegistryBridgeClient(locator, factory);
    await client.#connectionForNewCall();
    return client;
  }

  async callTool(
    name: ToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isAborted(signal)) {
      throw new BridgeCallError(cancelledError());
    }
    const connection = await this.#connectionForNewCall();
    if (isAborted(signal)) {
      throw new BridgeCallError(cancelledError());
    }
    try {
      return await connection.callTool(name, input, signal);
    } catch (error) {
      if (!connection.ready && this.#connection === connection) {
        this.#connection = undefined;
      }
      throw sanitizeConnectionError(error);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connection?.close();
    this.#connection = undefined;
  }

  #connectionForNewCall(): Promise<BridgeClientConnection> {
    if (this.#closed) {
      return Promise.reject(new BridgeCallError(bridgeUnavailableError()));
    }
    if (this.#connection?.ready === true) {
      return Promise.resolve(this.#connection);
    }
    this.#connection?.close();
    this.#connection = undefined;
    if (this.#connectOperation !== undefined) {
      return this.#connectOperation;
    }
    const operation = (async (): Promise<BridgeClientConnection> => {
      try {
        const descriptor = await this.#locator.locate();
        const connection = await this.#factory.connect(descriptor);
        if (this.#closed) {
          connection.close();
          throw new BridgeCallError(bridgeUnavailableError());
        }
        this.#connection = connection;
        return connection;
      } catch (error) {
        throw sanitizeConnectionError(error);
      }
    })();
    this.#connectOperation = operation;
    void operation.finally(() => {
      if (this.#connectOperation === operation) {
        this.#connectOperation = undefined;
      }
    }).catch(() => undefined);
    return operation;
  }
}

function sanitizeConnectionError(error: unknown): BridgeCallError {
  return error instanceof BridgeCallError
    ? error
    : new BridgeCallError(bridgeUnavailableError());
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
