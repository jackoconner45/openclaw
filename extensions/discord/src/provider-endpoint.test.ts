// Discord tests cover private provider endpoint ownership and request boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, releaseMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));
vi.mock("openclaw/plugin-sdk/runtime-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-store")>()),
  assertBundledPluginRuntimeCapability: vi.fn(),
}));

import { assertBundledPluginRuntimeCapability } from "openclaw/plugin-sdk/runtime-store";
import { setDiscordProviderEndpointDescriptor } from "../api.js";
import { RequestClient } from "./internal/rest.js";
import {
  DISCORD_DEFAULT_REST_API_BASE_URL,
  getDiscordProviderEndpointRuntime,
  resolveDiscordProviderAttachmentUploadGuard,
  resolveDiscordProviderMediaDownloadGuard,
} from "./provider-endpoint.js";

const TEST_PLUGIN_RUNTIME = {} as Parameters<typeof setDiscordProviderEndpointDescriptor>[0];
const REPLACEMENT_PLUGIN_RUNTIME = {} as Parameters<typeof setDiscordProviderEndpointDescriptor>[0];

const TEST_DESCRIPTOR = {
  restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10/",
  gatewayBotUrl: "http://127.0.0.1:43123/custom/gateway-metadata",
  gatewayOrigin: "ws://127.0.0.1:43124",
} as const;

describe("Discord provider endpoint runtime", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    releaseMock.mockClear();
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, undefined);
  });

  afterEach(() => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, undefined);
  });

  it("is absent by default and preserves the live REST base", () => {
    expect(getDiscordProviderEndpointRuntime()).toBeUndefined();
    expect(DISCORD_DEFAULT_REST_API_BASE_URL).toBe("https://discord.com/api/v10");
  });

  it("stores three independent normalized anchors and clears explicitly", () => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);

    expect(assertBundledPluginRuntimeCapability).toHaveBeenLastCalledWith(
      TEST_PLUGIN_RUNTIME,
      "discord.provider-endpoint",
    );

    expect(getDiscordProviderEndpointRuntime()?.descriptor).toEqual({
      restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10",
      gatewayBotUrl: TEST_DESCRIPTOR.gatewayBotUrl,
      gatewayOrigin: TEST_DESCRIPTOR.gatewayOrigin,
    });

    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, undefined);
    expect(getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("does not let stale runtime cleanup clear a replacement descriptor", () => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);
    const replacementDescriptor = {
      ...TEST_DESCRIPTOR,
      restApiBaseUrl: "http://127.0.0.1:43125/replacement/rest/v10",
    };
    setDiscordProviderEndpointDescriptor(REPLACEMENT_PLUGIN_RUNTIME, replacementDescriptor);

    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, undefined);
    expect(getDiscordProviderEndpointRuntime()?.descriptor.restApiBaseUrl).toBe(
      replacementDescriptor.restApiBaseUrl,
    );

    setDiscordProviderEndpointDescriptor(REPLACEMENT_PLUGIN_RUNTIME, undefined);
    expect(getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("rejects insecure non-loopback anchors without adding a config fallback", () => {
    expect(() =>
      setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, {
        ...TEST_DESCRIPTOR,
        restApiBaseUrl: "http://provider.example/custom/rest/v10",
      }),
    ).toThrow(/HTTPS or loopback HTTP/);
    expect(() =>
      setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, {
        ...TEST_DESCRIPTOR,
        gatewayOrigin: "ws://provider.example",
      }),
    ).toThrow(/WSS or loopback WS/);
  });

  it("routes REST clients through the exact configured base", async () => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);
    const ignoredFetch = vi.fn();
    const client = new RequestClient("test-token", {
      fetch: ignoredFetch,
      queueRequests: false,
    });

    await expect(
      client.post("/channels/123/messages", { body: { content: "hello" } }),
    ).resolves.toEqual({ ok: true });

    expect(ignoredFetch).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.url).toBe("http://127.0.0.1:43123/custom/rest/v10/channels/123/messages");
    expect(guarded.maxRedirects).toBe(0);
    expect(guarded.requireHttps).toBe(false);
    expect(guarded.policy).toEqual({
      allowedOrigins: ["http://127.0.0.1:43123"],
    });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("preserves Request method, headers, body, signal, and duplex", async () => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);
    const runtime = getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }
    const controller = new AbortController();
    const request = new Request(`${TEST_DESCRIPTOR.restApiBaseUrl}messages`, {
      method: "POST",
      headers: { "x-provider-test": "present" },
      body: "streamed body",
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await runtime.fetch(request);

    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.init.method).toBe("POST");
    expect(new Headers(guarded.init.headers).get("x-provider-test")).toBe("present");
    expect(guarded.init.duplex).toBe("half");
    expect(guarded.init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(guarded.init.body).text()).toBe("streamed body");
    expect(guarded.signal).toBe(guarded.init.signal);
    expect(guarded.signal.aborted).toBe(false);
    controller.abort();
    expect(guarded.signal.aborted).toBe(true);
  });

  it("rejects requests outside both explicit HTTP anchors", async () => {
    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);
    const runtime = getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }

    await expect(runtime.fetch("http://127.0.0.1:43123/not-the-provider")).rejects.toThrow(
      /outside the configured endpoint boundaries/,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows provider attachment uploads only on the configured REST origin", () => {
    expect(
      resolveDiscordProviderAttachmentUploadGuard("https://cdn.discord.test/upload"),
    ).toBeUndefined();

    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);

    expect(
      resolveDiscordProviderAttachmentUploadGuard(
        "http://127.0.0.1:43123/upload/voice.ogg?signature=test",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: { allowedOrigins: ["http://127.0.0.1:43123"] },
      requireHttps: false,
    });
    for (const uploadUrl of [
      "http://127.0.0.1:43124/upload",
      "https://127.0.0.1:43123/upload",
      "http://user@127.0.0.1:43123/upload",
      "http://127.0.0.1:43123/upload#fragment",
    ]) {
      expect(() => resolveDiscordProviderAttachmentUploadGuard(uploadUrl)).toThrow();
    }
  });

  it("allows inbound media only at the provider REST origin without redirects", () => {
    expect(
      resolveDiscordProviderMediaDownloadGuard("https://cdn.discordapp.com/attachment.png"),
    ).toBeUndefined();

    setDiscordProviderEndpointDescriptor(TEST_PLUGIN_RUNTIME, TEST_DESCRIPTOR);

    expect(
      resolveDiscordProviderMediaDownloadGuard(
        "http://127.0.0.1:43123/custom/media/attachment.png",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: {
        allowedOrigins: ["http://127.0.0.1:43123"],
        hostnameAllowlist: ["127.0.0.1"],
      },
    });
    expect(
      resolveDiscordProviderMediaDownloadGuard("https://cdn.discordapp.com/attachment.png"),
    ).toBeUndefined();
  });
});
