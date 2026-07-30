export class SmokeStdoutValidator {
  #stdout = "";
  #messages = new Map();

  constructor(options) {
    this.expectedToolCount = options.expectedToolCount;
  }

  push(chunk) {
    this.#stdout += chunk;
    const ids = [];
    while (this.#stdout.includes("\n")) {
      const newline = this.#stdout.indexOf("\n");
      const line = this.#stdout.slice(0, newline).replace(/\r$/, "");
      this.#stdout = this.#stdout.slice(newline + 1);
      if (line.length === 0) {
        throw new Error("MCP bridge stdout contained an empty protocol line.");
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`MCP bridge wrote non-protocol stdout: ${line}`);
      }
      validateResponseEnvelope(message);
      if (message.id !== 1 && message.id !== 2) {
        throw new Error(`MCP bridge stdout contained unexpected response id ${message.id}.`);
      }
      if (this.#messages.has(message.id)) {
        throw new Error(`MCP bridge stdout contained duplicate response id ${message.id}.`);
      }
      if (message.id === 1) {
        validateInitializeResult(message.result);
      } else {
        validateToolsListResult(message.result, this.expectedToolCount);
      }
      this.#messages.set(message.id, message);
      ids.push(message.id);
    }
    return ids;
  }

  finish() {
    if (this.#stdout.length !== 0) {
      throw new Error("MCP bridge wrote an incomplete stdout protocol frame.");
    }
    if (this.#messages.size !== 2 || !this.#messages.has(1) || !this.#messages.has(2)) {
      throw new Error("MCP bridge stdout omitted an expected initialize or tools/list response.");
    }
    return new Map(this.#messages);
  }
}

function validateResponseEnvelope(message) {
  if (
    !isRecord(message) ||
    Object.keys(message).sort().join(",") !== "id,jsonrpc,result" ||
    message.jsonrpc !== "2.0" ||
    !Number.isInteger(message.id)
  ) {
    throw new Error("MCP bridge stdout contained an invalid JSON-RPC 2.0 response envelope.");
  }
}

function validateInitializeResult(result) {
  const allowedKeys = new Set([
    "capabilities",
    "instructions",
    "protocolVersion",
    "serverInfo",
  ]);
  if (
    !isRecord(result) ||
    Object.keys(result).some((key) => !allowedKeys.has(key)) ||
    result.protocolVersion !== "2025-11-25" ||
    !isRecord(result.capabilities) ||
    !isRecord(result.serverInfo) ||
    !nonEmptyString(result.serverInfo.name) ||
    !nonEmptyString(result.serverInfo.version) ||
    (result.instructions !== undefined && typeof result.instructions !== "string")
  ) {
    throw new Error("MCP bridge stdout contained an invalid initialize result.");
  }
}

function validateToolsListResult(result, expectedToolCount) {
  if (
    !isRecord(result) ||
    Object.keys(result).sort().join(",") !== "tools" ||
    !Array.isArray(result.tools) ||
    result.tools.length !== expectedToolCount
  ) {
    throw new Error("MCP bridge stdout contained an invalid tools/list result.");
  }
  const names = new Set();
  for (const tool of result.tools) {
    if (
      !isRecord(tool) ||
      !nonEmptyString(tool.name) ||
      !nonEmptyString(tool.description) ||
      !isObjectSchema(tool.inputSchema) ||
      !isObjectSchema(tool.outputSchema) ||
      !validAnnotations(tool.annotations) ||
      names.has(tool.name)
    ) {
      throw new Error("MCP bridge stdout contained an invalid tools/list tool definition.");
    }
    names.add(tool.name);
  }
}

function isObjectSchema(value) {
  return isRecord(value) && value.type === "object";
}

function validAnnotations(value) {
  return isRecord(value) &&
    typeof value.readOnlyHint === "boolean" &&
    typeof value.destructiveHint === "boolean" &&
    typeof value.idempotentHint === "boolean" &&
    value.openWorldHint === false;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
