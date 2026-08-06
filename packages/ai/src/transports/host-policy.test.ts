import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { AiTransportDispatchGuardUnavailableError, buildGuardedModelFetch } from "./host-policy.js";

const initialHost = getAiTransportHost();
const model: Model<"openai-responses"> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

afterEach(() => {
  vi.unstubAllGlobals();
  configureAiTransportHost(initialHost);
});

describe("model fetch dispatch guards", () => {
  it("fails closed when the host cannot install a blocking guard", () => {
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    expect(() =>
      buildGuardedModelFetch(model, undefined, {
        beforeFetchDispatch: vi.fn(),
      }),
    ).toThrow(AiTransportDispatchGuardUnavailableError);
  });

  it("keeps observational dispatch accounting isolated in the fallback", async () => {
    const onFetchDispatch = vi.fn(() => {
      throw new Error("observer failure");
    });
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });
    const response = await guardedFetch("https://api.openai.com/v1/responses");

    expect(response.status).toBe(200);
    expect(onFetchDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
