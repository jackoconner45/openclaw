import { vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../providers/openai-chatgpt-responses.js";
import type { Context, Model } from "../types.js";

const initialHost = getAiTransportHost();

export const openAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

export const azureModel = {
  ...openAIModel,
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://resource.openai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

export const chatGptModel = {
  ...openAIModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
} satisfies Model<"openai-chatgpt-responses">;

export const context = {
  systemPrompt: "private prompt that must never enter transport accounting",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
} satisfies Context;

export function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

export function completedSseEvent(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

export function completedSseResponse(responseId = "resp_transport_accounting"): Response {
  return new Response(`data: ${JSON.stringify(completedSseEvent(responseId))}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function truncatedSseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_truncated",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function stalledSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function abortErroredSseResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("upstream reset", "AbortError"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function waitForRequestAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("expected request signal"));
      return;
    }
    const rejectAbort = () => reject(new DOMException("request aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

export function configureTransportObserver(
  events: AiModelTransportEvent[],
  buildNetworkFetch?: () => typeof fetch,
): void {
  configureAiTransportHost({
    ...initialHost,
    ...(buildNetworkFetch
      ? {
          buildModelFetch: (
            _model: Model,
            _timeoutMs?: number,
            options?: { onFetchDispatch?: () => void },
          ) => {
            const networkFetch = buildNetworkFetch();
            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const dispatched = networkFetch(input, init);
              options?.onFetchDispatch?.();
              return await dispatched;
            };
          },
        }
      : {}),
    observeModelTransportEvent: (event: AiModelTransportEvent) => events.push(event),
  });
}

export function attemptEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "attempt" }> =>
      event.type === "attempt",
  );
}

export function connectionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "connection" }> =>
      event.type === "connection",
  );
}

export function fallbackEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "fallback" }> =>
      event.type === "fallback",
  );
}

export function submissionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "submission" }> =>
      event.type === "submission",
  );
}

export function resetOpenAITransportAccountingTestState(): void {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
