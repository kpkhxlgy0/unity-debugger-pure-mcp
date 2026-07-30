import { randomBytes } from "node:crypto";

import type { StructuredToolError } from "../tools/errors.js";

const REFERENCE_BYTES = 16;
const MAX_COLLISION_RETRIES = 128;

export type ReferenceKind = "thread" | "frame" | "scope" | "variable";

type ReferenceGenerator = () => string;

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

function generateReference(): string {
  return randomBytes(REFERENCE_BYTES).toString("base64url");
}

/** Stores raw DAP handles behind generation-bound, lifetime-unique references. */
export class ReferenceStore {
  readonly #generate: ReferenceGenerator;
  readonly #records = new Map<string, ReferenceRecord>();
  readonly #referencesBySession = new Map<string, Set<string>>();
  readonly #issued = new Set<string>();

  public constructor(generate: ReferenceGenerator = generateReference) {
    this.#generate = generate;
  }

  public create<T>(
    sessionId: string,
    generation: number,
    kind: ReferenceKind,
    value: T,
  ): string {
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
      const reference = this.#generate();
      if (reference.length === 0 || this.#issued.has(reference)) {
        continue;
      }

      this.#issued.add(reference);
      this.#records.set(reference, { sessionId, generation, kind, value });
      let references = this.#referencesBySession.get(sessionId);
      if (references === undefined) {
        references = new Set<string>();
        this.#referencesBySession.set(sessionId, references);
      }
      references.add(reference);
      return reference;
    }

    throw new Error("Unable to allocate a unique debugger reference.");
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
}
