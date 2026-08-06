// Script-local real-model Gateway/channel sidecar for the Code Mode matrix.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createQaChannelTransport,
  startQaGatewayChild,
  startQaLabServer,
} from "../../extensions/qa-lab/api.js";
import { resolveAgentEffectiveModelPrimary } from "../../src/agents/agent-scope.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../../src/agents/auth-profiles.js";
import { splitTrailingAuthProfile } from "../../src/agents/model-ref-profile.js";
import { buildConversationIdentity } from "../../src/config/sessions/conversation-identity.js";
import { registerConversationAddresses } from "../../src/config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  listSessionEntries,
  loadTranscriptEventsSync,
} from "../../src/plugin-sdk/session-store-runtime.js";

export const CODE_MODE_CONVERSATION_PROOF_PROMPT =
  'OpenClaw Code Mode conversation proof. In one JavaScript or TypeScript exec cell, call conversations_list for the exact label "Build bot". When exactly one candidate matches, call conversations_send once with "Build finished." and return { status: "sent", conversationRef } from the cell. When more than one candidate matches, do not send; return { candidates } containing every matching conversationRef, label, and target. For that ambiguous case, make the final answer exactly three lines: AMBIGUOUS_NO_SEND, then one tab-separated conversationRef, label, and target line for each candidate, with no other text. Keep the lookup, decision, optional send, and return in that single deterministic cell.';

export type CodeModeConversationProofPolicy = {
  api: "openai-responses";
  credentialEnvName: "OPENAI_API_KEY";
  defaultAgentId: string;
  endpoint: "https://api.openai.com/v1";
  model: string;
  provider: "openai";
  runtime: "openclaw";
  thinking: "high";
};

export type CodeModeConversationProofParams = {
  buildSha256: string;
  config: OpenClawConfig;
  configSha256: string;
  executionPolicy: CodeModeConversationProofPolicy;
  frozenEnv: NodeJS.ProcessEnv;
  gitSha: string;
  model: string;
  outputDir: string;
  repoRoot: string;
};

type ConversationProofIdentity = NonNullable<ReturnType<typeof buildConversationIdentity>>;
type ConversationProofMessage = {
  accountId?: string;
  id: string;
  conversation: { id: string; kind?: string };
  direction: string;
  text?: string;
};
type ConversationProofSnapshot = {
  messages: ConversationProofMessage[];
};
type ConversationProofTranscript = {
  assistantTurns: number;
  authoredMethods: string[];
  callCount: number | null;
  completedExecResultCount: number;
  attemptedToolNames: string[];
  attemptedToolNamesTruncated: boolean | null;
  execCallCount: number;
  finalText: string;
  isError: boolean;
  sessionId: string;
  value: unknown;
};
type ConversationProofCell = Record<string, unknown> & {
  id: "Code-exact" | "Code-ambiguous";
  passed: boolean;
};
type ConversationProofSummary = Record<string, unknown> & {
  counts: { failed: number; passed: number; total: number };
  failureCode?: string;
  status: "blocked" | "fail" | "pass";
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,63}$/u.test(message) ? message : "conversation_proof_internal_failure";
}

function normalizeTerminalStatus(value: unknown): "completed" | "failed" | "unknown" {
  if (value === "ok" || value === "completed" || value === "succeeded") {
    return "completed";
  }
  if (value === "error" || value === "failed" || value === "cancelled" || value === "timeout") {
    return "failed";
  }
  return "unknown";
}

function readMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
        .join("")
    : "";
}

function readToolCallInput(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(block.arguments)) {
    return block.arguments;
  }
  if (isRecord(block.input)) {
    return block.input;
  }
  if (typeof block.arguments !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block.arguments) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNewOutboundMessages(
  before: ConversationProofSnapshot,
  after: ConversationProofSnapshot,
): ConversationProofMessage[] {
  const priorIds = new Set(before.messages.map((message) => message.id));
  return after.messages.filter(
    (message) => message.direction === "outbound" && !priorIds.has(message.id),
  );
}

function isExpectedExactOutbound(
  message: ConversationProofMessage | undefined,
  identity: ConversationProofIdentity,
): boolean {
  return (
    message?.accountId === identity.accountId &&
    message.conversation.id === identity.peerId &&
    message.conversation.kind === identity.kind &&
    message.text === "Build finished."
  );
}

async function readAuthoredMethods(code: string): Promise<string[]> {
  const typescript = await import("typescript");
  const source = typescript.createSourceFile(
    "conversation-proof.ts",
    code,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const authoredMethods: string[] = [];
  const visit = (node: import("typescript").Node) => {
    if (
      typescript.isCallExpression(node) &&
      typescript.isPropertyAccessExpression(node.expression) &&
      typescript.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "tools"
    ) {
      authoredMethods.push(node.expression.name.text);
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
  return authoredMethods;
}

async function readConversationProofTranscript(params: {
  agentId: string;
  gatewayTempRoot: string;
  sessionKey: string;
}): Promise<ConversationProofTranscript> {
  const runtimeEnv = {
    OPENCLAW_STATE_DIR: path.join(params.gatewayTempRoot, "state"),
  };
  const entry = listSessionEntries({ agentId: params.agentId, env: runtimeEnv }).find(
    (candidate) => candidate.sessionKey === params.sessionKey,
  )?.entry;
  if (!entry?.sessionId) {
    throw new Error("conversation_proof_transcript_missing");
  }
  const events = loadTranscriptEventsSync({
    agentId: params.agentId,
    env: runtimeEnv,
    sessionId: entry.sessionId,
    sessionKey: params.sessionKey,
  });
  let finalText = "";
  let assistantTurns = 0;
  let execCode = "";
  let execToolCallId = "";
  let execResult: Record<string, unknown> | undefined;
  let execCallCount = 0;
  let completedExecResultCount = 0;
  for (const event of events) {
    const message = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    if (!message) {
      continue;
    }
    if (message.role === "assistant") {
      assistantTurns += 1;
      finalText = readMessageText(message) || finalText;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block) || block.name !== "exec") {
          continue;
        }
        execCallCount += 1;
        const input = readToolCallInput(block);
        if (execCallCount === 1) {
          execCode = typeof input?.code === "string" ? input.code : "";
          execToolCallId = typeof block.id === "string" ? block.id : "";
        }
      }
    }
    if (message.role === "toolResult" && message.toolName === "exec") {
      completedExecResultCount += 1;
      if (!execResult && (!execToolCallId || message.toolCallId === execToolCallId)) {
        execResult = message;
      }
    }
  }
  if (!execCode || !execResult) {
    throw new Error("conversation_proof_exec_missing");
  }
  const authoredMethods = await readAuthoredMethods(execCode);
  const details = isRecord(execResult.details) ? execResult.details : {};
  const telemetry = isRecord(details.telemetry) ? details.telemetry : {};
  const attemptedToolNames = Array.isArray(telemetry.attemptedToolNames)
    ? telemetry.attemptedToolNames.filter((name): name is string => typeof name === "string")
    : [];
  return {
    assistantTurns,
    authoredMethods,
    callCount:
      typeof telemetry.callCount === "number" && Number.isSafeInteger(telemetry.callCount)
        ? telemetry.callCount
        : null,
    completedExecResultCount,
    attemptedToolNames,
    attemptedToolNamesTruncated:
      typeof telemetry.attemptedToolNamesTruncated === "boolean"
        ? telemetry.attemptedToolNamesTruncated
        : null,
    execCallCount,
    finalText,
    isError: execResult.isError === true,
    sessionId: entry.sessionId,
    value: details.value,
  };
}

function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function evaluateConversationProofCell(params: {
  ambiguous: boolean;
  assistantTurns: number;
  authoredMethods: string[];
  callCount: number | null;
  completedExecResultCount: number;
  elapsedMs: number;
  attemptedToolNames: string[];
  attemptedToolNamesTruncated: boolean | null;
  execCallCount: number;
  finalText: string;
  firstIdentity: ConversationProofIdentity;
  gatewayPidSha256: string;
  isError: boolean;
  newOutboundMessages: ConversationProofMessage[];
  ordinal: number;
  secondIdentity: ConversationProofIdentity;
  sessionId: string;
  terminalErrorPresent: boolean;
  terminalStatus: unknown;
  value: unknown;
}): ConversationProofCell {
  const id = params.ambiguous ? "Code-ambiguous" : "Code-exact";
  const value = isRecord(params.value) ? params.value : {};
  const candidates = Array.isArray(value.candidates) ? value.candidates.filter(isRecord) : [];
  const authoredMethods = params.authoredMethods;
  const expectedAuthoredMethods = ["conversations_list", "conversations_send"];
  const expectedAttemptedToolNames = params.ambiguous
    ? ["conversations_list"]
    : ["conversations_list", "conversations_send"];
  const executionBound =
    sameSequence(authoredMethods, expectedAuthoredMethods) &&
    params.attemptedToolNamesTruncated === false &&
    sameSequence(params.attemptedToolNames, expectedAttemptedToolNames) &&
    params.callCount === expectedAttemptedToolNames.length &&
    params.execCallCount === 1 &&
    params.completedExecResultCount === 1;
  const exactSent =
    !params.ambiguous &&
    value.status === "sent" &&
    value.conversationRef === params.firstIdentity.conversationRef;
  const candidateKeys = candidates
    .map((candidate) => {
      const conversationRef = candidate.conversationRef;
      const label = candidate.label;
      const target = candidate.target;
      return typeof conversationRef === "string" &&
        typeof label === "string" &&
        typeof target === "string"
        ? JSON.stringify([conversationRef, label, target])
        : null;
    })
    .filter((candidate): candidate is string => candidate !== null)
    .toSorted();
  const expectedCandidateKeys = [params.firstIdentity, params.secondIdentity]
    .map((identity) =>
      JSON.stringify([identity.conversationRef, identity.label, identity.deliveryTarget]),
    )
    .toSorted();
  const finalLines = params.finalText.trim().split(/\r?\n/u);
  const finalCandidateLines = finalLines.slice(1).toSorted();
  const expectedFinalCandidateLines = [params.firstIdentity, params.secondIdentity]
    .map(
      (identity) =>
        `${identity.conversationRef}\t${identity.label ?? ""}\t${identity.deliveryTarget}`,
    )
    .toSorted();
  const finalReportsExpectedRefs =
    params.ambiguous &&
    finalLines[0] === "AMBIGUOUS_NO_SEND" &&
    sameSequence(finalCandidateLines, expectedFinalCandidateLines);
  const ambiguityValid =
    params.ambiguous &&
    sameSequence(candidateKeys, expectedCandidateKeys) &&
    finalReportsExpectedRefs;
  const outboundValid = params.ambiguous
    ? params.newOutboundMessages.length === 0
    : params.newOutboundMessages.length === 1 &&
      isExpectedExactOutbound(params.newOutboundMessages[0], params.firstIdentity);
  const terminalState = normalizeTerminalStatus(params.terminalStatus);
  const passed =
    terminalState === "completed" &&
    !params.terminalErrorPresent &&
    !params.isError &&
    executionBound &&
    outboundValid &&
    (params.ambiguous ? ambiguityValid : exactSent);
  return {
    id,
    mode: "code",
    promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
    expectedAuthoredMethods,
    authoredMethods,
    expectedAttemptedToolNames,
    attemptedToolNames: params.attemptedToolNames,
    attemptedToolNamesTruncated: params.attemptedToolNamesTruncated,
    outerExecCalls: params.execCallCount,
    completedOuterExecResults: params.completedExecResultCount,
    executedNestedToolCalls: params.callCount,
    outboundMessageDelta: params.newOutboundMessages.length,
    gatewayPidSha256: params.gatewayPidSha256,
    sessionIdSha256: sha256(params.sessionId),
    execObserved: params.execCallCount > 0,
    finalSha256: sha256(params.finalText),
    finalReportsExpectedRefs,
    assistantTurns: params.assistantTurns,
    elapsedMs: params.elapsedMs,
    terminalStatus: terminalState,
    terminalErrorPresent: params.terminalErrorPresent,
    candidateRefSha256: [params.firstIdentity, params.secondIdentity]
      .map((identity) => sha256(identity.conversationRef))
      .toSorted(),
    passed,
    ...(passed ? {} : { failureCode: "cell_contract_mismatch" }),
    ordinal: params.ordinal,
  };
}

async function runConversationProofCells(params: {
  callGateway: (
    method: string,
    request: Record<string, unknown>,
    options: { timeoutMs: number },
  ) => Promise<unknown>;
  firstIdentity: ConversationProofIdentity;
  gatewayPidSha256: string;
  getSnapshot: () => ConversationProofSnapshot;
  now?: () => number;
  readTranscript: (sessionKey: string) => Promise<ConversationProofTranscript>;
  registerAmbiguousIdentity: () => void;
  secondIdentity: ConversationProofIdentity;
  thinking: "high";
  uuid?: () => string;
}): Promise<ConversationProofCell[]> {
  const definitions = [
    { id: "Code-exact", ambiguous: false },
    { id: "Code-ambiguous", ambiguous: true },
  ] as const;
  const cells: ConversationProofCell[] = [];
  const now = params.now ?? Date.now;
  const uuid = params.uuid ?? randomUUID;
  const proofStartSnapshot = params.getSnapshot();
  let previousSnapshot = proofStartSnapshot;
  for (const [index, definition] of definitions.entries()) {
    if (definition.ambiguous) {
      params.registerAmbiguousIdentity();
    }
    const beforeBus = previousSnapshot;
    const sessionKey = `agent:qa:code-mode-conversation-${definition.id.toLowerCase()}`;
    const startedAt = now();
    try {
      const started = (await params.callGateway(
        "agent",
        {
          idempotencyKey: uuid(),
          agentId: "qa",
          sessionKey,
          message: CODE_MODE_CONVERSATION_PROOF_PROMPT,
          deliver: false,
          thinking: params.thinking,
        },
        { timeoutMs: 30_000 },
      )) as { runId?: string };
      if (!started.runId) {
        throw new Error("conversation_proof_run_id_missing");
      }
      const terminal = (await params.callGateway(
        "agent.wait",
        { runId: started.runId, timeoutMs: 360_000 },
        { timeoutMs: 365_000 },
      )) as { error?: unknown; status?: unknown };
      const transcript = await params.readTranscript(sessionKey);
      const afterBus = params.getSnapshot();
      previousSnapshot = afterBus;
      const newOutboundMessages = readNewOutboundMessages(beforeBus, afterBus);
      const cell = evaluateConversationProofCell({
        ambiguous: definition.ambiguous,
        assistantTurns: transcript.assistantTurns,
        authoredMethods: transcript.authoredMethods,
        callCount: transcript.callCount,
        completedExecResultCount: transcript.completedExecResultCount,
        elapsedMs: now() - startedAt,
        attemptedToolNames: transcript.attemptedToolNames,
        attemptedToolNamesTruncated: transcript.attemptedToolNamesTruncated,
        execCallCount: transcript.execCallCount,
        finalText: transcript.finalText,
        firstIdentity: params.firstIdentity,
        gatewayPidSha256: params.gatewayPidSha256,
        isError: transcript.isError,
        newOutboundMessages,
        ordinal: index + 1,
        secondIdentity: params.secondIdentity,
        sessionId: transcript.sessionId,
        terminalErrorPresent: terminal.error !== undefined,
        terminalStatus: terminal.status,
        value: transcript.value,
      });
      cells.push({
        ...cell,
        sessionKeySha256: sha256(sessionKey),
      });
      if (!cell.passed) {
        break;
      }
    } catch (error) {
      cells.push({
        id: definition.id,
        mode: "code",
        promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
        gatewayPidSha256: params.gatewayPidSha256,
        execObserved: false,
        elapsedMs: now() - startedAt,
        sessionKeySha256: sha256(sessionKey),
        failureCode: stableFailureCode(error),
        passed: false,
        ordinal: index + 1,
      });
      break;
    }
  }
  if (cells.length === 2) {
    const globalOutboundMessages = readNewOutboundMessages(proofStartSnapshot, previousSnapshot);
    const globalOutboundValid =
      globalOutboundMessages.length === 1 &&
      isExpectedExactOutbound(globalOutboundMessages[0], params.firstIdentity);
    const lastCell = cells.at(-1)!;
    cells[cells.length - 1] = {
      ...lastCell,
      globalOutboundMessageDelta: globalOutboundMessages.length,
      globalOutboundValid,
      passed: lastCell.passed && globalOutboundValid,
      ...(globalOutboundValid ? {} : { failureCode: "proof_global_outbound_mismatch" }),
    };
  }
  return cells;
}

function evaluateGatewayBindings(params: {
  authProfileId: string;
  configuredPrimary: string;
  endpoint: string;
  expectedApi: string;
  frozenEnv: NodeJS.ProcessEnv;
  gatewayConfig: OpenClawConfig;
  runtimeEnv: NodeJS.ProcessEnv;
}) {
  const providerKeys = Object.keys(params.gatewayConfig.models?.providers ?? {}).toSorted();
  return {
    routeMatch:
      params.gatewayConfig.models?.mode === "replace" &&
      providerKeys.length === 1 &&
      providerKeys[0] === "openai" &&
      params.gatewayConfig.models?.providers?.openai?.baseUrl === params.endpoint &&
      params.gatewayConfig.models?.providers?.openai?.api === params.expectedApi &&
      resolveAgentEffectiveModelPrimary(params.gatewayConfig, "qa") === params.configuredPrimary &&
      (params.gatewayConfig.agents?.defaults?.model?.fallbacks?.length ?? 0) === 0,
    profileMatch:
      params.gatewayConfig.auth?.profiles?.[params.authProfileId]?.provider === "openai" &&
      params.gatewayConfig.auth.profiles[params.authProfileId]?.mode === "api_key",
    credentialBindingMatch:
      typeof params.frozenEnv.OPENAI_API_KEY === "string" &&
      params.frozenEnv.OPENAI_API_KEY.length > 0 &&
      params.runtimeEnv.OPENAI_API_KEY === params.frozenEnv.OPENAI_API_KEY,
  };
}

function canonicalOpenAiProvider(params: CodeModeConversationProofParams) {
  const configured = params.config.models?.providers?.openai;
  return {
    ...configured,
    api: configured?.api ?? params.executionPolicy.api,
    auth: configured?.auth ?? ("api-key" as const),
    baseUrl: configured?.baseUrl ?? params.executionPolicy.endpoint,
  };
}

async function writeConversationProofSummary(outputDir: string, summary: unknown): Promise<void> {
  await fs.writeFile(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

function applyConversationProofCleanupOutcome(
  summary: ConversationProofSummary,
  cleanupFailed: boolean,
): ConversationProofSummary {
  if (!cleanupFailed) {
    return { ...summary, cleanup: { status: "completed" } };
  }
  return {
    ...summary,
    status: summary.status === "blocked" ? "blocked" : "fail",
    ...(summary.failureCode ? { priorFailureCode: summary.failureCode } : {}),
    failureCode: "conversation_proof_cleanup_failed",
    cleanup: {
      status: "failed",
      failureCode: "conversation_proof_cleanup_failed",
    },
  };
}

export async function runCodeModeMatrixConversationProof(params: CodeModeConversationProofParams) {
  const outputDir = path.join(params.outputDir, "conversation-proof");
  await fs.mkdir(outputDir, { recursive: true });
  const baseSummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: params.model,
    provider: "openai" as const,
    runtime: "openclaw" as const,
    gitSha: params.gitSha,
    buildSha256: params.buildSha256,
    configSha256: params.configSha256,
    promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
    evidenceClass: "behavior_only_real_model_gateway_channel" as const,
    requestAudit: "not_attested" as const,
    betaGateRole: "required_behavior_gate_excluded_from_matched_beta_bars" as const,
  };
  let phase: "startup" | "cells" = "startup";
  let cells: ConversationProofCell[] = [];
  let gatewayConfigSha256: string | undefined;
  let routeMatch: boolean | undefined;
  let profileMatch: boolean | undefined;
  let credentialBindingMatch: boolean | undefined;
  let lab: Awaited<ReturnType<typeof startQaLabServer>> | undefined;
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let summary: ConversationProofSummary;
  try {
    const configuredPrimary = resolveAgentEffectiveModelPrimary(
      params.config,
      params.executionPolicy.defaultAgentId,
    );
    const qualifiedPrimary = splitTrailingAuthProfile(configuredPrimary);
    const authProfileId = qualifiedPrimary.profile;
    const pinnedModelEntry = params.config.agents?.defaults?.models?.[params.model];
    const pinnedAuthProfile = authProfileId
      ? params.config.auth?.profiles?.[authProfileId]
      : undefined;
    if (qualifiedPrimary.model !== params.model || !authProfileId || !pinnedAuthProfile) {
      throw new Error("conversation_proof_frozen_route_missing");
    }
    const provider = canonicalOpenAiProvider(params);
    lab = await startQaLabServer({
      repoRoot: params.repoRoot,
      embeddedGateway: "disabled",
    });
    const transport = createQaChannelTransport(lab.state);
    gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      transport,
      transportBaseUrl: lab.listenUrl,
      providerMode: "live-frontier",
      primaryModel: params.model,
      alternateModel: params.model,
      thinkingDefault: params.executionPolicy.thinking,
      forcedRuntime: "openclaw",
      controlUiEnabled: false,
      keepTemp: false,
      runtimeBaseEnv: params.frozenEnv,
      mutateConfig: (config) => ({
        ...config,
        models: {
          mode: "replace",
          providers: { openai: provider },
        },
        auth: {
          ...config.auth,
          profiles: { [authProfileId]: pinnedAuthProfile },
        },
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: { primary: configuredPrimary, fallbacks: [] },
            models: { [params.model]: pinnedModelEntry ?? { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            ...config.agents?.entries,
            qa: {
              ...config.agents?.entries?.qa,
              model: configuredPrimary,
              tools: {
                ...config.agents?.entries?.qa?.tools,
                codeMode: { enabled: true },
              },
            },
          },
        },
        tools: {
          profile: "coding",
          alsoAllow: ["conversations_list", "conversations_send"],
          codeMode: { enabled: true },
        },
      }),
    });
    const agentDir = path.join(gateway.tempRoot, "state", "agents", "qa", "agent");
    const authStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
      syncExternalCli: false,
    });
    authStore.profiles[authProfileId] = {
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      displayName: "Frozen Code Mode proof credential",
    };
    saveAuthProfileStore(authStore, agentDir);
    const gatewayConfigRaw = await fs.readFile(gateway.configPath, "utf8");
    const gatewayConfig = JSON.parse(gatewayConfigRaw) as OpenClawConfig;
    gatewayConfigSha256 = sha256(gatewayConfigRaw);
    const bindings = evaluateGatewayBindings({
      authProfileId,
      configuredPrimary,
      endpoint: params.executionPolicy.endpoint,
      expectedApi: params.executionPolicy.api,
      frozenEnv: params.frozenEnv,
      gatewayConfig,
      runtimeEnv: gateway.runtimeEnv,
    });
    ({ routeMatch, profileMatch, credentialBindingMatch } = bindings);
    if (!routeMatch || !profileMatch || !credentialBindingMatch) {
      throw new Error("conversation_proof_gateway_route_mismatch");
    }
    if (!gateway.pid) {
      throw new Error("conversation_proof_gateway_pid_missing");
    }
    const gatewayPidSha256 = sha256(String(gateway.pid));
    const firstIdentity = buildConversationIdentity({
      channel: "qa-channel",
      accountId: "default",
      kind: "direct",
      peerId: "build-bot",
      deliveryTarget: "dm:build-bot",
      label: "Build bot",
    });
    const secondIdentity = buildConversationIdentity({
      channel: "qa-channel",
      accountId: "default",
      kind: "direct",
      peerId: "build-bot-staging",
      deliveryTarget: "dm:build-bot-staging",
      label: "Build bot",
    });
    if (!firstIdentity || !secondIdentity) {
      throw new Error("conversation_proof_identity_invalid");
    }
    const registryScope = {
      agentId: "qa",
      env: {
        OPENCLAW_STATE_DIR: path.join(gateway.tempRoot, "state"),
      },
    };
    registerConversationAddresses(registryScope, [firstIdentity], 100);
    phase = "cells";
    cells = await runConversationProofCells({
      callGateway: async (method, request, options) =>
        await gateway!.call(method, request, options),
      firstIdentity,
      gatewayPidSha256,
      getSnapshot: () => lab!.state.getSnapshot(),
      readTranscript: async (sessionKey) =>
        await readConversationProofTranscript({
          agentId: "qa",
          gatewayTempRoot: gateway!.tempRoot,
          sessionKey,
        }),
      registerAmbiguousIdentity: () => {
        registerConversationAddresses(registryScope, [secondIdentity], 200);
      },
      secondIdentity,
      thinking: params.executionPolicy.thinking,
    });
    const failed = cells.filter((cell) => !cell.passed).length;
    const sessionIdHashes = cells
      .flatMap((cell) => (typeof cell.sessionIdSha256 === "string" ? [cell.sessionIdSha256] : []))
      .toSorted();
    const distinctSessionIds =
      sessionIdHashes.length === 2 && new Set(sessionIdHashes).size === sessionIdHashes.length;
    summary = {
      ...baseSummary,
      status:
        cells.length === 2 && failed === 0 && distinctSessionIds
          ? ("pass" as const)
          : ("fail" as const),
      gatewayConfigSha256,
      gatewayPidSha256,
      routeMatch,
      profileMatch,
      credentialBindingMatch,
      sessionIdHashes,
      distinctSessionIds,
      cells,
      counts: { total: cells.length, passed: cells.length - failed, failed },
    };
  } catch (error) {
    const failed = cells.filter((cell) => !cell.passed).length;
    summary = {
      ...baseSummary,
      status: phase === "startup" ? ("blocked" as const) : ("fail" as const),
      failureCode: stableFailureCode(error),
      ...(gatewayConfigSha256 ? { gatewayConfigSha256 } : {}),
      ...(routeMatch !== undefined ? { routeMatch } : {}),
      ...(profileMatch !== undefined ? { profileMatch } : {}),
      ...(credentialBindingMatch !== undefined ? { credentialBindingMatch } : {}),
      cells,
      counts: { total: cells.length, passed: cells.length - failed, failed },
    };
  }
  let cleanupFailed = false;
  try {
    await gateway?.stop({ keepTemp: false });
  } catch {
    cleanupFailed = true;
  }
  try {
    await lab?.stop();
  } catch {
    cleanupFailed = true;
  }
  summary = applyConversationProofCleanupOutcome(summary, cleanupFailed);
  await writeConversationProofSummary(outputDir, summary);
  return summary;
}

export const codeModeConversationProofTesting = {
  applyConversationProofCleanupOutcome,
  canonicalOpenAiProvider,
  evaluateConversationProofCell,
  evaluateGatewayBindings,
  readAuthoredMethods,
  readToolCallInput,
  runConversationProofCells,
  stableFailureCode,
};
