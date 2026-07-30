import assert from "node:assert/strict";
import test from "node:test";

import { SmokeStdoutValidator } from "../../scripts/mcp-smoke-stdout.mjs";

const initializeResult = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "unity-debugger-pure-mcp", version: "0.1.0" },
};
const toolsResult = {
  tools: Array.from({ length: 19 }, (_, index) => ({
    name: `unity_debug_fixture_${index}`,
    description: `Fixture tool ${index}`,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })),
};

test("SEA smoke stdout accepts exactly the initialize and tools/list responses", () => {
  const validator = new SmokeStdoutValidator({ expectedToolCount: 19 });
  assert.deepEqual(validator.push(output([
    response(1, initializeResult),
    response(2, toolsResult),
  ])), [1, 2]);
  const messages = validator.finish();
  assert.equal(messages.get(1).result.protocolVersion, "2025-11-25");
  assert.equal(messages.get(2).result.tools.length, 19);
});

test("SEA smoke stdout rejects empty protocol lines", () => {
  assert.throws(
    () => validate(`${validOutput()}\n`),
    /empty protocol line/i,
  );
});

test("SEA smoke stdout rejects JSON noise and notifications", () => {
  for (const invalid of [
    { debug: "noise" },
    { jsonrpc: "2.0", method: "notifications/progress", params: {} },
  ]) {
    assert.throws(
      () => validate(output([response(1, initializeResult), invalid, response(2, toolsResult)])),
      /JSON-RPC 2\.0 response envelope/i,
    );
  }
});

test("SEA smoke stdout rejects malformed and extended response envelopes", () => {
  for (const invalid of [
    { id: 1, result: initializeResult },
    { jsonrpc: "1.0", id: 1, result: initializeResult },
    { ...response(1, initializeResult), debug: true },
    { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "failed" } },
  ]) {
    assert.throws(
      () => validate(output([invalid, response(2, toolsResult)])),
      /JSON-RPC 2\.0 response envelope/i,
    );
  }
});

test("SEA smoke stdout rejects duplicate and unknown response IDs", () => {
  assert.throws(
    () => validate(output([
      response(1, initializeResult),
      response(1, initializeResult),
      response(2, toolsResult),
    ])),
    /duplicate response id 1/i,
  );
  assert.throws(
    () => validate(output([
      response(1, initializeResult),
      response(3, toolsResult),
      response(2, toolsResult),
    ])),
    /unexpected response id 3/i,
  );
});

test("SEA smoke stdout rejects malformed initialize and tools/list results", () => {
  for (const messages of [
    [response(1, {}), response(2, toolsResult)],
    [response(1, initializeResult), response(2, { tools: "nineteen" })],
    [response(1, initializeResult), response(2, {
      tools: [...toolsResult.tools.slice(0, 18), { name: "incomplete" }],
    })],
  ]) {
    assert.throws(
      () => validate(output(messages)),
      /initialize|tools\/list/i,
    );
  }
});

function validate(stdout) {
  const validator = new SmokeStdoutValidator({ expectedToolCount: 19 });
  validator.push(stdout);
  return validator.finish();
}

function validOutput() {
  return output([response(1, initializeResult), response(2, toolsResult)]);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function output(messages) {
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}
