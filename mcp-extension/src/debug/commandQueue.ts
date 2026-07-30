type CommandOperation<T> = () => T | PromiseLike<T>;

interface QueuedCommand {
  readonly mode: "read" | "write";
  readonly operation: CommandOperation<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

interface SessionQueueState {
  readonly pending: QueuedCommand[];
  activeReaders: number;
  activeWriter: boolean;
}

/** A fair reader/writer scheduler shared by every MCP client of a session. */
export class SessionCommandQueue {
  readonly #sessions = new Map<string, SessionQueueState>();

  public get activeSessionCount(): number {
    return this.#sessions.size;
  }

  public read<T>(sessionId: string, operation: CommandOperation<T>): Promise<T> {
    return this.#enqueue(sessionId, "read", operation);
  }

  public write<T>(sessionId: string, operation: CommandOperation<T>): Promise<T> {
    return this.#enqueue(sessionId, "write", operation);
  }

  #enqueue<T>(
    sessionId: string,
    mode: "read" | "write",
    operation: CommandOperation<T>,
  ): Promise<T> {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { pending: [], activeReaders: 0, activeWriter: false };
      this.#sessions.set(sessionId, state);
    }

    const promise = new Promise<T>((resolve, reject) => {
      state!.pending.push({
        mode,
        operation,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
    });
    this.#drain(sessionId, state);
    return promise;
  }

  #drain(sessionId: string, state: SessionQueueState): void {
    if (state.activeWriter) {
      return;
    }

    if (state.activeReaders > 0) {
      while (state.pending[0]?.mode === "read") {
        this.#startRead(sessionId, state, state.pending.shift()!);
      }
      return;
    }

    const next = state.pending[0];
    if (next === undefined) {
      if (this.#sessions.get(sessionId) === state) {
        this.#sessions.delete(sessionId);
      }
      return;
    }

    if (next.mode === "write") {
      state.pending.shift();
      this.#startWrite(sessionId, state, next);
      return;
    }

    while (state.pending[0]?.mode === "read") {
      this.#startRead(sessionId, state, state.pending.shift()!);
    }
  }

  #startRead(
    sessionId: string,
    state: SessionQueueState,
    command: QueuedCommand,
  ): void {
    state.activeReaders += 1;
    this.#run(command, () => {
      state.activeReaders -= 1;
      this.#drain(sessionId, state);
    });
  }

  #startWrite(
    sessionId: string,
    state: SessionQueueState,
    command: QueuedCommand,
  ): void {
    state.activeWriter = true;
    this.#run(command, () => {
      state.activeWriter = false;
      this.#drain(sessionId, state);
    });
  }

  #run(command: QueuedCommand, complete: () => void): void {
    void Promise.resolve()
      .then(command.operation)
      .then(
        (value) => {
          complete();
          command.resolve(value);
        },
        (error: unknown) => {
          complete();
          command.reject(error);
        },
      );
  }
}
