import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { DapGateway } from "../../src/debug/dapGateway.js";

function sessionWith(response: unknown): vscode.DebugSession {
  return {
    customRequest: vi.fn(async () => response),
  } as unknown as vscode.DebugSession;
}

describe("DapGateway", () => {
  it("sends exact bounded inspection request bodies", async () => {
    const requests: Array<[string, unknown]> = [];
    const session = {
      customRequest: vi.fn(async (command: string, body: unknown) => {
        requests.push([command, body]);
        switch (command) {
          case "threads":
            return { threads: [{ id: 7, name: "Main Thread" }] };
          case "stackTrace":
            return { stackFrames: [{ id: 42, name: "Tick", line: 9, column: 2 }] };
          case "scopes":
            return { scopes: [{ name: "Locals", variablesReference: 91, expensive: false }] };
          case "variables":
            return { variables: [{ name: "health", value: "100", variablesReference: 0 }] };
          default:
            throw new Error("unexpected request");
        }
      }),
    } as unknown as vscode.DebugSession;
    const gateway = new DapGateway();

    await gateway.threads(session);
    await gateway.stackTrace(session, 7, 0, 20);
    await gateway.scopes(session, 42);
    await gateway.variables(session, 91, 3, 100);

    expect(requests).toEqual([
      ["threads", {}],
      ["stackTrace", { threadId: 7, startFrame: 0, levels: 20 }],
      ["scopes", { frameId: 42 }],
      ["variables", { variablesReference: 91, start: 3, count: 100 }],
    ]);
  });

  it("uses hover only for safe evaluation and repl only for explicit evaluation", async () => {
    const session = sessionWith({ result: "100", variablesReference: 0 });
    const gateway = new DapGateway();

    await gateway.evaluateSafe(session, 42, "health");
    await gateway.evaluateExplicit(session, 42, "ApplyDamage()");

    expect(session.customRequest).toHaveBeenNthCalledWith(1, "evaluate", {
      frameId: 42,
      expression: "health",
      context: "hover",
    });
    expect(session.customRequest).toHaveBeenNthCalledWith(2, "evaluate", {
      frameId: 42,
      expression: "ApplyDamage()",
      context: "repl",
    });
  });

  it("accepts managed frames without source locations using required zero line and column", async () => {
    const session = sessionWith({
      stackFrames: [{ id: 42, name: "Managed Frame", line: 0, column: 0 }],
    });

    await expect(new DapGateway().stackTrace(session, 7, 0, 20)).resolves.toEqual({
      stackFrames: [{ id: 42, name: "Managed Frame", line: 0, column: 0 }],
    });
  });

  it("sends exact control request bodies", async () => {
    const session = sessionWith({});
    const gateway = new DapGateway();

    await gateway.pause(session, 7);
    await gateway.continue(session, 7);
    await gateway.stepIn(session, 7);
    await gateway.next(session, 7);
    await gateway.stepOut(session, 7);

    expect(session.customRequest).toHaveBeenNthCalledWith(1, "pause", { threadId: 7 });
    expect(session.customRequest).toHaveBeenNthCalledWith(2, "continue", { threadId: 7 });
    expect(session.customRequest).toHaveBeenNthCalledWith(3, "stepIn", { threadId: 7 });
    expect(session.customRequest).toHaveBeenNthCalledWith(4, "next", { threadId: 7 });
    expect(session.customRequest).toHaveBeenNthCalledWith(5, "stepOut", { threadId: 7 });
  });

  it("accepts VS Code undefined results for adapter controls with no response body", async () => {
    const session = sessionWith(undefined);
    const gateway = new DapGateway();

    await expect(gateway.pause(session, 7)).resolves.toBeUndefined();
    await expect(gateway.stepIn(session, 7)).resolves.toBeUndefined();
    await expect(gateway.next(session, 7)).resolves.toBeUndefined();
    await expect(gateway.stepOut(session, 7)).resolves.toBeUndefined();
  });

  it.each([
    ["threads", { threads: [{ id: 1, name: "ok" }, { id: 0, name: "bad" }] }],
    ["stackTrace", { stackFrames: [{ id: 4, name: "Tick", line: 1 }] }],
    ["scopes", { scopes: [{ name: "Locals", variablesReference: -1 }] }],
    ["variables", { variables: [{ name: "x", value: 1, variablesReference: 0 }] }],
    ["evaluate", { result: "ok", variablesReference: Number.NaN }],
  ])("sanitizes malformed nested %s responses", async (command, response) => {
    const privateValue = "C:\\private\\secret.cs";
    const session = sessionWith(response);
    const gateway = new DapGateway();
    const operation = command === "threads"
      ? gateway.threads(session)
      : command === "stackTrace"
      ? gateway.stackTrace(session, 1, 0, 20)
      : command === "scopes"
      ? gateway.scopes(session, 1)
      : command === "variables"
      ? gateway.variables(session, 1, 0, 100)
      : gateway.evaluateSafe(session, 1, privateValue);

    const error = await operation.catch((value) => value);
    expect(error).toMatchObject({ code: "DAP_FAILURE" });
    expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it.each([
    { id: 4, name: "Tick", column: 1 },
    { id: 4, name: "Tick", line: 1 },
    { id: 4, name: "Tick", line: "1", column: 1 },
    { id: 4, name: "Tick", line: 1, column: "1" },
  ])("rejects a stack frame missing or mistyping required locations", async (frame) => {
    const session = sessionWith({ stackFrames: [frame] });

    await expect(new DapGateway().stackTrace(session, 7, 0, 20))
      .rejects.toMatchObject({ code: "DAP_FAILURE" });
  });

  it.each([
    { name: "Locals", variablesReference: 1 },
    { name: "Locals", variablesReference: 1, expensive: "false" },
  ])("rejects a scope without a required boolean expensive field", async (scope) => {
    const session = sessionWith({ scopes: [scope] });

    await expect(new DapGateway().scopes(session, 42))
      .rejects.toMatchObject({ code: "DAP_FAILURE" });
  });

  it("sanitizes customRequest throws without echoing private details", async () => {
    const session = {
      customRequest: vi.fn(async () => {
        throw new Error("expression ApplyDamage() at C:\\private\\Player.cs");
      }),
    } as unknown as vscode.DebugSession;

    const error = await new DapGateway().evaluateExplicit(session, 9, "ApplyDamage()")
      .catch((value) => value);

    expect(error).toEqual({
      code: "DAP_FAILURE",
      message: "The debugger request failed.",
      retryable: false,
      currentState: "unknown",
      action: "Check debugger status before retrying the request.",
    });
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("sanitizes invalid local handles and expressions before customRequest", async () => {
    const session = sessionWith({ stackFrames: [] });
    const gateway = new DapGateway();

    for (const operation of [
      gateway.stackTrace(session, 0, 0, 20),
      gateway.stackTrace(session, 9, 0, 21),
      gateway.variables(session, 9, -1, 100),
      gateway.variables(session, 9, 0, 101),
      gateway.evaluateSafe(session, 4, ""),
      gateway.evaluateExplicit(session, 4, "x".repeat(4_097)),
    ]) {
      await expect(operation).rejects.toMatchObject({ code: "DAP_FAILURE" });
    }
    expect(session.customRequest).not.toHaveBeenCalled();
  });
});
