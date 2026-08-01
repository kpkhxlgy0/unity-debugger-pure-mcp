import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const verifier = path.resolve("scripts/verify-release-inventory.mjs");

test("release inventory accepts the exact reviewed Node and SEA identity", (t) => {
  const fixture = createFixture(t);
  fixture.writeReviewed({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
  });
  fixture.writeGenerated({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
  });

  const result = fixture.run();

  assert.equal(result.status, 0, result.stderr);
});

test("release inventory rejects a compatible but nonofficial Node build", (t) => {
  const fixture = createFixture(t);
  fixture.writeReviewed({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
  });
  fixture.writeGenerated({
    nodeVersion: "v26.5.1",
    sha256: "a".repeat(64),
  });

  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed release inventory/i);
});

test("release inventory rejects a changed SEA digest", (t) => {
  const fixture = createFixture(t);
  fixture.writeReviewed({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
  });
  fixture.writeGenerated({
    nodeVersion: "v26.5.0",
    sha256: "b".repeat(64),
  });

  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed release inventory/i);
});

test("release inventory rejects a nonofficial reviewed baseline", (t) => {
  const fixture = createFixture(t);
  fixture.writeReviewed({
    nodeVersion: "v26.5.1",
    sha256: "a".repeat(64),
  });
  fixture.writeGenerated({
    nodeVersion: "v26.5.1",
    sha256: "a".repeat(64),
  });

  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed release inventory/i);
});

test("release inventory rejects extended inventory files", (t) => {
  const fixture = createFixture(t);
  fixture.writeReviewed({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
    extra: true,
  });
  fixture.writeGenerated({
    nodeVersion: "v26.5.0",
    sha256: "a".repeat(64),
  });

  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP bridge runtime inventory is invalid/);
});

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reviewedPath = path.join(directory, "reviewed.json");
  const generatedPath = path.join(directory, "generated.json");
  return {
    run: () => spawnSync(
      process.execPath,
      [verifier, reviewedPath, generatedPath],
      { encoding: "utf8", windowsHide: true },
    ),
    writeGenerated: (value) => {
      fs.writeFileSync(generatedPath, JSON.stringify(value));
    },
    writeReviewed: (value) => {
      fs.writeFileSync(reviewedPath, JSON.stringify(value));
    },
  };
}
