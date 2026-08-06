// Real Gateway proof for private run identity binding at approval creation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { executionIdentity } from "../agents/agent-command-execution-identity.js";
import type { PreparedAgentCommandExecution } from "../agents/command/prepare.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createGatewayToolCallerWrapper } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import {
  createExecutionIdentityAdmissionToken,
  getExecutionIdentityAdmissionScope,
} from "../audit/execution-identity-admission.js";
import { clearConfigCache } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "./test-helpers.e2e.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

type Cleanup = () => Promise<void> | void;

function prepared(params: {
  cfg: OpenClawConfig;
  runId: string;
  incidentalToken?: ReturnType<typeof createExecutionIdentityAdmissionToken>;
}): PreparedAgentCommandExecution {
  return {
    cfg: params.cfg,
    runId: params.runId,
    opts: {
      message: "approval identity e2e",
      runId: params.runId,
      ...(params.incidentalToken
        ? {
            executionIdentityAdmission: {
              token: params.incidentalToken,
              retryOnly: true,
            },
          }
        : {}),
    },
  } as PreparedAgentCommandExecution;
}

describe("execution identity approval Gateway e2e", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("binds only exact enabled local tool identity across restart and same-run reuse", async () => {
    const envSnapshot = captureEnv(ENV_KEYS);
    cleanup.push(() => envSnapshot.restore());
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-execution-approval-e2e-"));
    cleanup.push(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(home, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });

    const port = await getFreeGatewayPort();
    const gatewayToken = "execution-approval-e2e-token";
    const enabledConfig: OpenClawConfig = {
      gateway: { port, auth: { mode: "token", token: gatewayToken } },
      logging: { audit: { enabled: true, executionIdentity: true } },
      plugins: { enabled: false },
    };
    await fs.writeFile(configPath, JSON.stringify(enabledConfig), "utf8");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
    setRuntimeConfigSnapshot(enabledConfig, enabledConfig);

    let server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(async () => server.close());
    const url = `ws://127.0.0.1:${port}`;

    const requestFromRun = async (params: {
      id: string;
      preparedRunId: string;
      requestRunId: string;
      cfg: OpenClawConfig;
      incidentalToken?: ReturnType<typeof createExecutionIdentityAdmissionToken>;
    }) =>
      await executionIdentity.runPrepared({
        prepared: prepared({
          cfg: params.cfg,
          runId: params.preparedRunId,
          incidentalToken: params.incidentalToken,
        }),
        run: async () => {
          const scope = getExecutionIdentityAdmissionScope();
          executionIdentity.record({
            agentId: "main",
            cfg: params.cfg,
            ingress: executionIdentity.localIngress,
            runId: params.preparedRunId,
            runtimeKind: "embedded",
          });
          const wrap = createGatewayToolCallerWrapper("main", {
            agentSessionKey: "agent:main:main",
          });
          const tool = wrap({
            name: "approval_identity_e2e",
            label: "Approval identity E2E",
            description: "test-only approval request",
            parameters: Type.Object({}),
            execute: async () =>
              await callGatewayTool(
                "exec.approval.request",
                { timeoutMs: 30_000 },
                {
                  id: params.id,
                  command: "printf smoke",
                  cwd: "/tmp",
                  host: "local",
                  ask: "always",
                  runId: params.requestRunId,
                  twoPhase: true,
                  requireDeliveryRoute: false,
                  timeoutMs: 60_000,
                },
              ),
          } as AnyAgentTool);
          await tool.execute?.("approval-call", {});
          return {
            token: scope?.token,
            transported: scope !== undefined,
          };
        },
      });

    const first = await requestFromRun({
      id: "exact-first",
      preparedRunId: "shared-run",
      requestRunId: "shared-run",
      cfg: enabledConfig,
    });
    const second = await requestFromRun({
      id: "exact-second",
      preparedRunId: "shared-run",
      requestRunId: "shared-run",
      cfg: enabledConfig,
    });
    expect(first.token).toBeDefined();
    expect(second.token).toBeDefined();
    expect(first.token?.executionId).not.toBe(second.token?.executionId);

    const mismatch = await requestFromRun({
      id: "trusted-mismatch",
      preparedRunId: "token-run",
      requestRunId: "different-source-run",
      cfg: enabledConfig,
    });
    expect(mismatch.transported).toBe(true);

    const ordinary = await connectGatewayClient({
      url,
      token: gatewayToken,
      clientDisplayName: "ordinary approval requester",
      scopes: [APPROVALS_SCOPE],
      timeoutMs: 60_000,
    });
    await ordinary.request("exec.approval.request", {
      id: "ordinary-same-run",
      command: "printf ordinary",
      cwd: "/tmp",
      host: "local",
      ask: "always",
      runId: "shared-run",
      twoPhase: true,
      requireDeliveryRoute: false,
      timeoutMs: 60_000,
    });
    await disconnectGatewayClient(ordinary);

    const incidentalToken = createExecutionIdentityAdmissionToken("disabled-run", {
      contextId: "disabled-context",
      executionId: "disabled-execution",
      now: 123,
    });
    const disabledConfig: OpenClawConfig = {
      ...enabledConfig,
      logging: { audit: { enabled: true, executionIdentity: false } },
    };
    setRuntimeConfigSnapshot(disabledConfig, disabledConfig);
    const disabled = await requestFromRun({
      id: "disabled",
      preparedRunId: "disabled-run",
      requestRunId: "disabled-run",
      cfg: disabledConfig,
      incidentalToken,
    });
    expect(disabled).toEqual({ token: undefined, transported: false });

    await server.close();
    const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const owner = (id: string) => {
      const result = getOperatorApprovalDetailed({ id, databaseOptions });
      expect(result.outcome).toBe("found");
      return result.outcome === "found" ? result.record.source : undefined;
    };
    expect(owner("exact-first")).toMatchObject({
      runId: "shared-run",
      contextId: first.token?.contextId,
      executionId: first.token?.executionId,
    });
    expect(owner("exact-second")).toMatchObject({
      runId: "shared-run",
      contextId: second.token?.contextId,
      executionId: second.token?.executionId,
    });
    expect(owner("trusted-mismatch")).toMatchObject({
      runId: "different-source-run",
      contextId: null,
      executionId: null,
    });
    expect(owner("ordinary-same-run")).toMatchObject({
      runId: "shared-run",
      contextId: null,
      executionId: null,
    });
    expect(owner("disabled")).toMatchObject({
      runId: "disabled-run",
      contextId: null,
      executionId: null,
    });
    const stateDb = openOpenClawStateDatabase(databaseOptions).db;
    expect(
      stateDb
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_identity_contexts WHERE execution_id = ? OR run_id = ?",
        )
        .get("disabled-execution", "disabled-run"),
    ).toEqual({ count: 0 });
    expect(
      stateDb
        .prepare(
          "SELECT execution_id FROM execution_identity_contexts WHERE run_id = ? ORDER BY execution_id",
        )
        .all("shared-run"),
    ).toEqual(
      [first.token!.executionId, second.token!.executionId]
        .toSorted((left, right) => left.localeCompare(right))
        .map((executionId) => ({ execution_id: executionId })),
    );

    setRuntimeConfigSnapshot(enabledConfig, enabledConfig);
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    expect(owner("exact-first")).toMatchObject({
      contextId: first.token?.contextId,
      executionId: first.token?.executionId,
    });
  }, 300_000);
});
