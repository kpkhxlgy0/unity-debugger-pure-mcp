import {
  createHmac,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

import type { StructuredToolError } from "../tools/errors.js";

const SECRET_BYTES = 32;
const AUTHENTICATION_TAG_BYTES = 16;
const REFERENCE_CONTEXT = Buffer.from(
  "unity-debugger-pure-mcp/reference/v1\0",
  "utf8",
);

export type ReferenceKind = "thread" | "frame" | "scope" | "variable";

type RandomBytes = (size: number) => Buffer;

interface ReferenceRecord {
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: ReferenceKind;
  readonly value: unknown;
}

const STALE_REFERENCE_ERROR: StructuredToolError = Object.freeze({
  code: "STALE_REFERENCE",
  message: "The debugger reference is stale or invalid.",
  retryable: false,
  currentState: "reference_invalid",
  action: "Request fresh debugger data and retry with its opaque reference.",
});

/** Stores raw DAP handles behind generation-bound, lifetime-unique references. */
export class ReferenceStore {
  readonly #secret: Buffer;
  readonly #records = new Map<string, ReferenceRecord>();
  readonly #referencesBySession = new Map<string, Set<string>>();
  #counter = 0n;

  public constructor(randomBytes: RandomBytes = nodeRandomBytes) {
    const secret = randomBytes(SECRET_BYTES);
    if (secret.byteLength !== SECRET_BYTES) {
      throw new Error("Reference secret entropy source returned an invalid length.");
    }
    this.#secret = Buffer.from(secret);
  }

  public get activeReferenceCount(): number {
    return this.#records.size;
  }

  public create<T>(
    sessionId: string,
    generation: number,
    kind: ReferenceKind,
    value: T,
  ): string {
    const reference = this.#nextReference();
    this.#records.set(reference, { sessionId, generation, kind, value });
    let references = this.#referencesBySession.get(sessionId);
    if (references === undefined) {
      references = new Set<string>();
      this.#referencesBySession.set(sessionId, references);
    }
    references.add(reference);
    return reference;
  }

  public resolve<T>(
    reference: string,
    sessionId: string,
    generation: number,
    kind: ReferenceKind,
  ): T {
    const record = this.#records.get(reference);
    if (
      record === undefined ||
      record.sessionId !== sessionId ||
      record.generation !== generation ||
      record.kind !== kind
    ) {
      throw STALE_REFERENCE_ERROR;
    }
    return record.value as T;
  }

  public invalidate(sessionId: string): void {
    const references = this.#referencesBySession.get(sessionId);
    if (references === undefined) {
      return;
    }
    for (const reference of references) {
      this.#records.delete(reference);
    }
    this.#referencesBySession.delete(sessionId);
  }

  /** Revokes one unpublished reference without rewinding the lifetime counter. */
  public revoke(reference: string): void {
    const record = this.#records.get(reference);
    if (record === undefined) {
      return;
    }
    this.#records.delete(reference);
    const references = this.#referencesBySession.get(record.sessionId);
    references?.delete(reference);
    if (references?.size === 0) {
      this.#referencesBySession.delete(record.sessionId);
    }
  }

  #nextReference(): string {
    this.#counter += 1n;
    const counter = encodeCounter(this.#counter);
    const tag = createHmac("sha256", this.#secret)
      .update(REFERENCE_CONTEXT)
      .update(counter)
      .digest()
      .subarray(0, AUTHENTICATION_TAG_BYTES);

    // The counter bytes make references strictly non-repeating without a
    // lifetime tombstone set. The secret HMAC tag prevents a predictable
    // counter alone from becoming a forgeable reference.
    return Buffer.concat([counter, tag]).toString("base64url");
  }
}

function encodeCounter(counter: bigint): Buffer {
  let hex = counter.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex");
}
