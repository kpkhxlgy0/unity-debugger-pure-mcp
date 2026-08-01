import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRuntimeInventory,
  parseRuntimeInventory,
} from "../../scripts/runtime-inventory.mjs";

test("runtime inventory round-trips a compatible local SEA identity", () => {
  const value = { nodeVersion: "v26.5.1", sha256: "a".repeat(64) };

  assert.deepEqual(parseRuntimeInventory(formatRuntimeInventory(value)), value);
  assert.equal(
    formatRuntimeInventory(value),
    `${JSON.stringify(value, null, 2)}\n`,
  );
});

test("runtime inventory rejects schema extensions", () => {
  assert.throws(
    () => parseRuntimeInventory(JSON.stringify({
      nodeVersion: "v26.5.1",
      sha256: "a".repeat(64),
      extra: true,
    })),
    /inventory/i,
  );
});

test("runtime inventory rejects unsupported Node identities", () => {
  for (const nodeVersion of [
    "v26.4.9",
    "v26.5.1-rc.1",
    "v27.0.0",
    "26.5.1",
  ]) {
    assert.throws(
      () => parseRuntimeInventory(JSON.stringify({
        nodeVersion,
        sha256: "a".repeat(64),
      })),
      /inventory/i,
      nodeVersion,
    );
  }
});

test("runtime inventory rejects malformed JSON and noncanonical digests", () => {
  for (const text of [
    "not json",
    "null",
    JSON.stringify({ nodeVersion: "v26.5.1", sha256: "A".repeat(64) }),
    JSON.stringify({ nodeVersion: "v26.5.1", sha256: "a".repeat(63) }),
  ]) {
    assert.throws(() => parseRuntimeInventory(text), /inventory/i);
  }
});
