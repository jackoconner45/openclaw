import { describe, expect, it } from "vitest";
import {
  createExecutionIdentityAdmissionToken,
  getExecutionIdentityAdmissionScope,
} from "../audit/execution-identity-admission.js";
import { executionIdentity } from "./agent-command-execution-identity.js";
import type { PreparedAgentCommandExecution } from "./command/prepare.js";

function prepared(params: {
  runId: string;
  enabled: boolean;
  admission?: PreparedAgentCommandExecution["opts"]["executionIdentityAdmission"];
}): PreparedAgentCommandExecution {
  return {
    runId: params.runId,
    cfg: {
      logging: {
        audit: { enabled: params.enabled, executionIdentity: params.enabled },
      },
    },
    opts: {
      message: "test",
      runId: params.runId,
      ...(params.admission ? { executionIdentityAdmission: params.admission } : {}),
    },
  } as PreparedAgentCommandExecution;
}

describe("prepared agent-command execution identity", () => {
  it("allocates one immutable token per enabled execution and reuses it throughout the run", async () => {
    const observed = await Promise.all(
      [1, 2].map(
        async () =>
          await executionIdentity.runPrepared({
            prepared: prepared({ runId: "shared-run", enabled: true }),
            run: async (scopedPrepared) => {
              const first = getExecutionIdentityAdmissionScope();
              const fallbackAttempts = [];
              for (const model of ["primary", "fallback-1", "fallback-2"]) {
                await Promise.resolve(model);
                fallbackAttempts.push(getExecutionIdentityAdmissionScope());
              }
              expect(scopedPrepared.opts).not.toHaveProperty("executionIdentityAdmission");
              expect(fallbackAttempts).toEqual([first, first, first]);
              expect(Object.isFrozen(first)).toBe(true);
              expect(Object.isFrozen(first?.token)).toBe(true);
              return first?.token;
            },
          }),
      ),
    );

    expect(observed[0]?.runId).toBe("shared-run");
    expect(observed[1]?.runId).toBe("shared-run");
    expect(observed[0]?.contextId).not.toBe(observed[1]?.contextId);
    expect(observed[0]?.executionId).not.toBe(observed[1]?.executionId);
    expect(getExecutionIdentityAdmissionScope()).toBeUndefined();
  });

  it("adopts only the exact saved retry token", async () => {
    const token = createExecutionIdentityAdmissionToken("retry-run", {
      contextId: "retry-context",
      executionId: "retry-execution",
      now: 123,
    });

    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({
          runId: "retry-run",
          enabled: true,
          admission: { token, retryOnly: true },
        }),
        run: async () => getExecutionIdentityAdmissionScope(),
      }),
    ).resolves.toEqual({ token, retryOnly: true });

    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({
          runId: "different-run",
          enabled: true,
          admission: { token, retryOnly: true },
        }),
        run: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("isolates independent child roots from an inherited parent identity", async () => {
    await executionIdentity.runPrepared({
      prepared: prepared({ runId: "parent-run", enabled: true }),
      run: async () => {
        const parent = getExecutionIdentityAdmissionScope();
        await Promise.resolve();
        const child = await executionIdentity.runPrepared({
          prepared: prepared({ runId: "child-run", enabled: true }),
          run: async () => getExecutionIdentityAdmissionScope(),
        });
        expect(child?.token.runId).toBe("child-run");
        expect(child?.token.executionId).not.toBe(parent?.token.executionId);
        expect(getExecutionIdentityAdmissionScope()).toBe(parent);
      },
    });
  });

  it("keeps valid overlong public run identifiers nonblocking and unscoped", async () => {
    const runId = "r".repeat(257);
    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId, enabled: true }),
        run: async () => ({ ran: true, scope: getExecutionIdentityAdmissionScope() }),
      }),
    ).resolves.toEqual({ ran: true, scope: undefined });
  });

  it("drops an incidental token entirely while collection is disabled", async () => {
    const token = createExecutionIdentityAdmissionToken("disabled-run");
    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({
          runId: "disabled-run",
          enabled: false,
          admission: { token, retryOnly: true },
        }),
        run: async (scopedPrepared) => ({
          scope: getExecutionIdentityAdmissionScope(),
          retained: Object.hasOwn(scopedPrepared.opts, "executionIdentityAdmission"),
        }),
      }),
    ).resolves.toEqual({ scope: undefined, retained: false });
  });
});
