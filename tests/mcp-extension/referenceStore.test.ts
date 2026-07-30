import { describe, expect, it } from "vitest";

import {
  ReferenceStore,
  type ReferenceKind,
} from "../../mcp-extension/src/debug/referenceStore.js";

const KINDS: readonly ReferenceKind[] = ["thread", "frame", "scope", "variable"];

describe("ReferenceStore", () => {
  it("round-trips every debugger handle kind without putting the raw ID in the reference", () => {
    const store = new ReferenceStore();

    for (const [index, kind] of KINDS.entries()) {
      const rawId = 9_000_000 + index;
      const ref = store.create("session-1", 3, kind, rawId);

      expect(ref).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(ref).not.toContain(String(rawId));
      expect(store.resolve(ref, "session-1", 3, kind)).toBe(rawId);
    }
  });

  it("returns the same frozen sanitized stale error for every identity mismatch", () => {
    const store = new ReferenceStore(() => "opaque-ref");
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

  it("invalidates one session efficiently without affecting another session", () => {
    const generated = ["session-1-a", "session-1-b", "session-2-a"];
    const store = new ReferenceStore(() => generated.shift()!);
    const first = store.create("session-1", 3, "frame", 11);
    const second = store.create("session-1", 3, "variable", 12);
    const other = store.create("session-2", 3, "thread", 13);

    store.invalidate("session-1");

    expect(() => store.resolve(first, "session-1", 3, "frame")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(() => store.resolve(second, "session-1", 3, "variable")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(store.resolve(other, "session-2", 3, "thread")).toBe(13);
  });

  it("never revives an invalidated reference when the generator repeats a lifetime tombstone", () => {
    const generated = ["ref-old", "ref-old", "ref-new"];
    const store = new ReferenceStore(() => generated.shift()!);
    const oldRef = store.create("session-1", 3, "frame", 42);
    store.invalidate("session-1");

    const newRef = store.create("session-1", 4, "frame", 84);

    expect(oldRef).toBe("ref-old");
    expect(newRef).toBe("ref-new");
    expect(() => store.resolve(oldRef, "session-1", 4, "frame")).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
    expect(store.resolve(newRef, "session-1", 4, "frame")).toBe(84);
  });

  it("retries active collisions and fails closed when uniqueness cannot be obtained", () => {
    const colliding = new ReferenceStore(() => "same-ref");
    colliding.create("session-1", 1, "thread", 1);

    expect(() => colliding.create("session-1", 1, "thread", 2)).toThrow(
      "Unable to allocate a unique debugger reference.",
    );
  });
});
