import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-operator-approval-identity-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(id: string, source: NewOperatorApproval["source"]): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      commandPreview: `echo ${id}`,
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source,
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
  };
}

const boundSource = {
  agentId: "main",
  sessionKey: "agent:main:child",
  sessionId: "session-1",
  runId: "run-1",
  contextId: "context-1",
  executionId: "execution-1",
  toolCallId: "tool-call-1",
  toolName: "exec",
};

describe("operator approval execution identity", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("binds one immutable pair idempotently across resolution and reopen", () => {
    const databaseOptions = createDatabaseOptions();
    const input = approval("bound", boundSource);
    expect(insertOperatorApproval({ approval: input, databaseOptions })).toMatchObject({
      outcome: "inserted",
      record: { source: { contextId: "context-1", executionId: "execution-1" } },
    });
    expect(insertOperatorApproval({ approval: input, databaseOptions })).toMatchObject({
      outcome: "existing",
    });
    expect(
      insertOperatorApproval({
        approval: approval("bound", { ...boundSource, executionId: "execution-other" }),
        databaseOptions,
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      resolveOperatorApproval({
        id: "bound",
        decision: "allow-once",
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "resolved",
      record: { source: { contextId: "context-1", executionId: "execution-1" } },
    });
    closeOpenClawStateDatabaseForTest();
    expect(
      getOperatorApprovalDetailed({ id: "bound", nowMs: 2_001, databaseOptions }),
    ).toMatchObject({
      outcome: "found",
      record: { source: { contextId: "context-1", executionId: "execution-1" } },
    });
  });

  it("rejects partial input and treats a partial persisted row as corrupt", () => {
    const databaseOptions = createDatabaseOptions();
    expect(() =>
      insertOperatorApproval({
        approval: approval("partial-new", {
          ...boundSource,
          contextId: "context-only",
          executionId: null,
        }),
        databaseOptions,
      }),
    ).toThrow("bind context and execution together");
    insertOperatorApproval({
      approval: approval("partial-row", boundSource),
      databaseOptions,
    });
    openOpenClawStateDatabase(databaseOptions)
      .db.prepare(
        "UPDATE operator_approvals SET source_execution_id = NULL WHERE approval_id = 'partial-row'",
      )
      .run();
    expect(
      getOperatorApprovalDetailed({ id: "partial-row", nowMs: 2_000, databaseOptions }),
    ).toEqual({ outcome: "corrupt" });
  });
});
