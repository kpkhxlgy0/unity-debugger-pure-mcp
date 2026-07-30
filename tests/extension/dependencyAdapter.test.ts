import { describe, expect, it, vi } from "vitest";

import { DependencyAdapter } from "../../src/dependencyAdapter.js";

const target = Object.freeze({
  targetId: "opaque-target",
  processId: 4312,
  projectName: "MyGame",
  workspaceRoot: "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame",
  projectVersion: "2022.3.50f1",
  source: "advertisement" as const,
});

function validApi(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    extensionVersion: "0.2.0",
    debugType: "unity-debugger-pure",
    discoverTargets: async () => [target],
    startAttach: async (targetId: string) => ({
      sessionId: "vscode-session-internal",
      targetId,
    }),
    ...overrides,
  };
}

describe("DependencyAdapter", () => {
  it("requests only the exact debugger extension and accepts API version 1", async () => {
    const requestedIds: string[] = [];
    const adapter = new DependencyAdapter((extensionId) => {
      requestedIds.push(extensionId);
      return { activate: async () => validApi() };
    });

    await expect(adapter.activate()).resolves.toMatchObject({
      apiVersion: 1,
      extensionVersion: "0.2.0",
      debugType: "unity-debugger-pure",
    });
    expect(requestedIds).toEqual(["kpk.unity-debugger-pure"]);
  });

  it.each([
    undefined,
    { apiVersion: 2 },
    { ...validApi(), debugType: "other" },
    { ...validApi(), extensionVersion: 2 },
    { ...validApi(), discoverTargets: undefined },
    { ...validApi(), startAttach: "not-a-function" },
  ])("rejects incompatible dependency API %#", async (api) => {
    const adapter = new DependencyAdapter(() => ({ activate: async () => api }));

    await expect(adapter.activate()).rejects.toEqual({
      code: "INCOMPATIBLE_DEBUGGER_API",
      message: "The Unity debugger extension API is unavailable or incompatible.",
      retryable: false,
      currentState: "dependency_unavailable",
      action: "Install or update kpk.unity-debugger-pure and retry the request.",
    });
  });

  it("preserves the public API receiver while delegating methods", async () => {
    class ReceiverApi {
      readonly apiVersion = 1 as const;
      readonly extensionVersion = "0.2.0";
      readonly debugType = "unity-debugger-pure" as const;
      readonly marker = "bound-receiver";

      async discoverTargets() {
        if (this.marker !== "bound-receiver") {
          throw new Error("lost receiver");
        }
        return [target];
      }

      async startAttach(targetId: string) {
        if (this.marker !== "bound-receiver") {
          throw new Error("lost receiver");
        }
        return { sessionId: "session-internal", targetId };
      }
    }
    const adapter = new DependencyAdapter(() => ({
      activate: async () => new ReceiverApi(),
    }));

    await expect(adapter.discoverTargets([target.workspaceRoot])).resolves.toEqual([target]);
    await expect(adapter.startAttach(target.targetId)).resolves.toEqual({
      sessionId: "session-internal",
      targetId: target.targetId,
    });
  });

  it("shares concurrent activation, caches success, and retries after failure", async () => {
    let releaseFirst!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    const adapter = new DependencyAdapter(() => ({
      activate: async () => {
        attempts += 1;
        if (attempts === 1) {
          await firstAttempt;
          throw new Error("private activation failure");
        }
        return validApi();
      },
    }));

    const first = adapter.activate();
    const concurrent = adapter.activate();
    releaseFirst();
    const failed = await Promise.allSettled([first, concurrent]);

    expect(attempts).toBe(1);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(adapter.activate()).resolves.toMatchObject({ apiVersion: 1 });
    await expect(adapter.activate()).resolves.toMatchObject({ apiVersion: 1 });
    expect(attempts).toBe(2);
  });

  it("reads validated API members once so mutable getters cannot bypass validation", async () => {
    let versionReads = 0;
    const api = validApi();
    Object.defineProperty(api, "extensionVersion", {
      configurable: true,
      get() {
        versionReads += 1;
        return versionReads === 1 ? "0.2.0" : 7;
      },
    });
    const adapter = new DependencyAdapter(() => ({ activate: async () => api }));

    await expect(adapter.activate()).resolves.toMatchObject({
      extensionVersion: "0.2.0",
    });
    expect(versionReads).toBe(1);
  });

  it("captures the extension activate getter once before validation and invocation", async () => {
    let activateReads = 0;
    const extension = {
      marker: "extension-receiver",
      get activate(): () => Promise<ReturnType<typeof validApi>> {
        activateReads += 1;
        if (activateReads > 1) {
          return undefined as never;
        }
        return async function (this: { marker: string }) {
          if (this.marker !== "extension-receiver") {
            throw new Error("lost extension receiver");
          }
          return validApi();
        };
      },
    };
    const adapter = new DependencyAdapter(() => extension);

    await expect(adapter.activate()).resolves.toMatchObject({ apiVersion: 1 });
    expect(activateReads).toBe(1);
  });

  it("maps public error codes without relaying forged messages or target data", async () => {
    const adapter = new DependencyAdapter(() => ({
      activate: async () => validApi({
        startAttach: async () => {
          throw {
            code: "TARGET_EXPIRED",
            message: "secret target opaque-target expired at an internal path",
            targetId: "opaque-target",
          };
        },
      }),
    }));

    const error = await adapter.startAttach("opaque-target").catch((value) => value);

    expect(error).toEqual({
      code: "TARGET_EXPIRED",
      message: "The selected debugger target is no longer available.",
      retryable: true,
      currentState: "target_unavailable",
      action: "List debugger targets again and retry with a new target reference.",
    });
    expect(JSON.stringify(error)).not.toContain("opaque-target");
    expect(JSON.stringify(error)).not.toContain("internal path");
  });

  it("sanitizes missing, activation, and unknown delegated failures", async () => {
    const missing = new DependencyAdapter(() => undefined);
    const activationFailure = new DependencyAdapter(() => ({
      activate: async () => {
        throw new Error("C:\\private\\activation.log");
      },
    }));
    const delegatedFailure = new DependencyAdapter(() => ({
      activate: async () => validApi({
        discoverTargets: async () => {
          throw new Error("workspace secret");
        },
      }),
    }));

    const errors = await Promise.all([
      missing.activate().catch((error) => error),
      activationFailure.activate().catch((error) => error),
      delegatedFailure.discoverTargets([]).catch((error) => error),
    ]);

    expect(errors[0]).toMatchObject({ code: "INCOMPATIBLE_DEBUGGER_API" });
    expect(errors[1]).toEqual(errors[0]);
    expect(errors[2]).toEqual({
      code: "DAP_FAILURE",
      message: "The debugger request failed.",
      retryable: false,
      currentState: "unknown",
      action: "Check debugger status before retrying the request.",
    });
    expect(JSON.stringify(errors)).not.toContain("private");
    expect(JSON.stringify(errors)).not.toContain("workspace secret");
  });

  it.each([
    { discoverTargets: async () => ({ targetId: "not-an-array" }) },
    { discoverTargets: async () => [{ ...target, processId: "4312" }] },
    { discoverTargets: async () => [{ ...target, source: "network" }] },
    { startAttach: async () => ({ sessionId: 7, targetId: target.targetId }) },
    { startAttach: async () => ({ sessionId: "session", targetId: "other-target" }) },
  ])("fails closed on malformed delegated result %#", async (overrides) => {
    const adapter = new DependencyAdapter(() => ({
      activate: async () => validApi(overrides),
    }));

    const operation = "discoverTargets" in overrides
      ? adapter.discoverTargets([])
      : adapter.startAttach(target.targetId);

    await expect(operation).rejects.toMatchObject({
      code: "INCOMPATIBLE_DEBUGGER_API",
    });
  });

  it("sanitizes throwing accessors in delegated result objects", async () => {
    const malformedTarget = new Proxy(target, {
      get() {
        throw new Error("secret result getter");
      },
    });
    const adapter = new DependencyAdapter(() => ({
      activate: async () => validApi({
        discoverTargets: async () => [malformedTarget],
      }),
    }));

    const error = await adapter.discoverTargets([]).catch((value) => value);

    expect(error).toMatchObject({ code: "INCOMPATIBLE_DEBUGGER_API" });
    expect(JSON.stringify(error)).not.toContain("secret result getter");
  });

  it("projects each delegated result member from the value that passed validation", async () => {
    let processIdReads = 0;
    const mutableTarget = { ...target } as Record<string, unknown>;
    Object.defineProperty(mutableTarget, "processId", {
      get() {
        processIdReads += 1;
        return processIdReads === 1 ? 4312 : "forged-after-validation";
      },
    });
    const adapter = new DependencyAdapter(() => ({
      activate: async () => validApi({
        discoverTargets: async () => [mutableTarget],
      }),
    }));

    await expect(adapter.discoverTargets([])).resolves.toMatchObject([
      { processId: 4312 },
    ]);
    expect(processIdReads).toBe(1);
  });
});
