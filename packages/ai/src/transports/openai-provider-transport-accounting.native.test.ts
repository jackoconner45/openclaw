import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiModelTransportEvent } from "../host.js";
import {
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import {
  attemptEvents,
  chatGptModel,
  completedSseEvent,
  completedSseResponse,
  configureTransportObserver,
  connectionEvents,
  context,
  createJwt,
  fallbackEvents,
  resetOpenAITransportAccountingTestState,
  stalledSseResponse,
  submissionEvents,
  truncatedSseResponse,
} from "./openai-provider-transport-accounting.test-support.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI native transport accounting", () => {
  it("records each native SSE retry and completes only after stream termination", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("overloaded", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          }),
        )
        .mockResolvedValueOnce(completedSseResponse()),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      requestId: "call-native-sse-retry",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      },
      {
        transport: "native-codex-sse",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      },
    ]);
  });

  it("settles native SSE truncation, caller abort, and watchdog timeout correctly", async () => {
    const truncatedEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(truncatedEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => truncatedSseResponse()),
    );
    const truncated = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-truncated",
    }).result();
    expect(truncated.stopReason).toBe("error");
    expect(attemptEvents(truncatedEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const aborted = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-abort",
      signal: controller.signal,
      onResponse: () => controller.abort(),
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stalledSseResponse()),
    );
    const timedOut = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-first-event-timeout",
      firstEventTimeoutMs: 1,
    } as Parameters<typeof streamSimpleOpenAICodexResponses>[2] & {
      firstEventTimeoutMs: number;
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("records explicit WebSocket handshake failure as connection plus zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("private websocket connect failure");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(connectionEvents(events)).toMatchObject([{ reason: "initial", outcome: "failed" }]);
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", total: 0, outcome: "failed" },
    ]);
  });

  it("distinguishes WebSocket handshake timeout from caller abort", async () => {
    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents);
    class HangingWebSocket extends EventTarget {
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", HangingWebSocket);
    const timedOut = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-timeout",
      timeoutMs: 1,
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(connectionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
    expect(submissionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents);
    class AbortedHandshakeWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => controller.abort());
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedHandshakeWebSocket);
    const aborted = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-abort",
      signal: controller.signal,
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(connectionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
    expect(submissionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
  });

  it("records a fresh WebSocket success as one connection and one attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SuccessfulWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_ws_success")),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SuccessfulWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-success",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(attemptEvents(events)).toMatchObject([{ outcome: "completed", reason: "initial" }]);
  });

  it("records WebSocket serialization failure as zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    let sends = 0;
    class UnusedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        sends += 1;
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", UnusedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-serialization-failure",
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        unsupported: 1n,
      }),
    }).result();

    expect(result.stopReason).toBe("error");
    expect(sends).toBe(0);
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("classifies synchronous WebSocket send rejection as submission failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SendRejectingWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        throw new Error("private synchronous send failure");
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendRejectingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-sync-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "submission_failure" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
  });

  it("records post-send fallback as failed WS plus transport-fallback SSE", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("error"), { message: "private post-send failure" }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-post-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        reason: "initial",
        outcome: "failed",
      },
      {
        transport: "native-codex-sse",
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "stream_failure" }]);
  });

  it("records submitted WebSocket caller abort as an aborted attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(events);
    class AbortedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => controller.abort());
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-submitted-abort",
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "aborted", reason: "initial" }]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts cached WebSocket reuse as a new attempt without a new connection", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    let connections = 0;
    let submissions = 0;
    class CachedWebSocket extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        submissions += 1;
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent(`resp_cached_${submissions}`)),
            }),
          );
        });
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", CachedWebSocket);
    const baseOptions = {
      apiKey: createJwt(),
      sessionId: "cached-transport-accounting",
      transport: "websocket-cached" as const,
    };

    await streamOpenAICodexResponses(chatGptModel, context, {
      ...baseOptions,
      requestId: "call-cached-one",
    }).result();
    await streamOpenAICodexResponses(
      chatGptModel,
      {
        ...context,
        messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
      },
      { ...baseOptions, requestId: "call-cached-two" },
    ).result();

    expect(connections).toBe(1);
    expect(submissions).toBe(2);
    expect(connectionEvents(events)).toHaveLength(1);
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-cached-one", outcome: "completed" },
      { callId: "call-cached-two", outcome: "completed" },
    ]);
  });

  it("records connection-limit recovery as retry plus reconnect, not fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class ConnectionLimitWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ConnectionLimitWebSocket.connectionCount;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        const event =
          this.connection === 1
            ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
            : completedSseEvent("resp_connection_retry");
        queueMicrotask(() =>
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) })),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-connection-limit",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
      { ordinal: 2, reason: "retry", outcome: "completed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("records sticky-session policy fallback before the target SSE attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const sessionId = "sticky-policy-accounting";

    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-prime",
    }).result();
    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-sticky",
    }).result();

    expect(
      fallbackEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "policy" }]);
    expect(
      attemptEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "transport_fallback", outcome: "completed" }]);
  });
});
