import type * as vscode from "vscode";

import { dapFailureError } from "../tools/errors.js";

export interface DapThread {
  readonly id: number;
  readonly name: string;
}

export interface DapSource {
  readonly name?: string;
  readonly path?: string;
}

export interface DapStackFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly column?: number;
  readonly source?: DapSource;
}

export interface DapStackTrace {
  readonly stackFrames: readonly DapStackFrame[];
  readonly totalFrames?: number;
}

export interface DapScope {
  readonly name: string;
  readonly variablesReference: number;
  readonly expensive: boolean;
}

export interface DapVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variablesReference: number;
}

export interface DapEvaluation {
  readonly result: string;
  readonly type?: string;
  readonly variablesReference: number;
}

/** The only component which sends and validates raw Debug Adapter Protocol. */
export class DapGateway {
  public threads(session: vscode.DebugSession): Promise<readonly DapThread[]> {
    return this.#request(session, "threads", {}, parseThreads);
  }

  public stackTrace(
    session: vscode.DebugSession,
    threadId: number,
    startFrame: number,
    levels: number,
  ): Promise<DapStackTrace> {
    return this.#validated(() => this.#request(
      session,
      "stackTrace",
      {
        threadId: positiveHandle(threadId),
        startFrame: nonNegativeInteger(startFrame),
        levels: boundedPositiveInteger(levels, 20),
      },
      parseStackTrace,
    ));
  }

  public scopes(
    session: vscode.DebugSession,
    frameId: number,
  ): Promise<readonly DapScope[]> {
    return this.#validated(() => this.#request(
      session,
      "scopes",
      { frameId: positiveHandle(frameId) },
      parseScopes,
    ));
  }

  public variables(
    session: vscode.DebugSession,
    variablesReference: number,
    start: number,
    count: number,
  ): Promise<readonly DapVariable[]> {
    return this.#validated(() => this.#request(
      session,
      "variables",
      {
        variablesReference: positiveHandle(variablesReference),
        start: nonNegativeInteger(start),
        count: boundedPositiveInteger(count, 100),
      },
      parseVariables,
    ));
  }

  public evaluateSafe(
    session: vscode.DebugSession,
    frameId: number,
    expression: string,
  ): Promise<DapEvaluation> {
    return this.#evaluate(session, frameId, expression, "hover");
  }

  public evaluateExplicit(
    session: vscode.DebugSession,
    frameId: number,
    expression: string,
  ): Promise<DapEvaluation> {
    return this.#evaluate(session, frameId, expression, "repl");
  }

  public pause(session: vscode.DebugSession, threadId: number): Promise<void> {
    return this.#control(session, "pause", threadId);
  }

  public continue(session: vscode.DebugSession, threadId: number): Promise<void> {
    return this.#control(session, "continue", threadId);
  }

  public stepIn(session: vscode.DebugSession, threadId: number): Promise<void> {
    return this.#control(session, "stepIn", threadId);
  }

  public next(session: vscode.DebugSession, threadId: number): Promise<void> {
    return this.#control(session, "next", threadId);
  }

  public stepOut(session: vscode.DebugSession, threadId: number): Promise<void> {
    return this.#control(session, "stepOut", threadId);
  }

  async #evaluate(
    session: vscode.DebugSession,
    frameId: number,
    expression: string,
    context: "hover" | "repl",
  ): Promise<DapEvaluation> {
    return this.#validated(() => this.#request(
      session,
      "evaluate",
      {
        frameId: positiveHandle(frameId),
        expression: boundedExpression(expression),
        context,
      },
      parseEvaluation,
    ));
  }

  async #control(
    session: vscode.DebugSession,
    command: "pause" | "continue" | "stepIn" | "next" | "stepOut",
    threadId: number,
  ): Promise<void> {
    await this.#validated(() => this.#request(
      session,
      command,
      { threadId: positiveHandle(threadId) },
      (value) => parseControlResponse(value, command !== "continue"),
    ));
  }

  async #validated<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw Object.freeze(dapFailureError());
    }
  }

  async #request<T>(
    session: vscode.DebugSession,
    command: string,
    body: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return parse(await session.customRequest(command, body));
    } catch {
      throw Object.freeze(dapFailureError());
    }
  }
}

function parseThreads(value: unknown): readonly DapThread[] {
  const input = record(value);
  const threads = array(input.threads);
  return Object.freeze(threads.map((entry) => {
    const thread = record(entry);
    return Object.freeze({
      id: positiveHandle(thread.id),
      name: nonEmptyString(thread.name),
    });
  }));
}

function parseStackTrace(value: unknown): DapStackTrace {
  const input = record(value);
  const stackFrames = Object.freeze(array(input.stackFrames).map((entry) => {
    const frame = record(entry);
    const result: {
      id: number;
      name: string;
      line: number;
      column?: number;
      source?: DapSource;
    } = {
      id: positiveHandle(frame.id),
      name: nonEmptyString(frame.name),
      line: positiveHandle(frame.line),
    };
    if (frame.column !== undefined) {
      result.column = positiveHandle(frame.column);
    }
    if (frame.source !== undefined) {
      const source = record(frame.source);
      const parsed: { name?: string; path?: string } = {};
      if (source.name !== undefined) {
        parsed.name = nonEmptyString(source.name);
      }
      if (source.path !== undefined) {
        parsed.path = nonEmptyString(source.path);
      }
      result.source = Object.freeze(parsed);
    }
    return Object.freeze(result);
  }));
  const result: { stackFrames: readonly DapStackFrame[]; totalFrames?: number } = {
    stackFrames,
  };
  if (input.totalFrames !== undefined) {
    result.totalFrames = nonNegativeInteger(input.totalFrames);
  }
  return Object.freeze(result);
}

function parseScopes(value: unknown): readonly DapScope[] {
  const input = record(value);
  return Object.freeze(array(input.scopes).map((entry) => {
    const scope = record(entry);
    if (scope.expensive !== undefined && typeof scope.expensive !== "boolean") {
      throw new TypeError("invalid scope");
    }
    return Object.freeze({
      name: nonEmptyString(scope.name),
      variablesReference: positiveHandle(scope.variablesReference),
      expensive: scope.expensive === true,
    });
  }));
}

function parseVariables(value: unknown): readonly DapVariable[] {
  const input = record(value);
  return Object.freeze(array(input.variables).map((entry) => {
    const variable = record(entry);
    const result: {
      name: string;
      value: string;
      type?: string;
      variablesReference: number;
    } = {
      name: nonEmptyString(variable.name),
      value: requiredString(variable.value),
      variablesReference: childHandle(variable.variablesReference),
    };
    if (variable.type !== undefined) {
      result.type = requiredString(variable.type);
    }
    return Object.freeze(result);
  }));
}

function parseEvaluation(value: unknown): DapEvaluation {
  const input = record(value);
  const result: { result: string; type?: string; variablesReference: number } = {
    result: requiredString(input.result),
    variablesReference: childHandle(input.variablesReference),
  };
  if (input.type !== undefined) {
    result.type = requiredString(input.type);
  }
  return Object.freeze(result);
}

function parseControlResponse(value: unknown, allowsUndefined: boolean): void {
  if (allowsUndefined && value === undefined) {
    return;
  }
  const input = record(value);
  if (
    input.allThreadsContinued !== undefined &&
    typeof input.allThreadsContinued !== "boolean"
  ) {
    throw new TypeError("invalid control response");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid DAP response");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("invalid DAP response array");
  }
  return value;
}

function positiveHandle(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError("invalid DAP handle");
  }
  return value as number;
}

function childHandle(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("invalid DAP child handle");
  }
  return value as number;
}

function boundedPositiveInteger(value: unknown, maximum: number): number {
  const result = positiveHandle(value);
  if (result > maximum) {
    throw new TypeError("invalid bounded DAP integer");
  }
  return result;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("invalid DAP integer");
  }
  return value as number;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("invalid DAP string");
  }
  return value;
}

function nonEmptyString(value: unknown): string {
  const result = requiredString(value);
  if (result.length === 0) {
    throw new TypeError("invalid empty DAP string");
  }
  return result;
}

function boundedExpression(value: unknown): string {
  const expression = nonEmptyString(value);
  if (expression.length > 4_096) {
    throw new TypeError("invalid expression length");
  }
  return expression;
}
