import { describe, expect, it } from "vitest";
import {
  CODE_MODE_CONVERSATION_PROOF_PROMPT,
  codeModeConversationProofTesting,
} from "../../scripts/lib/code-mode-model-matrix-conversation-proof.js";
import { buildConversationIdentity } from "../../src/config/sessions/conversation-identity.js";

function identities() {
  const first = buildConversationIdentity({
    channel: "qa-channel",
    accountId: "default",
    kind: "direct",
    peerId: "build-bot",
    deliveryTarget: "dm:build-bot",
    label: "Build bot",
  });
  const second = buildConversationIdentity({
    channel: "qa-channel",
    accountId: "default",
    kind: "direct",
    peerId: "build-bot-staging",
    deliveryTarget: "dm:build-bot-staging",
    label: "Build bot",
  });
  if (!first || !second) {
    throw new Error("test conversation identity was invalid");
  }
  return { first, second };
}

function snapshot(outboundIds: string[] = []) {
  return {
    messages: outboundIds.map((conversationId, index) => ({
      accountId: "default",
      id: `message-${index}-${conversationId}`,
      conversation: { id: conversationId, kind: "direct" },
      direction: "outbound",
      text: "Build finished.",
    })),
  };
}

function ambiguousFinal(
  first: ReturnType<typeof identities>["first"],
  second: ReturnType<typeof identities>["second"],
) {
  return [
    "AMBIGUOUS_NO_SEND",
    `${first.conversationRef}\t${first.label}\t${first.deliveryTarget}`,
    `${second.conversationRef}\t${second.label}\t${second.deliveryTarget}`,
  ].join("\n");
}

describe("Code Mode matrix conversation proof", () => {
  it("keeps explicit OpenClaw framing and positive one-cell JS/TS guidance", () => {
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("OpenClaw Code Mode");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("JavaScript or TypeScript");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("single deterministic cell");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("more than one candidate");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain(
      'return { status: "sent", conversationRef }',
    );
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("return { candidates }");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("AMBIGUOUS_NO_SEND");
  });

  it("counts only authored tools calls from parsed JS/TS", async () => {
    await expect(
      codeModeConversationProofTesting.readAuthoredMethods(`
        const label = "tools.conversations_send()";
        const listed = await tools.conversations_list({ query: "Build bot" });
        if (listed.conversations.length === 1) {
          await tools.conversations_send({
            conversationRef: listed.conversations[0].conversationRef,
            message: "Build finished.",
          });
        }
      `),
    ).resolves.toEqual(["conversations_list", "conversations_send"]);
  });

  it("accepts structured and serialized exec inputs", () => {
    expect(
      codeModeConversationProofTesting.readToolCallInput({
        arguments: { language: "typescript", code: "return 1" },
      }),
    ).toEqual({ language: "typescript", code: "return 1" });
    expect(
      codeModeConversationProofTesting.readToolCallInput({
        arguments: '{"language":"javascript","code":"return 2"}',
      }),
    ).toEqual({ language: "javascript", code: "return 2" });
  });

  it("binds the exact cell to one list, one send, and one bus delivery", () => {
    const { first, second } = identities();
    const cell = codeModeConversationProofTesting.evaluateConversationProofCell({
      ambiguous: false,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 2,
      completedExecResultCount: 1,
      elapsedMs: 12,
      attemptedToolNames: ["conversations_list", "conversations_send"],
      attemptedToolNamesTruncated: false,
      execCallCount: 1,
      finalText: "done",
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: snapshot(["build-bot"]).messages,
      ordinal: 1,
      secondIdentity: second,
      sessionId: "session-exact",
      terminalErrorPresent: false,
      terminalStatus: "completed",
      value: { status: "sent", conversationRef: first.conversationRef },
    });

    expect(cell).toMatchObject({
      passed: true,
      execObserved: true,
      authoredMethods: ["conversations_list", "conversations_send"],
      outerExecCalls: 1,
      completedOuterExecResults: 1,
      executedNestedToolCalls: 2,
      attemptedToolNames: ["conversations_list", "conversations_send"],
      outboundMessageDelta: 1,
      gatewayPidSha256: "gateway-hash",
    });
    expect(cell).not.toHaveProperty("final");
    expect(cell).not.toHaveProperty("terminalError");
  });

  it("binds genuine ambiguity to one executed nested call and no delivery", () => {
    const { first, second } = identities();
    const cell = codeModeConversationProofTesting.evaluateConversationProofCell({
      ambiguous: true,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 1,
      completedExecResultCount: 1,
      elapsedMs: 9,
      attemptedToolNames: ["conversations_list"],
      attemptedToolNamesTruncated: false,
      execCallCount: 1,
      finalText: ambiguousFinal(first, second),
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: [],
      ordinal: 2,
      secondIdentity: second,
      sessionId: "session-ambiguous",
      terminalErrorPresent: false,
      terminalStatus: "ok",
      value: {
        candidates: [
          {
            conversationRef: first.conversationRef,
            label: first.label,
            target: first.deliveryTarget,
          },
          {
            conversationRef: second.conversationRef,
            label: second.label,
            target: second.deliveryTarget,
          },
        ],
      },
    });

    expect(cell).toMatchObject({
      passed: true,
      authoredMethods: ["conversations_list", "conversations_send"],
      outerExecCalls: 1,
      completedOuterExecResults: 1,
      executedNestedToolCalls: 1,
      attemptedToolNames: ["conversations_list"],
      outboundMessageDelta: 0,
      finalReportsExpectedRefs: true,
    });
  });

  it("rejects truncated, reordered, or destination-incomplete execution proof", () => {
    const { first, second } = identities();
    const params = {
      ambiguous: false,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 2,
      completedExecResultCount: 1,
      elapsedMs: 12,
      attemptedToolNames: ["conversations_list", "conversations_send"],
      attemptedToolNamesTruncated: false,
      execCallCount: 1,
      finalText: "done",
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: snapshot(["build-bot"]).messages,
      ordinal: 1,
      secondIdentity: second,
      sessionId: "session-exact",
      terminalErrorPresent: false,
      terminalStatus: "completed",
      value: { status: "sent", conversationRef: first.conversationRef },
    };

    expect(
      codeModeConversationProofTesting.evaluateConversationProofCell({
        ...params,
        attemptedToolNames: ["conversations_send", "conversations_list"],
      }),
    ).toMatchObject({ passed: false });
    expect(
      codeModeConversationProofTesting.evaluateConversationProofCell({
        ...params,
        attemptedToolNamesTruncated: true,
      }),
    ).toMatchObject({ passed: false });
    expect(
      codeModeConversationProofTesting.evaluateConversationProofCell({
        ...params,
        authoredMethods: ["conversations_list", "files_read", "conversations_send"],
      }),
    ).toMatchObject({ passed: false });
    expect(
      codeModeConversationProofTesting.evaluateConversationProofCell({
        ...params,
        newOutboundMessages: [
          ...snapshot(["build-bot"]).messages,
          {
            accountId: "default",
            id: "message-extra",
            conversation: { id: "unrelated", kind: "direct" },
            direction: "outbound",
            text: "unrelated",
          },
        ],
      }),
    ).toMatchObject({ passed: false });
  });

  it("rejects ambiguity without exact ref, label, and target triples", () => {
    const { first, second } = identities();
    const cell = codeModeConversationProofTesting.evaluateConversationProofCell({
      ambiguous: true,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 1,
      completedExecResultCount: 1,
      elapsedMs: 9,
      attemptedToolNames: ["conversations_list"],
      attemptedToolNamesTruncated: false,
      execCallCount: 1,
      finalText: ambiguousFinal(first, second),
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: [],
      ordinal: 2,
      secondIdentity: second,
      sessionId: "session-ambiguous",
      terminalErrorPresent: false,
      terminalStatus: "ok",
      value: {
        candidates: [
          {
            conversationRef: first.conversationRef,
            label: first.label,
            target: first.deliveryTarget,
          },
          {
            conversationRef: second.conversationRef,
            label: second.label,
            target: "wrong-target",
          },
        ],
      },
    });

    expect(cell).toMatchObject({ passed: false, failureCode: "cell_contract_mismatch" });
  });

  it("rejects a contradictory sent final for an ambiguous no-send result", () => {
    const { first, second } = identities();
    const cell = codeModeConversationProofTesting.evaluateConversationProofCell({
      ambiguous: true,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 1,
      completedExecResultCount: 1,
      elapsedMs: 9,
      attemptedToolNames: ["conversations_list"],
      attemptedToolNamesTruncated: false,
      execCallCount: 1,
      finalText: `Sent successfully.\n${ambiguousFinal(first, second)}`,
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: [],
      ordinal: 2,
      secondIdentity: second,
      sessionId: "session-ambiguous",
      terminalErrorPresent: false,
      terminalStatus: "ok",
      value: {
        candidates: [
          {
            conversationRef: first.conversationRef,
            label: first.label,
            target: first.deliveryTarget,
          },
          {
            conversationRef: second.conversationRef,
            label: second.label,
            target: second.deliveryTarget,
          },
        ],
      },
    });

    expect(cell).toMatchObject({ passed: false, finalReportsExpectedRefs: false });
  });

  it("rejects an ambiguity trace that recovered through a second outer exec", () => {
    const { first, second } = identities();
    const cell = codeModeConversationProofTesting.evaluateConversationProofCell({
      ambiguous: true,
      assistantTurns: 1,
      authoredMethods: ["conversations_list", "conversations_send"],
      callCount: 1,
      completedExecResultCount: 2,
      elapsedMs: 9,
      attemptedToolNames: ["conversations_list"],
      attemptedToolNamesTruncated: false,
      execCallCount: 2,
      finalText: ambiguousFinal(first, second),
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      isError: false,
      newOutboundMessages: [],
      ordinal: 2,
      secondIdentity: second,
      sessionId: "session-ambiguous",
      terminalErrorPresent: false,
      terminalStatus: "ok",
      value: {
        candidates: [
          {
            conversationRef: first.conversationRef,
            label: first.label,
            target: first.deliveryTarget,
          },
          {
            conversationRef: second.conversationRef,
            label: second.label,
            target: second.deliveryTarget,
          },
        ],
      },
    });

    expect(cell).toMatchObject({ passed: false, failureCode: "cell_contract_mismatch" });
  });

  it("runs exact then ambiguous on one gateway with physical bus proof", async () => {
    const { first, second } = identities();
    const snapshots = [snapshot(), snapshot(["build-bot"]), snapshot(["build-bot"])];
    const gatewayCalls: string[] = [];
    const cells = await codeModeConversationProofTesting.runConversationProofCells({
      callGateway: async (method) => {
        gatewayCalls.push(method);
        return method === "agent" ? { runId: `run-${gatewayCalls.length}` } : { status: "ok" };
      },
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      getSnapshot: () => snapshots.shift() ?? snapshot(),
      now: (() => {
        let value = 0;
        return () => (value += 5);
      })(),
      readTranscript: async (sessionKey) =>
        sessionKey.endsWith("code-exact")
          ? {
              assistantTurns: 1,
              authoredMethods: ["conversations_list", "conversations_send"],
              callCount: 2,
              completedExecResultCount: 1,
              attemptedToolNames: ["conversations_list", "conversations_send"],
              attemptedToolNamesTruncated: false,
              execCallCount: 1,
              finalText: "sent",
              isError: false,
              sessionId: "session-exact",
              value: { status: "sent", conversationRef: first.conversationRef },
            }
          : {
              assistantTurns: 1,
              authoredMethods: ["conversations_list", "conversations_send"],
              callCount: 1,
              completedExecResultCount: 1,
              attemptedToolNames: ["conversations_list"],
              attemptedToolNamesTruncated: false,
              execCallCount: 1,
              finalText: ambiguousFinal(first, second),
              isError: false,
              sessionId: "session-ambiguous",
              value: {
                candidates: [
                  {
                    conversationRef: first.conversationRef,
                    label: first.label,
                    target: first.deliveryTarget,
                  },
                  {
                    conversationRef: second.conversationRef,
                    label: second.label,
                    target: second.deliveryTarget,
                  },
                ],
              },
            },
      registerAmbiguousIdentity: () => {},
      secondIdentity: second,
      thinking: "high",
      uuid: () => "fixed-id",
    });

    expect(gatewayCalls).toEqual(["agent", "agent.wait", "agent", "agent.wait"]);
    expect(cells.map((cell) => cell.passed)).toEqual([true, true]);
    expect(cells.map((cell) => cell.outboundMessageDelta)).toEqual([1, 0]);
    expect(cells.map((cell) => cell.outerExecCalls)).toEqual([1, 1]);
    expect(new Set(cells.map((cell) => cell.sessionIdSha256)).size).toBe(2);
    expect(cells[1]).toMatchObject({
      globalOutboundMessageDelta: 1,
      globalOutboundValid: true,
    });
  });

  it("rejects an outbound inserted between the exact and ambiguous cells", async () => {
    const { first, second } = identities();
    const snapshots = [snapshot(), snapshot(["build-bot"]), snapshot(["build-bot", "unrelated"])];
    const cells = await codeModeConversationProofTesting.runConversationProofCells({
      callGateway: async (method) =>
        method === "agent" ? { runId: "run" } : { status: "completed" },
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      getSnapshot: () => snapshots.shift() ?? snapshot(["build-bot", "unrelated"]),
      readTranscript: async (sessionKey) =>
        sessionKey.endsWith("code-exact")
          ? {
              assistantTurns: 1,
              authoredMethods: ["conversations_list", "conversations_send"],
              callCount: 2,
              completedExecResultCount: 1,
              attemptedToolNames: ["conversations_list", "conversations_send"],
              attemptedToolNamesTruncated: false,
              execCallCount: 1,
              finalText: "sent",
              isError: false,
              sessionId: "session-exact",
              value: { status: "sent", conversationRef: first.conversationRef },
            }
          : {
              assistantTurns: 1,
              authoredMethods: ["conversations_list", "conversations_send"],
              callCount: 1,
              completedExecResultCount: 1,
              attemptedToolNames: ["conversations_list"],
              attemptedToolNamesTruncated: false,
              execCallCount: 1,
              finalText: ambiguousFinal(first, second),
              isError: false,
              sessionId: "session-ambiguous",
              value: {
                candidates: [
                  {
                    conversationRef: first.conversationRef,
                    label: first.label,
                    target: first.deliveryTarget,
                  },
                  {
                    conversationRef: second.conversationRef,
                    label: second.label,
                    target: second.deliveryTarget,
                  },
                ],
              },
            },
      registerAmbiguousIdentity: () => {},
      secondIdentity: second,
      thinking: "high",
    });

    expect(cells).toHaveLength(2);
    expect(cells[1]).toMatchObject({
      passed: false,
      globalOutboundMessageDelta: 2,
      globalOutboundValid: false,
      failureCode: "proof_global_outbound_mismatch",
    });
  });

  it("does not start the ambiguous cell after the exact cell is non-comparable", async () => {
    const { first, second } = identities();
    const gatewayCalls: string[] = [];
    let ambiguousRegistered = false;
    const cells = await codeModeConversationProofTesting.runConversationProofCells({
      callGateway: async (method) => {
        gatewayCalls.push(method);
        return method === "agent" ? { runId: "run-1" } : { status: "ok" };
      },
      firstIdentity: first,
      gatewayPidSha256: "gateway-hash",
      getSnapshot: () => snapshot(),
      readTranscript: async () => ({
        assistantTurns: 1,
        authoredMethods: ["conversations_list", "conversations_send"],
        callCount: 2,
        completedExecResultCount: 1,
        attemptedToolNames: ["conversations_list", "conversations_send"],
        attemptedToolNamesTruncated: false,
        execCallCount: 1,
        finalText: "sent",
        isError: false,
        sessionId: "session-exact",
        value: { status: "sent", conversationRef: first.conversationRef },
      }),
      registerAmbiguousIdentity: () => {
        ambiguousRegistered = true;
      },
      secondIdentity: second,
      thinking: "high",
      uuid: () => "fixed-id",
    });

    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ id: "Code-exact", passed: false });
    expect(gatewayCalls).toEqual(["agent", "agent.wait"]);
    expect(ambiguousRegistered).toBe(false);
  });

  it("checks isolated route, profile, and credential bindings", () => {
    const config = {
      models: {
        mode: "replace",
        providers: {
          openai: {
            api: "openai-responses",
            auth: "api-key",
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      auth: {
        profiles: {
          "openai:matrix": { provider: "openai", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4@openai:matrix",
            fallbacks: [],
          },
        },
        entries: {
          qa: { model: "openai/gpt-5.4@openai:matrix" },
        },
      },
    } as const;

    expect(
      codeModeConversationProofTesting.evaluateGatewayBindings({
        authProfileId: "openai:matrix",
        configuredPrimary: "openai/gpt-5.4@openai:matrix",
        endpoint: "https://api.openai.com/v1",
        expectedApi: "openai-responses",
        frozenEnv: { OPENAI_API_KEY: "frozen" },
        gatewayConfig: config,
        runtimeEnv: { OPENAI_API_KEY: "frozen" },
      }),
    ).toEqual({
      routeMatch: true,
      profileMatch: true,
      credentialBindingMatch: true,
    });
    expect(
      codeModeConversationProofTesting.evaluateGatewayBindings({
        authProfileId: "openai:matrix",
        configuredPrimary: "openai/gpt-5.4@openai:matrix",
        endpoint: "https://api.openai.com/v1",
        expectedApi: "openai-responses",
        frozenEnv: { OPENAI_API_KEY: "frozen" },
        gatewayConfig: config,
        runtimeEnv: { OPENAI_API_KEY: "ambient" },
      }).credentialBindingMatch,
    ).toBe(false);
  });

  it("fills canonical OpenAI defaults without discarding frozen provider fields", () => {
    const provider = codeModeConversationProofTesting.canonicalOpenAiProvider({
      buildSha256: "build",
      config: {
        models: {
          providers: {
            openai: {
              auth: "api-key",
              models: [{ id: "gpt-5.4", name: "Pinned frontier model" }],
            },
          },
        },
      },
      configSha256: "config",
      executionPolicy: {
        api: "openai-responses",
        credentialEnvName: "OPENAI_API_KEY",
        defaultAgentId: "main",
        endpoint: "https://api.openai.com/v1",
        model: "openai/gpt-5.4",
        provider: "openai",
        runtime: "openclaw",
        thinking: "high",
      },
      frozenEnv: {},
      gitSha: "git",
      model: "openai/gpt-5.4",
      outputDir: "output",
      repoRoot: "repo",
    });

    expect(provider).toEqual({
      api: "openai-responses",
      auth: "api-key",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-5.4", name: "Pinned frontier model" }],
    });
  });

  it("invalidates a passing proof when credential-bearing temp cleanup fails", () => {
    const summary = codeModeConversationProofTesting.applyConversationProofCleanupOutcome(
      {
        status: "pass",
        counts: { total: 2, passed: 2, failed: 0 },
      },
      true,
    );

    expect(summary).toMatchObject({
      status: "fail",
      failureCode: "conversation_proof_cleanup_failed",
      cleanup: {
        status: "failed",
        failureCode: "conversation_proof_cleanup_failed",
      },
    });
  });

  it("reduces unexpected failures to bounded stable codes", () => {
    expect(
      codeModeConversationProofTesting.stableFailureCode(
        new Error("Authorization: Bearer should-not-escape"),
      ),
    ).toBe("conversation_proof_internal_failure");
    expect(
      codeModeConversationProofTesting.stableFailureCode(
        new Error("conversation_proof_gateway_route_mismatch"),
      ),
    ).toBe("conversation_proof_gateway_route_mismatch");
  });
});
