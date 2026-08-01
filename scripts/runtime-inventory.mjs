import { assertSupportedNodeVersion } from "./build-tool-version-policy.mjs";

const inventoryError = "MCP bridge runtime inventory is invalid.";

export function parseRuntimeInventory(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(inventoryError);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "nodeVersion,sha256" ||
    typeof value.nodeVersion !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error(inventoryError);
  }
  try {
    assertSupportedNodeVersion(value.nodeVersion);
  } catch {
    throw new Error(inventoryError);
  }
  return Object.freeze({
    nodeVersion: value.nodeVersion,
    sha256: value.sha256,
  });
}

export function formatRuntimeInventory(value) {
  const inventory = parseRuntimeInventory(JSON.stringify(value));
  return `${JSON.stringify(inventory, null, 2)}\n`;
}
