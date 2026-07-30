import { describe, expect, it } from "vitest";

import { SessionCommandQueue } from "../../mcp-extension/src/debug/commandQueue.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("SessionCommandQueue", () => {
  it("never overlaps a write with reads from another MCP client", async () => {
    const queue = new SessionCommandQueue();
    const order: string[] = [];
    const release = deferred<void>();

    const first = queue.write("session-1", async () => {
      order.push("write-start");
      await release.promise;
      order.push("write-end");
    });
    const second = queue.read("session-1", async () => {
      order.push("read");
    });

    await Promise.resolve();
    expect(order).toEqual(["write-start"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["write-start", "write-end", "read"]);
  });

  it("shares the leading read batch but prevents reads from barging past a queued writer", async () => {
    const queue = new SessionCommandQueue();
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    const writerRelease = deferred<void>();
    const order: string[] = [];

    const first = queue.read("session-1", async () => {
      order.push("read-1-start");
      await firstRelease.promise;
      order.push("read-1-end");
    });
    const second = queue.read("session-1", async () => {
      order.push("read-2-start");
      await secondRelease.promise;
      order.push("read-2-end");
    });
    const writer = queue.write("session-1", async () => {
      order.push("write-start");
      await writerRelease.promise;
      order.push("write-end");
    });
    const lateRead = queue.read("session-1", async () => {
      order.push("read-late");
    });

    await Promise.resolve();
    expect(order).toEqual(["read-1-start", "read-2-start"]);

    firstRelease.resolve();
    await first;
    expect(order).toEqual(["read-1-start", "read-2-start", "read-1-end"]);

    secondRelease.resolve();
    await second;
    expect(order).toEqual([
      "read-1-start",
      "read-2-start",
      "read-1-end",
      "read-2-end",
      "write-start",
    ]);

    writerRelease.resolve();
    await Promise.all([writer, lateRead]);
    expect(order).toEqual([
      "read-1-start",
      "read-2-start",
      "read-1-end",
      "read-2-end",
      "write-start",
      "write-end",
      "read-late",
    ]);
  });

  it("runs writes exclusively and in arrival order", async () => {
    const queue = new SessionCommandQueue();
    const release = deferred<void>();
    const order: string[] = [];

    const first = queue.write("session-1", async () => {
      order.push("first-start");
      await release.promise;
      order.push("first-end");
    });
    const second = queue.write("session-1", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("does not serialize commands belonging to different sessions", async () => {
    const queue = new SessionCommandQueue();
    const release = deferred<void>();
    const order: string[] = [];

    const first = queue.write("session-1", async () => {
      order.push("session-1-start");
      await release.promise;
    });
    const second = queue.write("session-2", async () => {
      order.push("session-2");
    });

    await second;
    expect(order).toEqual(["session-1-start", "session-2"]);
    release.resolve();
    await first;
  });

  it("continues after synchronous throws and asynchronous rejections", async () => {
    const queue = new SessionCommandQueue();
    const order: string[] = [];

    const syncFailure = queue.write("session-1", () => {
      order.push("sync-failure");
      throw new Error("sync failure");
    });
    const asyncFailure = queue.read("session-1", async () => {
      order.push("async-failure");
      throw new Error("async failure");
    });
    const success = queue.write("session-1", async () => {
      order.push("success");
      return 42;
    });

    await expect(syncFailure).rejects.toThrow("sync failure");
    await expect(asyncFailure).rejects.toThrow("async failure");
    await expect(success).resolves.toBe(42);
    expect(order).toEqual(["sync-failure", "async-failure", "success"]);
  });

  it("removes per-session scheduling state once the final operation settles", async () => {
    const queue = new SessionCommandQueue();
    const release = deferred<void>();

    const operation = queue.read("session-1", async () => release.promise);
    expect(queue.activeSessionCount).toBe(1);
    release.resolve();
    await operation;
    expect(queue.activeSessionCount).toBe(0);

    await expect(queue.read("session-1", async () => "fresh")).resolves.toBe("fresh");
    expect(queue.activeSessionCount).toBe(0);
  });
});
