import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { buildGuardedModelFetch } from "./host-policy.js";

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

describe("hostless model fetch dispatch accounting", () => {
  it("records after fetch invocation and isolates observer failures", async () => {
    const order: string[] = [];
    const onFetchDispatch = vi.fn(() => {
      order.push("observe");
      throw new Error("observer failure");
    });
    const fetchMock = vi.fn(() => {
      order.push("fetch");
      return Promise.resolve(new Response("ok"));
    });
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });
    const response = await guardedFetch("https://api.openai.com/v1/responses");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).toHaveBeenCalledOnce();
    expect(order).toEqual(["fetch", "observe"]);
  });

  it("does not record a dispatch when fetch throws before submission", async () => {
    const failure = new Error("fetch invocation failed");
    const onFetchDispatch = vi.fn();
    const fetchMock = vi.fn(() => {
      throw failure;
    });
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });

    await expect(guardedFetch("https://api.openai.com/v1/responses")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).not.toHaveBeenCalled();
  });

  it("records a dispatch when fetch returns a rejected promise", async () => {
    const failure = new Error("remote fetch failed");
    const onFetchDispatch = vi.fn();
    const fetchMock = vi.fn(() => Promise.reject(failure));
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });

    await expect(guardedFetch("https://api.openai.com/v1/responses")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).toHaveBeenCalledOnce();
  });
});
