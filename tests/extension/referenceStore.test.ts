import { describe, expect, it } from "vitest";

import {
  ReferenceStore,
  type ReferenceKind,
} from "../../src/debug/referenceStore.js";

const KINDS: readonly ReferenceKind[] = ["thread", "frame", "scope", "variable"];

describe("ReferenceStore", () => {
  it("round-trips every debugger handle kind without putting the raw ID in the reference", () => {
    const store = new ReferenceStore();

    for (const [index, kind] of KINDS.entries()) {
      const rawId = 9_000_000 + index;
      const ref = store.create("session-1", 3, kind, rawId);

      expect(ref).toMatch(/^[A-Za-z0-9_-]{23,}$/);
      expect(ref).not.toContain(String(rawId));
      expect(store.resolve(ref, "session-1", 3, kind)).toBe(rawId);
    }
  });

  it("returns the same frozen sanitized stale error for every identity mismatch", () => {
    const store = new ReferenceStore(() => Buffer.alloc(32, 1));
    const ref = store.create("session-1", 3, "frame", 42);
    const attempts = [
      () => store.resolve("missing", "session-1", 3, "frame"),
      () => store.resolve(ref, "session-2", 3, "frame"),
      () => store.resolve(ref, "session-1", 4, "frame"),
      () => store.resolve(ref, "session-1", 3, "thread"),
    ];
    const errors: unknown[] = [];

    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(4);
    expect(errors.every((error) => error === errors[0])).toBe(true);
    expect(Object.isFrozen(errors[0])).toBe(true);
    expect(errors[0]).toEqual({
      code: "STALE_REFERENCE",
      message: "The debugger reference is stale or invalid.",
      retryable: false,
      currentState: "reference_invalid",
      action: "Request fresh debugger data and retry with its opaque reference.",
    });
  });

  it("invalidates one session and releases its live records without affecting another session", () => {
    const store = new ReferenceStore(() => Buffer.alloc(32, 2));
    const first = store.create("session-1", 3, "frame", 11);
    const second = store.create("session-1", 3, "variable", 12);
    const other = store.create("session-2", 3, "thread", 13);

    expect(store.activeReferenceCount).toBe(3);

    store.invalidate("session-1");

    expect(store.activeReferenceCount).toBe(1);
    expect(() => store.resolve(first, "session-1", 3, "frame")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(() => store.resolve(second, "session-1", 3, "variable")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(store.resolve(other, "session-2", 3, "thread")).toBe(13);

    store.invalidate("session-2");
    expect(store.activeReferenceCount).toBe(0);
  });

  it("never revives an invalidated reference without retaining historical tokens", () => {
    const store = new ReferenceStore(() => Buffer.alloc(32, 3));
    const oldRef = store.create("session-1", 3, "frame", 42);
    store.invalidate("session-1");

    const newRef = store.create("session-1", 4, "frame", 84);

    expect(newRef).not.toBe(oldRef);
    expect(() => store.resolve(oldRef, "session-1", 4, "frame")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(store.resolve(newRef, "session-1", 4, "frame")).toBe(84);
  });

  it("derives store-unique authenticated references from a non-wrapping counter", () => {
    const firstStore = new ReferenceStore(() => Buffer.alloc(32, 4));
    const secondStore = new ReferenceStore(() => Buffer.alloc(32, 5));
    const references = new Set<string>();

    for (let generation = 1; generation <= 1_000; generation += 1) {
      const reference = firstStore.create("session-1", generation, "thread", generation);
      references.add(reference);
      firstStore.invalidate("session-1");
      expect(firstStore.activeReferenceCount).toBe(0);
    }

    const otherStoreReference = secondStore.create("session-1", 1, "thread", 1);
    expect(references.size).toBe(1_000);
    expect(references.has(otherStoreReference)).toBe(false);
  });

  it("rejects an entropy source that cannot provide a 256-bit per-store secret", () => {
    expect(() => new ReferenceStore(() => Buffer.alloc(16))).toThrow(
      "Reference secret entropy source returned an invalid length.",
    );
  });
});
