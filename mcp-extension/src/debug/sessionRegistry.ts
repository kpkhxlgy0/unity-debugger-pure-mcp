import { randomBytes as nodeRandomBytes } from "node:crypto";
import type * as vscode from "vscode";

import type { StructuredToolError } from "../tools/errors.js";

const DEBUG_TYPE = "unity-debugger-pure";
const SESSION_REF_BYTES = 16;
const MAX_COLLISION_RETRIES = 128;

export interface SessionSelection {
  readonly sessionRef: string;
  readonly tracked: boolean;
}

interface SessionEntry {
  readonly sessionRef: string;
  session: vscode.DebugSession;
  tracked: boolean;
}

type RandomBytes = (size: number) => Buffer;

export class SessionRegistry {
  readonly #randomBytes: RandomBytes;
  readonly #bySessionId = new Map<string, SessionEntry>();
  readonly #bySessionRef = new Map<string, SessionEntry>();
  readonly #issuedSessionRefs = new Set<string>();

  public constructor(randomBytes: RandomBytes = nodeRandomBytes) {
    this.#randomBytes = randomBytes;
  }

  public register(
    session: vscode.DebugSession,
    tracked: boolean,
  ): SessionSelection | undefined {
    if (session.type !== DEBUG_TYPE || session.id.length === 0) {
      return undefined;
    }

    const existing = this.#bySessionId.get(session.id);
    if (existing !== undefined) {
      existing.session = session;
      existing.tracked ||= tracked;
      return viewOf(existing);
    }

    const entry: SessionEntry = {
      sessionRef: this.#newSessionRef(),
      session,
      tracked,
    };
    this.#bySessionId.set(session.id, entry);
    this.#bySessionRef.set(entry.sessionRef, entry);
    return viewOf(entry);
  }

  public remove(session: vscode.DebugSession): boolean {
    const entry = this.#bySessionId.get(session.id);
    if (entry === undefined || entry.session !== session) {
      return false;
    }
    this.#bySessionId.delete(session.id);
    this.#bySessionRef.delete(entry.sessionRef);
    return true;
  }

  public select(sessionRef?: string): SessionSelection {
    if (sessionRef !== undefined) {
      const explicit = this.#bySessionRef.get(sessionRef);
      if (explicit === undefined) {
        throw notAttachedError();
      }
      return viewOf(explicit);
    }

    if (this.#bySessionRef.size === 0) {
      throw notAttachedError();
    }
    if (this.#bySessionRef.size > 1) {
      throw ambiguousSessionError();
    }
    return viewOf(this.#bySessionRef.values().next().value as SessionEntry);
  }

  public selectForInspection(sessionRef?: string): SessionSelection {
    const selection = this.select(sessionRef);
    if (!selection.tracked) {
      throw sessionUntrackedError();
    }
    return selection;
  }

  public resolveDebugSession(selection: SessionSelection): vscode.DebugSession {
    const entry = this.#bySessionRef.get(selection.sessionRef);
    if (entry === undefined) {
      throw notAttachedError();
    }
    return entry.session;
  }

  #newSessionRef(): string {
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
      const bytes = this.#randomBytes(SESSION_REF_BYTES);
      if (bytes.byteLength !== SESSION_REF_BYTES) {
        throw new Error("Session reference entropy source returned an invalid length.");
      }
      const sessionRef = bytes.toString("base64url");
      if (!this.#issuedSessionRefs.has(sessionRef)) {
        this.#issuedSessionRefs.add(sessionRef);
        return sessionRef;
      }
    }
    throw new Error("Unable to allocate a unique session reference.");
  }
}

function viewOf(entry: SessionEntry): SessionSelection {
  return Object.freeze({
    sessionRef: entry.sessionRef,
    tracked: entry.tracked,
  });
}

function notAttachedError(): StructuredToolError {
  return Object.freeze({
    code: "NOT_ATTACHED",
    message: "No matching Unity debugger session is attached.",
    retryable: true,
    currentState: "detached",
    action: "Attach to a debugger target and retry the request.",
  });
}

function ambiguousSessionError(): StructuredToolError {
  return Object.freeze({
    code: "AMBIGUOUS_TARGET",
    message: "More than one Unity debugger session is attached.",
    retryable: false,
    currentState: "multiple_sessions",
    action: "Retry with the opaque session reference for the intended session.",
  });
}

function sessionUntrackedError(): StructuredToolError {
  return Object.freeze({
    code: "SESSION_UNTRACKED",
    message: "The selected debugger session is not fully tracked.",
    retryable: false,
    currentState: "untracked",
    action: "Restart that debug session before using inspection tools.",
  });
}
