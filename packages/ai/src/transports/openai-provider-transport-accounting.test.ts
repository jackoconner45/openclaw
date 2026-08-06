import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import { responsesPromptObserver } from "../internal/openai.js";
import {
  abortErroredSseResponse,
  attemptEvents,
  azureModel,
  completedSseResponse,
  configureTransportObserver,
  context,
  openAIModel,
  resetOpenAITransportAccountingTestState,
  stalledSseResponse,
  submissionEvents,
  truncatedSseResponse,
  waitForRequestAbort,
} from "./openai-provider-transport-accounting.test-support.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI Responses SDK transport accounting", () => {
  it("records SDK retries from physical fetches, not retry headers", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        }),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(
        { ...openAIModel, headers: { "X-Stainless-Retry-Count": "99" } },
        context,
        { apiKey: "test-key", maxRetries: 1, requestId: "call-sdk-retry" },
      ),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
      { ordinal: 2, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
  });

  it("emits one zero-submission fact after terminal SDK preflight failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async () => {
        throw new Error("blocked before provider egress");
      },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-preflight",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-preflight",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("records a hostless synchronous fetch throw before submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch invocation failed");
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-sync-fetch-throw",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-sync-fetch-throw",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("keeps the first actual dispatch initial after a synchronous fetch retry", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        throw new Error("fetch invocation failed");
      })
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => fetchImpl);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-sync-fetch-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts a rejected SDK fetch promise as one failed dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network request rejected"));
    configureTransportObserver(events, () => fetchImpl);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-fetch-rejection",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("keeps the first dispatched SDK request initial after a preflight-only retry", async () => {
    const events: AiModelTransportEvent[] = [];
    let guardedFetchCalls = 0;
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch:
        (_model: Model, _timeoutMs?: number, options?: { onFetchDispatch?: () => void }) =>
        async () => {
          guardedFetchCalls += 1;
          if (guardedFetchCalls === 1) {
            throw new TypeError("blocked before provider dispatch");
          }
          options?.onFetchDispatch?.();
          return completedSseResponse();
        },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-preflight-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetchCalls).toBe(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("records encrypted-content recovery as a distinct submission reason", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "invalid encrypted content",
              type: "invalid_request_error",
              code: "invalid_encrypted_content",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-recovery",
        onPayload: (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          return {
            ...request,
            input: [
              ...((request.input as unknown[]) ?? []),
              { type: "reasoning", encrypted_content: "secret-ciphertext", summary: [] },
            ],
          };
        },
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(
      attemptEvents(events).map(({ reason, outcome, statusCode }) => ({
        reason,
        outcome,
        statusCode,
      })),
    ).toEqual([
      { reason: "initial", outcome: "failed", statusCode: 400 },
      { reason: "payload_recovery", outcome: "completed", statusCode: 200 },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-ciphertext");
  });

  it("emits zero submission when payload-recovery prompt observation fails", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "invalid encrypted content",
            type: "invalid_request_error",
            code: "invalid_encrypted_content",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    configureTransportObserver(events, () => guardedFetch);
    const options = {
      apiKey: "test-key",
      maxRetries: 0,
      requestId: "call-sdk-recovery-observer",
      onPayload: (payload: unknown) => {
        const request = payload as Record<string, unknown>;
        return {
          ...request,
          input: [
            ...((request.input as unknown[]) ?? []),
            { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
          ],
        };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      if (observation.payloadVariant === "encrypted-content-retry") {
        throw new Error("prompt observer failed");
      }
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, options),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(guardedFetch).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 400 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "failed", total: 0 },
    ]);
  });

  it("keeps successful SDK headers pending until truncated stream failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => truncatedSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-truncated",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { reason: "initial", outcome: "failed", statusCode: 200 },
    ]);
  });

  it("distinguishes SDK caller abort from internal request timeout", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () =>
      vi.fn((_input, init) => {
        queueMicrotask(() => controller.abort());
        return waitForRequestAbort(init);
      }),
    );
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-abort",
        signal: controller.signal,
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () =>
      vi.fn((_input, init) => waitForRequestAbort(init)),
    );
    const timedOut = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-timeout",
        timeoutMs: 1,
      }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
  });

  it("settles SDK post-header abort and first-event timeout at stream terminal", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () => vi.fn(async () => completedSseResponse()));
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-post-header-abort",
        signal: controller.signal,
        onResponse: () => controller.abort(),
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () => vi.fn(async () => stalledSseResponse()));
    const streamFn = createOpenAIResponsesTransportStreamFn();
    const timedOut = await Promise.resolve(
      streamFn(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-first-event-timeout",
        firstEventTimeoutMs: 1,
      } as Parameters<typeof streamFn>[2] & { firstEventTimeoutMs: number }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("treats post-header AbortError without caller cancellation as failed", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => abortErroredSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-upstream-abort-error",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("uses the shared SDK accounting path for Azure Responses", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-sdk",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        callId: "call-azure-sdk",
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        reason: "initial",
        outcome: "completed",
      },
    ]);
  });

  it("uses the shared SDK accounting path for traditional AzureOpenAI URLs", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));
    const traditionalAzure = {
      ...azureModel,
      baseUrl: "https://resource.openai.azure.com",
    } satisfies Model<"azure-openai-responses">;

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(traditionalAzure, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-traditional",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-azure-traditional", reason: "initial", outcome: "completed" },
    ]);
  });

  it("emits Azure zero submission when client fetch setup throws", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => {
        throw new Error("azure client fetch setup failed");
      },
    });

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-setup-failure",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-azure-setup-failure",
        transport: "responses-sdk",
        outcome: "failed",
      },
    ]);
  });
});
