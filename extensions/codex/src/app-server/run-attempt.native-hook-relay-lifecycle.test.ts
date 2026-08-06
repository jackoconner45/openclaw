// Codex tests cover native hook relay ownership across parent and child lifecycles.
import path from "node:path";
import {
  abortAgentHarnessRun,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  codexNativeHookRelayLeaseTesting,
  createCodexNativeHookRelay,
} from "./native-hook-relay.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

const flushRelayCleanup = () => nativeHookRelayUnregisterQueue.flush();

function createDirectRelay(ttlMs: number) {
  const params = createParams(
    path.join(tempDir, "direct-relay-session.jsonl"),
    path.join(tempDir, "direct-relay-workspace"),
  );
  const relay = createCodexNativeHookRelay({
    options: { enabled: true, ttlMs },
    events: ["pre_tool_use"],
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    config: params.config,
    runId: params.runId,
    attemptTimeoutMs: 5_000,
    startupTimeoutMs: 5_000,
    turnStartTimeoutMs: 5_000,
    loopDetectionPreToolUseRelay: true,
    signal: new AbortController().signal,
    onPreToolUseFailure: vi.fn(),
  });
  if (!relay) {
    throw new Error("Expected native hook relay");
  }
  return relay;
}

function childStarted(parentThreadId: string, childThreadId: string): CodexServerNotification {
  return {
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        parentThreadId,
        preview: "inspect the repo",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: childThreadId,
            },
          },
        },
      },
    },
  };
}

function childTurnStarted(childThreadId: string, turnId: string): CodexServerNotification {
  return {
    method: "turn/started",
    params: {
      threadId: childThreadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    },
  };
}

function childTurnCompleted(params: {
  childThreadId: string;
  turnId: string;
  status: "completed" | "interrupted";
}): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: params.childThreadId,
      turn: {
        id: params.turnId,
        status: params.status,
        items:
          params.status === "completed"
            ? [
                {
                  id: `${params.turnId}-final`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "child done",
                },
              ]
            : [],
        error: null,
      },
    },
  };
}

function invokeChildTool(params: {
  relayId: string;
  generation: string;
  toolCallId: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId: params.relayId,
    generation: params.generation,
    requireGeneration: true,
    event: "pre_tool_use",
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: params.toolName ?? "Bash",
      tool_use_id: params.toolCallId,
      tool_input: params.toolInput ?? { command: params.command ?? "pwd" },
    },
  });
}

function getRoute(harness: ReturnType<typeof createStartedThreadHarness>) {
  const request = harness.requests.find((entry) => entry.method === "thread/start");
  return {
    relayId: extractRelayIdFromThreadRequest(request?.params),
    generation: extractGenerationFromThreadRequest(request?.params),
  };
}

describe("Codex native hook relay lifecycle", () => {
  it("renews child ownership and cancels cleanup for a late child claim", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const relay = createDirectRelay(100);
    const releaseChild = relay.acquireChild("child-thread");
    relay.releaseParent({ delay: true });
    const firstExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (firstExpiry === undefined) {
      throw new Error("Expected relay registration");
    }
    await vi.advanceTimersByTimeAsync(51);
    const secondExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (secondExpiry === undefined) {
      throw new Error("Expected renewed relay registration");
    }
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    await vi.advanceTimersByTimeAsync(51);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)?.expiresAtMs,
    ).toBeGreaterThan(secondExpiry);
    releaseChild();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);

    const lateRelay = createDirectRelay(60_000);
    lateRelay.releaseParent({ delay: true });
    const releaseLateChild = lateRelay.acquireChild("late-child");
    flushRelayCleanup();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(lateRelay.relayId),
    ).toBeDefined();
    releaseLateChild();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("keeps policy enforcement alive after the parent completes", async () => {
    const beforeToolCall = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ block: true, blockReason: "blocked after parent completion" });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(
        path.join(tempDir, "parent-complete.jsonl"),
        path.join(tempDir, "parent-complete-workspace"),
      ),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"], ttlMs: 40_000 } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await harness.notify(childStarted("thread-1", "child-thread"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(
      invokeChildTool({
        ...route,
        toolCallId: "child-mcp-after-parent",
        toolName: "mcp__filesystem__read_text_file",
        toolInput: { path: "README.md" },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const denied = await invokeChildTool({
      ...route,
      toolCallId: "child-deny-after-parent",
      command: "git push",
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-thread",
        turnId: "child-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps child ownership after parent abort and releases on terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "abort.jsonl"), path.join(tempDir, "abort-workspace")),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(childStarted("thread-1", "child-after-abort"));
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    await expect(
      invokeChildTool({ ...route, toolCallId: "child-after-abort", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-after-abort",
        turnId: "child-after-abort-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("releases a shared route only after the last child terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "multi.jsonl"), path.join(tempDir, "multi-workspace")),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(childStarted("thread-1", "child-a"));
    await harness.notify(childStarted("thread-1", "child-b"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-a", turnId: "turn-a", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-b", turnId: "turn-b", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("retains an interrupted child route until resumed terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(
        path.join(tempDir, "interrupted.jsonl"),
        path.join(tempDir, "interrupted-workspace"),
      ),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(childStarted("thread-1", "resumable-child"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "interrupted-turn",
        status: "interrupted",
      }),
    );
    flushRelayCleanup();
    await expect(
      invokeChildTool({ ...route, toolCallId: "after-interrupt", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(childTurnStarted("resumable-child", "resumed-turn"));
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "resumed-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps child-held and replacement routes separate within one generation", async () => {
    const sessionFile = path.join(tempDir, "same-generation.jsonl");
    const workspaceDir = path.join(tempDir, "same-generation-workspace");
    const firstHarness = createStartedThreadHarness();
    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await firstHarness.waitForMethod("turn/start");
    const firstRoute = getRoute(firstHarness);
    await firstHarness.notify(childStarted("thread-1", "first-turn-child"));
    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await secondHarness.waitForMethod("turn/start");
    const request = secondHarness.requests.find((entry) => entry.method === "thread/resume");
    const secondRoute = {
      relayId: extractRelayIdFromThreadRequest(request?.params),
      generation: extractGenerationFromThreadRequest(request?.params),
    };
    expect(secondRoute.relayId).not.toBe(firstRoute.relayId);
    expect(secondRoute.generation).toBe(firstRoute.generation);
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId),
    ).toBeDefined();
    await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId),
    ).toBeDefined();
    await firstHarness.notify(
      childTurnCompleted({
        childThreadId: "first-turn-child",
        turnId: "first-turn-child-terminal",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId),
    ).toBeUndefined();
  });
});
