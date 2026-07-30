import { MAX_BRIDGE_SUCCESS_RESULT_BYTES } from "../bridge/framing.js";

/** Bounds collection fields as deterministic prefixes under one serialized UTF-8 budget. */
export function boundedCollectionResult(
  result: Readonly<Record<string, unknown>>,
  collectionKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (serializedBytes(result) <= MAX_BRIDGE_SUCCESS_RESULT_BYTES) {
    return result;
  }

  const bounded: Record<string, unknown> = { ...result, truncated: true };
  for (const key of collectionKeys) {
    bounded[key] = Object.freeze([]);
  }

  for (const key of collectionKeys) {
    const source = result[key];
    if (!Array.isArray(source)) {
      throw new TypeError(`Budgeted result field ${key} must be an array.`);
    }
    const prefix: unknown[] = [];
    bounded[key] = prefix;
    for (const item of source) {
      prefix.push(item);
      if (serializedBytes(bounded) > MAX_BRIDGE_SUCCESS_RESULT_BYTES) {
        prefix.pop();
        break;
      }
    }
    bounded[key] = Object.freeze(prefix);
  }

  return Object.freeze(bounded);
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Debugger result is not JSON serializable.");
  }
  return Buffer.byteLength(serialized, "utf8");
}
