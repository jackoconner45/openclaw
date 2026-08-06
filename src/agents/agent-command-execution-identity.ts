import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  getExecutionIdentityAdmissionScope,
  parseExecutionIdentityAdmissionToken,
  runWithExecutionIdentityAdmissionScope,
  type ExecutionIdentityAdmissionFacts,
} from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedAgentCommandExecution } from "./command/prepare.js";

type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const LOCAL_CLI_ADMISSION_INGRESS: AgentCommandAdmissionIngress = {
  kind: "local-cli",
  boundary: "agent-command.local",
  state: "present",
};

function systemIngress(boundary: string): AgentCommandAdmissionIngress {
  return { kind: "system", boundary, state: "present" };
}

function recordAgentCommandExecutionIdentity(params: {
  agentId: string;
  cfg: OpenClawConfig;
  ingress: AgentCommandAdmissionIngress;
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
}): void {
  const admission = getExecutionIdentityAdmissionScope();
  if (!admission || !isExecutionIdentityCollectionEnabled(params.cfg)) {
    return;
  }
  // Session work admission owns these facts. Queue acceptance is not persistence;
  // audit loss must never become run loss.
  enqueueExecutionIdentityContextAtAdmission(
    {
      runId: params.runId,
      agentId: params.agentId,
      ingress: params.ingress,
      runtime: { kind: params.runtimeKind },
    },
    {
      enabled: true,
      token: admission.token,
      retryOnly: admission.retryOnly,
    },
  );
}

async function runPreparedAgentCommandWithExecutionIdentity<TResult>(params: {
  prepared: PreparedAgentCommandExecution;
  run: (prepared: PreparedAgentCommandExecution) => Promise<TResult>;
}): Promise<TResult> {
  const { executionIdentityAdmission, ...sanitizedOpts } = params.prepared.opts;
  const prepared = { ...params.prepared, opts: sanitizedOpts };
  if (!isExecutionIdentityCollectionEnabled(prepared.cfg)) {
    return await params.run(prepared);
  }
  const token = executionIdentityAdmission
    ? parseExecutionIdentityAdmissionToken(executionIdentityAdmission.token)
    : createExecutionIdentityAdmissionToken(prepared.runId);
  if (token.runId !== prepared.runId) {
    throw new Error("execution identity admission token disagrees with the prepared run");
  }
  return await runWithExecutionIdentityAdmissionScope(
    { token, retryOnly: executionIdentityAdmission?.retryOnly === true },
    () => params.run(prepared),
  );
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  record: recordAgentCommandExecutionIdentity,
  runPrepared: runPreparedAgentCommandWithExecutionIdentity,
  systemIngress,
};
