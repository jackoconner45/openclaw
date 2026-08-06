import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  type AiModelTransportEvent,
  type AiTransportHost,
} from "../host.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  apiKey?: string;
};

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(overrides: Partial<Model<"anthropic-messages">>) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

function serializeSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function runTerminalCompletenessCase(params: {
  endpointClass: "anthropic-public" | "custom";
  events: Record<string, unknown>[];
  provider?: string;
}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(serializeSse(params.events));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const model = makeModel({
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: params.provider ?? "anthropic",
  });
  configureAiTransportHost({
    buildModelFetch: () => globalThis.fetch,
    resolveProviderEndpointClass: () => params.endpointClass,
  });

  try {
    return await streamAnthropic(model, context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
    }).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  configureAiTransportHost({});
});

describe("Anthropic SDK host fetch wiring", () => {
  it("routes every non-Cloudflare client branch through the host fetch", async () => {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "test rejection" },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hostFetch = vi.fn<typeof fetch>((input, init) => globalThis.fetch(input, init));
    const buildModelFetch = vi.fn(() => hostFetch);
    configureAiTransportHost({ buildModelFetch });

    const cases = [
      {
        model: makeModel({ provider: "github-copilot", baseUrl }),
        apiKey: "copilot-token",
      },
      {
        model: makeModel({ provider: "microsoft-foundry", baseUrl, authHeader: true }),
        apiKey: "foundry-token",
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-oat01-oauth-token", // pragma: allowlist secret
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        model: makeModel({ provider: "kimi-coding", baseUrl }),
        apiKey: "kimi-api-key",
        thinkingEnabled: true,
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await streamAnthropic(testCase.model, context, {
          apiKey: testCase.apiKey,
          maxRetries: 0,
          thinkingEnabled: testCase.thinkingEnabled,
        }).result();
        expect(result.stopReason).toBe("error");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(hostFetch).toHaveBeenCalledTimes(cases.length);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer copilot-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer foundry-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer sk-ant-oat01-oauth-token", // pragma: allowlist secret
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "kimi-api-key",
      },
    ]);
    expect(buildModelFetch).toHaveBeenLastCalledWith(cases.at(-1)?.model, undefined, {
      sanitizeSse: false,
    });
  });

  it("counts each SDK retry at guarded fetch dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after-ms": "0",
        });
        response.end(JSON.stringify({ error: { message: "retry" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_retry",
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    const buildModelFetch: AiTransportHost["buildModelFetch"] = (_model, _timeout, options) => {
      return async (input, init) => {
        options?.onFetchDispatch?.();
        return await globalThis.fetch(input, init);
      };
    };
    configureAiTransportHost({
      buildModelFetch,
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 1,
        requestId: "call-sdk-retry",
      }).result();
      expect(result.stopReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      }),
    ]);
  });

  it("records zero submission when owned SDK preflight fails before dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options) => async (input, init) => {
        options?.onFetchDispatch?.();
        return await hostFetch(input, init);
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-preflight",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "submission",
        callId: "call-sdk-preflight",
        total: 0,
        outcome: "failed",
      }),
    ]);
  });

  it("counts a synchronous owned SDK fetch throw as a failed dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>(() => {
      throw new Error("fetch invocation failed");
    });
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options) => (input, init) => {
        options?.onFetchDispatch?.();
        return hostFetch(input, init);
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      requestId: "call-sdk-sync-fetch-throw",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-sync-fetch-throw",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      }),
    ]);
  });

  it("records a failed owned SDK attempt when EOF arrives before message_stop", async () => {
    const events: AiModelTransportEvent[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_incomplete",
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options) => async (input, init) => {
        options?.onFetchDispatch?.();
        return await globalThis.fetch(input, init);
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-incomplete",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("ended before message_stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-incomplete",
        outcome: "failed",
        statusCode: 200,
      }),
    ]);
  });

  it.each([
    {
      label: "rejects direct EOF after a mapped stop reason",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects official-endpoint EOF through a provider alias",
      endpointClass: "anthropic-public" as const,
      provider: "provider-alias",
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible EOF after a mapped stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "stop",
    },
    {
      label: "rejects compatible partial EOF without a stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts direct message_stop",
      endpointClass: "anthropic-public" as const,
      events: [{ type: "message_stop" }],
      expectedStopReason: "stop",
    },
  ])("$label", async ({ endpointClass, events, expectedStopReason, provider }) => {
    const result = await runTerminalCompletenessCase({ endpointClass, events, provider });

    expect(result.stopReason).toBe(expectedStopReason);
    if (expectedStopReason === "error") {
      expect(result.errorMessage).toContain("ended before message_stop");
    }
  });

  it("records owned SDK no-boundary fallback as one attempt and one transition", async () => {
    const events: AiModelTransportEvent[] = [];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_fallback",
              model: "claude-opus-5",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              iterations: [
                {
                  type: "fallback_message",
                  model: "claude-opus-5",
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_creation: null,
                },
              ],
            },
          },
          { type: "message_stop" },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const loopbackUrl = `http://127.0.0.1:${address.port}/v1/messages`;
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options) => async (_input, init) => {
        options?.onFetchDispatch?.();
        return await globalThis.fetch(loopbackUrl, init);
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(
        makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
        context,
        {
          apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
          maxRetries: 0,
          requestId: "call-sdk-fallback",
        },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(result.responseModel).toBe("claude-opus-5");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(requestCount).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        callId: "call-sdk-fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-fallback",
        ordinal: 1,
        outcome: "completed",
        statusCode: 200,
      }),
    ]);
  });
});
